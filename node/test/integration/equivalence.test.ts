/**
 * Task 2.17: the equivalence suite of Task 1.17 (spec §12.1), driven THROUGH THE PROXY against
 * a real Part 1+2 backend: G3 (an OAuth token and an API key behave identically) and R-MCP-5
 * (API-key mode binds, guards and pays exactly like OAuth mode).
 *
 * One agent holds two credentials:
 * - mode A: an API key minted for it (`POST /agents/:id/credentials`), given to the proxy as
 *   `ASSAY_DEV_API_KEY` (dev mode on the e2e entry);
 * - mode B: an OAuth grant of the built-in `assay-mcp` client on the same agent, obtained through
 *   the proxy's own F1 sign-in; the consent step uses the stack's human session.
 * Every case runs one proxy process per mode (the real `serve`, forked from the source with a
 * keyring file and a temporary profile directory; never the OS keychain or the real profile),
 * drives it with the MCP SDK client, and compares the JSON-RPC results after normalisation:
 * each mode's own credential id and delegate key, fresh ids (UUIDs), timestamps, signatures and
 * `seq`/expiry numbers become placeholders. Every `_meta` key is compared, and so is every
 * other value; a served tool's output (live upstream data) is compared by its shape.
 *
 * Shared agent state: both credentials are the same agent, so its free quota, free budget and
 * rate limits are shared. Steps run A then B, back to back. When B is refused with a limit code
 * that A was not (the limit fell between them), A runs once more and must then equal B.
 *
 * Cases (the §12.1 table, as far as an MCP client sees it):
 * - URL kinds: `tools/list` on `/`, `/c/{cat}`, `/@{h}`, `/@{h}/{slug}`, `/@{h}/{slug}@1`,
 *   `/u/{token}`, `/u/{token}@1`, `/my/{slug}`, `/my/{slug}@1`, each with no query and with
 *   `tools`, `category`, `free=1` and `discovery=full`. The toolsets, the handle and the link
 *   are created here through the API with the human session.
 * - Methods on every kind and on `/?free=1`: `tools/list`; `tools/call` free and freemium (in
 *   quota and over it), paid step 1 (both modes not enabled: the proxy binds its own key and
 *   answers the enable-paid text); `search_tools`, `get_tool`, `call_tool` free.
 * - API host: `GET /agents/me/delegate` for both, before and after the binding.
 * - Paid path (needs an anvil fork, see below): bind, approve on the fork, sign, receipt; for
 *   `tools/call` and `call_tool`.
 * - Revoke: both credentials revoked; the next request is refused for both.
 *
 * Gating: a plain `npm test` makes no network request and skips everything here.
 *   ASSAY_MCP_E2E=1                    enable (same switch as oauth-e2e.test.ts)
 *   ASSAY_MCP_E2E_HUMAN_TOKEN=<token>  a person's session on the backend (the e2e stack's config
 *                                      buyer token): consent, the API key, the toolsets
 *   ASSAY_MCP_E2E_REROUTE=<json>       optional: {"http://localhost:3200": "http://127.0.0.1:N", …}
 *                                      when the backend listens on other ports
 *   ASSAY_MCP_E2E_CATEGORY=<category>  optional: the `/c/{cat}` category (default `weather`)
 *   ASSAY_MCP_E2E_HANDLE=<handle>      optional: a provider's handle for `/@{h}` (default: the
 *                                      human's own, which serves nothing without provider tools)
 *   ASSAY_MCP_E2E_EXPECT_SERVED=1      CI: require a routable free tool (a seeded backend)
 *   ASSAY_MCP_E2E_VERBOSE=1            print what each compared step amounted to
 * The paid path also needs an anvil fork of eip155:46630 that the backend reads too, and skips
 * without one (the pattern of chain-reads.test.ts):
 *   ASSAY_ANVIL_FORK=1                 the fork is up
 *   ASSAY_ANVIL_RPC=<url>              default http://127.0.0.1:8547
 * Approval on the fork is the payer's own `authorizeDelegate` call, sent as the payer with
 * `anvil_impersonateAccount` (a fork-only door: no key, no relayer, nothing on a real network).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { builtInDeployments, parseCaip10 } from "../../src/deployments.js";
import { signIn } from "../../src/oauth/flow.js";
import { currentAccess } from "../../src/oauth/tokens.js";
import { resolveDeployment, type ResolvedDeployment } from "../../src/profile/deployments.js";
import { addDevOrigin } from "../../src/profile/dev-origins.js";
import { Keychain } from "../../src/profile/keychain.js";
import { withLock } from "../../src/profile/lock.js";
import { addPaidUrl, readProfile } from "../../src/profile/profile.js";
import { bundleFixture } from "../helpers/bundle.js";
import { FileKeyring } from "../helpers/file-keyring.js";

const env = process.env;
const enabled = env.ASSAY_MCP_E2E === "1" && (env.ASSAY_MCP_E2E_HUMAN_TOKEN ?? "") !== "";
const humanToken = env.ASSAY_MCP_E2E_HUMAN_TOKEN ?? "";
const REROUTE = JSON.parse(env.ASSAY_MCP_E2E_REROUTE ?? "{}") as Record<string, string>;
const CATEGORY = env.ASSAY_MCP_E2E_CATEGORY ?? "weather";
/** A handle whose organization lists provider tools, so `/@{h}` serves (the CI seed's provider). */
const SERVING_HANDLE = env.ASSAY_MCP_E2E_HANDLE ?? null;
const ANVIL_RPC = env.ASSAY_ANVIL_RPC ?? "http://127.0.0.1:8547";
const paidEnabled = enabled && env.ASSAY_ANVIL_FORK === "1";

const E2E = builtInDeployments().e2e;
const MCP = E2E.mcp;
const NET_ID = "eip155:46630";
const ESCROW = parseCaip10(E2E.networks[NET_ID]!.escrow)!;
const RPC_ORIGINS = E2E.networks[NET_ID]!.rpc.map((r) => new URL(r).origin);

type Mode = "A" | "B";
const MODES: readonly Mode[] = ["A", "B"];
type Json = Record<string, unknown>;

/** The nine URL kinds of spec §7.4, in the order of §12.1. */
const KINDS = ["root", "category", "handle", "publicToolset", "publicToolsetPinned", "unlisted", "unlistedPinned", "myToolset", "myToolsetPinned"] as const;
type Kind = (typeof KINDS)[number];

// ---- the world ------------------------------------------------------------------------------

interface ModeWorld {
  readonly mode: Mode;
  readonly dir: string;
  readonly keyringFile: string;
  readonly browserLog: string;
  readonly credentialId: string;
  /** Mode A: the API key. */
  readonly apiKey: string | null;
}

let fixture: { dir: string; file: string };
let deployment: ResolvedDeployment;
let root: string;
let agentId: string;
const worlds = {} as Record<Mode, ModeWorld>;
const urls = {} as Record<Kind, string>;
const toolsetIds: string[] = [];
const realFetch = globalThis.fetch;
/** How many steps needed A once more because a shared limit fell between A and B. */
let boundaryReruns = 0;
/** What each compared step amounted to (printed with ASSAY_MCP_E2E_VERBOSE=1). */
const outcomes: string[] = [];

/** The test process's own requests go through the same reroute as the children's. */
function reroutedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = new URL(input instanceof Request ? input.url : String(input instanceof URL ? input.href : input));
  const target = REROUTE[u.origin];
  return target === undefined ? realFetch(input, init) : realFetch(`${target}${u.pathname}${u.search}`, init);
}

async function api(method: string, path: string, bearer: string, body?: unknown): Promise<{ status: number; body: Json; headers: Headers }> {
  const res = await reroutedFetch(`${E2E.api}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Json;
  try {
    parsed = text ? (JSON.parse(text) as Json) : {};
  } catch {
    parsed = { text };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** The API envelope's `data`, or the body itself. */
const dataOf = <T>(body: Json): T => ("data" in body ? body.data : body) as T;

function newModeDir(mode: Mode): Pick<ModeWorld, "dir" | "keyringFile" | "browserLog"> {
  const dir = mkdtempSync(join(root, `mode-${mode}-`));
  addDevOrigin(dir, MCP);
  const browserLog = join(dir, "..", `${mode}-browser.log`);
  writeFileSync(browserLog, "");
  return { dir, keyringFile: join(dir, "..", `${mode}-keyring.json`), browserLog };
}

/** Mode B: the proxy's own F1 sign-in; consent approved for the first active agent. */
async function signInModeB(): Promise<ModeWorld> {
  const paths = newModeDir("B");
  const keychain = new Keychain(new FileKeyring(paths.keyringFile), { profile: "default", environment: deployment.environment });
  const consent = async (authorizeUrl: string): Promise<boolean> => {
    const start = await reroutedFetch(authorizeUrl, { redirect: "manual" });
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
    const rid = new URL(start.headers.get("location")!).hash.replace(/^#request=/, "");
    const read = await api("GET", `/oauth/requests/${rid}`, humanToken);
    if (read.status !== 200) throw new Error(`reading the consent request: ${read.status} ${JSON.stringify(read.body)}`);
    const agent = dataOf<{ agents: { id: string; active: boolean }[] }>(read.body).agents.find((a) => a.active);
    if (!agent) throw new Error("the human session has no active agent");
    agentId = agent.id;
    const approved = await api("POST", `/oauth/requests/${rid}/approve`, humanToken, { agentId: agent.id, name: "assay-mcp equivalence" });
    if (approved.status !== 200 && approved.status !== 201) throw new Error(`approving the consent request: ${approved.status} ${JSON.stringify(approved.body)}`);
    const cont = await reroutedFetch(dataOf<{ redirectTo: string }>(approved.body).redirectTo, { redirect: "manual", headers: { cookie } });
    await realFetch(cont.headers.get("location")!); // the loopback callback (127.0.0.1)
    return true;
  };
  const profile = { dir: paths.dir, name: "default" };
  const { credentialId } = await signIn(profile, deployment, { device: "equivalence" }, { keychain, openBrowser: consent });
  if (credentialId === null) throw new Error("sign-in did not read the credential back");
  return { mode: "B", ...paths, credentialId, apiKey: null };
}

/** Mode A: an API key on the same agent, through the credentials screen's API. */
async function mintModeA(): Promise<ModeWorld> {
  const paths = newModeDir("A");
  const created = await api("POST", `/agents/${agentId}/credentials`, humanToken, { name: "assay-mcp equivalence" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const key = dataOf<{ id: string; token: string }>(created.body);
  // What `add` leaves for a first-time API-key user: paid calls allowed on `/`.
  await withLock({ dir: paths.dir, name: "default" }, (lock) => addPaidUrl({ dir: paths.dir, name: "default" }, lock, "/"));
  return { mode: "A", ...paths, credentialId: key.id, apiKey: key.token };
}

/** Mode B's current access token (for the API host cases). */
async function bearerOf(world: ModeWorld): Promise<string> {
  if (world.apiKey !== null) return world.apiKey;
  const keychain = new Keychain(new FileKeyring(world.keyringFile), { profile: "default", environment: deployment.environment });
  const token = await currentAccess({ profile: { dir: world.dir, name: "default" }, deployment, keychain });
  if (token === null) throw new Error("mode B has no access token");
  return token;
}

const pathOf = (url: string | null | undefined): string | null => (url ? new URL(url).pathname + new URL(url).search : null);

/** The URL kinds' fixtures, created with the human session: a handle, three toolsets. */
async function createUrlKinds(toolIds: string[]): Promise<void> {
  urls.root = "/";
  urls.category = `/c/${CATEGORY}`;
  const handle = dataOf<{ handle: string | null }>((await api("GET", "/org/handle", humanToken)).body).handle;
  if (handle === null) {
    const claimed = await api("PUT", "/org/handle", humanToken, { handle: `eq${Date.now().toString(36)}` });
    expect(claimed.status, `claiming a handle: ${JSON.stringify(claimed.body)}`).toBe(200);
  }
  const suffix = Date.now().toString(36);
  const toolset = async (slug: string, visibility: "PRIVATE" | "PUBLIC" | "UNLISTED") => {
    const created = await api("POST", "/toolsets", humanToken, { name: `Equivalence ${slug}`, slug, entries: toolIds.map((toolId) => ({ toolId })) });
    expect(created.status, `creating ${slug}: ${JSON.stringify(created.body)}`).toBe(201);
    const id = dataOf<{ id: string }>(created.body).id;
    toolsetIds.push(id);
    const published = await api("POST", `/toolsets/${id}/publish`, humanToken, { visibility });
    expect(published.status, `publishing ${slug} ${visibility}: ${JSON.stringify(published.body)}`).toBe(200);
    return dataOf<{ toolset: { handle: string | null; urls: Record<string, string | null> } }>(published.body).toolset;
  };
  const mine = await toolset(`eq-my-${suffix}`, "PRIVATE");
  urls.myToolset = pathOf(mine.urls.draft)!;
  urls.myToolsetPinned = pathOf(mine.urls.myPinned)!;
  const pub = await toolset(`eq-pub-${suffix}`, "PUBLIC");
  urls.publicToolset = pathOf(pub.urls.public)!;
  urls.publicToolsetPinned = pathOf(pub.urls.publicPinned)!;
  urls.handle = `/@${SERVING_HANDLE ?? pub.handle}`;
  const link = await toolset(`eq-link-${suffix}`, "UNLISTED");
  urls.unlisted = pathOf(link.urls.unlisted)!;
  urls.unlistedPinned = pathOf(link.urls.unlistedPinned)!;
  for (const kind of KINDS) expect(urls[kind], `URL kind ${kind}`).toMatch(/^\//);
}

// ---- the proxies ----------------------------------------------------------------------------

interface Proxy {
  readonly client: Client;
  readonly stderr: () => string;
  close(): Promise<void>;
}

async function proxy(world: ModeWorld, path: string): Promise<Proxy> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture.file, "--url", `${MCP}${path}`],
    env: {
      ASSAY_MCP_DEV_ORIGINS: MCP,
      TEST_DIR: world.dir,
      TEST_KEYRING: world.keyringFile,
      TEST_BROWSER_LOG: world.browserLog,
      TEST_POLL_MS: "500",
      TEST_REROUTE: JSON.stringify({ ...REROUTE, ...(paidEnabled ? Object.fromEntries(RPC_ORIGINS.map((o) => [o, ANVIL_RPC])) : {}) }),
      ...(world.apiKey !== null ? { ASSAY_DEV_API_KEY: world.apiKey } : {}),
    },
    stderr: "pipe",
  });
  const err: string[] = [];
  transport.stderr?.on("data", (c: Buffer) => err.push(c.toString("utf8")));
  const client = new Client({ name: "equivalence-host", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => err.join(""), close: () => client.close() };
}

/** One proxy per mode on `path`, closed after `run`. */
async function onBoth<T>(path: string, run: (p: Record<Mode, Proxy>) => Promise<T>): Promise<T> {
  const p = { A: await proxy(worlds.A, path), B: await proxy(worlds.B, path) };
  try {
    return await run(p);
  } finally {
    await Promise.all([p.A.close(), p.B.close()]);
  }
}

// ---- normalisation and comparison ------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const SIGNATURE_RE = /0x[0-9a-fA-F]{130}/g;
/** Values that differ per call by design: sequence numbers, times, measured latencies. */
const VOLATILE_KEYS = new Set(["seq", "issuedAt", "expiresAt", "validUntil", "nonce", "latencyMs", "p95LatencyMs", "durationMs", "retryAfterMs", "boundAt"]);

/** Per mode: its own credential id and delegate key (and that key's fingerprint) → placeholders. */
const ownValues: Record<Mode, [string, string][]> = { A: [], B: [] };

function addOwnDelegate(mode: Mode, address: string): void {
  const fp = `${address.slice(-8, -4).toUpperCase()} ${address.slice(-4).toUpperCase()}`;
  ownValues[mode].push([address.toLowerCase(), "<delegate>"], [fp, "<fingerprint>"]);
}

function normaliseString(s: string, mode: Mode): string {
  let out = s;
  for (const [value, placeholder] of ownValues[mode]) out = out.split(value).join(placeholder);
  // Addresses compare case-insensitively (checksummed or not).
  for (const [value, placeholder] of ownValues[mode]) {
    if (/^0x[0-9a-f]{40}$/.test(value)) out = out.replace(new RegExp(value, "gi"), placeholder);
  }
  return out.replace(SIGNATURE_RE, "<signature>").replace(UUID_RE, "<uuid>").replace(ISO_RE, "<time>");
}

function normalise(value: unknown, mode: Mode, key?: string): unknown {
  if (key !== undefined && VOLATILE_KEYS.has(key) && value !== null && (typeof value === "number" || typeof value === "string")) return `<${key}>`;
  if (typeof value === "string") return normaliseString(value, mode);
  if (Array.isArray(value)) return value.map((v) => normalise(v, mode));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, normalise(v, mode, k)]));
  }
  return value;
}

/** A served tool's output is live upstream data: kept as its shape (keys and value types). */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, shape(v)]));
  return value === null ? null : `<${typeof value}>`;
}

const errorCodeOf = (result: Json): string | null => ((result._meta as Json | undefined)?.["assay/error"] as Json | undefined)?.code as string | null ?? null;

function servedOutputAsShape(result: Json): Json {
  if (result.isError === true || errorCodeOf(result) !== null) return result;
  const content = Array.isArray(result.content)
    ? (result.content as Json[]).map((c) => {
        if (typeof c.text !== "string") return c;
        try {
          return { ...c, text: shape(JSON.parse(c.text)) };
        } catch {
          return { ...c, text: "<text>" };
        }
      })
    : result.content;
  return { ...result, content, ...(result.structuredContent !== undefined ? { structuredContent: shape(result.structuredContent) } : {}) };
}

/** What an MCP client sees: the result, or the JSON-RPC error's code and message. */
async function observe(run: () => Promise<unknown>): Promise<Json> {
  try {
    return { result: (await run()) as Json };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    return { error: { code: e.code ?? null, message: String(e.message ?? err) } };
  }
}

const LIMIT_CODE_RE = /^(FREE_|RATE_LIMITED|MCP_FREE)/;
const outcomeCode = (seen: Json): string | null => (seen.result ? errorCodeOf(seen.result as Json) : null);

/**
 * Runs `step` in mode A then mode B and compares the normalised views. When only B was refused
 * with a limit code (the shared limit fell between the two), A runs once more and must equal B.
 */
async function equal(name: string, step: (mode: Mode) => Promise<Json>, view: (seen: Json) => Json = (s) => s): Promise<Json> {
  let a = await step("A");
  const b = await step("B");
  const norm = (seen: Json, mode: Mode) => normalise(view(seen), mode) as Json;
  let na = norm(a, "A");
  const nb = norm(b, "B");
  const codeA = outcomeCode(a);
  const codeB = outcomeCode(b);
  if (JSON.stringify(na) !== JSON.stringify(nb) && codeB !== null && LIMIT_CODE_RE.test(codeB) && codeA !== codeB) {
    boundaryReruns += 1;
    a = await step("A");
    na = norm(a, "A");
  }
  outcomes.push(`${name}: ${summary(na)}`);
  expect(nb, `${name}: mode B (OAuth) differs from mode A (API key)`).toEqual(na);
  expect(metaKeys(nb), `${name}: _meta keys`).toEqual(metaKeys(na));
  return na;
}

/** A step in a few words: the JSON-RPC error, the `assay/error` code, the tool names, or "served". */
function summary(seen: Json): string {
  if (seen.error) return `rpc error ${JSON.stringify((seen.error as Json).message)}`;
  const result = seen.result as Json;
  if (Array.isArray(result.tools)) return `tools [${(result.tools as { name: string }[]).map((t) => t.name).join(",")}]`;
  const code = errorCodeOf(result);
  if (code !== null) return code;
  return result.isError === true ? `isError ${JSON.stringify((result.content as { text?: string }[] | undefined)?.[0]?.text ?? "").slice(0, 120)}` : "served";
}

function metaKeys(seen: Json): string[] {
  const result = seen.result as Json | undefined;
  return Object.keys((result?._meta as Json | undefined) ?? {}).sort();
}

const callView = (seen: Json): Json => (seen.result ? { ...seen, result: servedOutputAsShape(seen.result as Json) } : seen);

// ---- tools of the catalogue -----------------------------------------------------------------

interface ListedTool {
  name: string;
  inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] };
  _meta?: Json;
}

interface CatalogueTool {
  id: string;
  name: string;
  pricingMode: string | null;
  routable: boolean;
}

/** Arguments that satisfy the tool's required inputs (values chosen by type). */
function argsFor(tool: ListedTool | undefined): Json {
  const out: Json = {};
  for (const name of tool?.inputSchema?.required ?? []) {
    const type = tool?.inputSchema?.properties?.[name]?.type;
    out[name] = type === "number" || type === "integer" ? 1 : type === "boolean" ? true : type === "array" ? [] : type === "object" ? {} : "test";
  }
  return out;
}

/** The catalogue (API) and the full listing (MCP, for input schemas). */
let catalogue: CatalogueTool[] = [];
let listing: ListedTool[] = [];
/**
 * The tool each step calls: a routable tool of that pricing mode. A backend that routes no tool
 * of a mode (a bare local stack) still gets the step on some catalogue tool, whose refusal must
 * then be the same for both; ASSAY_MCP_E2E_EXPECT_SERVED=1 (CI) requires a served free tool.
 */
function toolOf(mode: "FREE" | "FREEMIUM" | "PAID"): (ListedTool & { id: string }) | undefined {
  const pick = catalogue.find((t) => t.routable && t.pricingMode === mode) ?? (mode === "FREEMIUM" ? undefined : catalogue[mode === "FREE" ? 0 : catalogue.length - 1]);
  if (pick === undefined) return undefined;
  return { ...(listing.find((t) => t.name === pick.name) ?? { name: pick.name }), id: pick.id };
}
const servedFreeTool = () => catalogue.some((t) => t.routable && t.pricingMode === "FREE");

// ---- the suite ------------------------------------------------------------------------------

describe.runIf(enabled)("equivalence through the proxy: OAuth (B) = API key (A) on the same agent (G3, R-MCP-5)", () => {
  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(reroutedFetch as typeof fetch);
    fixture = await bundleFixture(join(__dirname, "../fixtures/backend-child.ts"));
    root = mkdtempSync(join(tmpdir(), "assay-mcp-equivalence-"));
    deployment = resolveDeployment({ url: `${MCP}/`, env: { ASSAY_MCP_DEV_ORIGINS: MCP }, devOrigins: [MCP], warn: () => {} });
    worlds.B = await signInModeB();
    worlds.A = await mintModeA();
    expect(worlds.A.credentialId).not.toBe(worlds.B.credentialId);
    for (const mode of MODES) ownValues[mode].push([worlds[mode].credentialId, "<credential>"]);
    // The catalogue (ids, pricing modes) and the full listing as mode A sees it (input schemas).
    catalogue = dataOf<{ tools: CatalogueTool[] }>((await api("GET", "/catalogue/tools", humanToken)).body).tools;
    expect(catalogue.length, "the backend has no catalogue").toBeGreaterThan(0);
    listing = await onBoth("/?discovery=full", async (p) => (await p.A.client.listTools()).tools as unknown as ListedTool[]);
    if (env.ASSAY_MCP_E2E_EXPECT_SERVED === "1") expect(servedFreeTool(), "a routable free tool (the CI seed)").toBe(true);
    const ids = [...new Set([toolOf("FREE"), toolOf("FREEMIUM"), toolOf("PAID")].flatMap((t) => (t ? [t.id] : [])))];
    await createUrlKinds(ids);
  }, 180_000);

  afterAll(async () => {
    for (const id of toolsetIds) await api("DELETE", `/toolsets/${id}`, humanToken).catch(() => {});
    vi.restoreAllMocks();
    if (fixture) rmSync(fixture.dir, { recursive: true, force: true });
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("the proxy's session: one agent, two credentials; profile B records the grant", () => {
    expect(readProfile({ dir: worlds.B.dir, name: "default" })?.credentialId).toBe(worlds.B.credentialId);
    expect(worlds.A.apiKey).toMatch(/^assay_sk_live_/);
  });

  it("initialize: the same server info and capabilities", async () => {
    await onBoth("/", async (p) => {
      for (const m of MODES) expect(p[m].client.getServerCapabilities()).toBeDefined();
      expect(normalise(p.B.client.getServerVersion(), "B")).toEqual(normalise(p.A.client.getServerVersion(), "A"));
      expect(normalise(p.B.client.getServerCapabilities(), "B")).toEqual(normalise(p.A.client.getServerCapabilities(), "A"));
    });
  }, 60_000);

  it("URL kinds: tools/list identical on every kind, with and without each query", async () => {
    const free = toolOf("FREE")?.name ?? "";
    const paid = toolOf("PAID")?.name ?? free;
    const queries = ["", `?tools=${free},${paid}`, `?category=${CATEGORY}`, "?free=1", "?discovery=full"];
    for (const kind of KINDS) {
      for (const query of queries) {
        const path = `${urls[kind]}${query}`;
        await onBoth(path, async (p) => {
          const seen = await equal(`tools/list ${path}`, (m) => observe(() => p[m].client.listTools()));
          // Not vacuous: every kind and query serves a list. `/@{h}` of an organization with no
          // provider tool is not an MCP server (404 MCP_URL_NOT_FOUND, the same for both), so it
          // must serve only when ASSAY_MCP_E2E_HANDLE names a provider's handle.
          if (kind !== "handle" || SERVING_HANDLE !== null) expect(seen.result, `tools/list ${path}: ${JSON.stringify(seen.error)}`).toBeDefined();
        });
      }
    }
  }, 600_000);

  it.each([...KINDS, "rootFreeOnly"] as const)(
    "%s: tools/list; tools/call free, freemium in and over quota, paid step 1; search_tools, get_tool, call_tool free",
    async (kind) => {
      const path = kind === "rootFreeOnly" ? "/?free=1" : urls[kind];
      const free = toolOf("FREE");
      const freemium = toolOf("FREEMIUM");
      const paid = toolOf("PAID");
      await onBoth(path, async (p) => {
        const call = (m: Mode, name: string, args: Json) => observe(() => p[m].client.callTool({ name, arguments: args }));
        await equal(`${kind} tools/list`, (m) => observe(() => p[m].client.listTools()));
        if (free) await equal(`${kind} free`, (m) => call(m, free.name, argsFor(free)), callView);
        if (freemium) {
          await equal(`${kind} freemium in quota`, (m) => call(m, freemium.name, argsFor(freemium)), callView);
          // Over quota: A spends the shared quota until it is refused, then B is refused alike.
          let last: Json = {};
          for (let i = 0; i < 50; i += 1) {
            last = await call("A", freemium.name, argsFor(freemium));
            if (outcomeCode(last) !== null || (last.result as Json | undefined)?.isError === true) break;
          }
          const b = await call("B", freemium.name, argsFor(freemium));
          expect(normalise(callView(b), "B"), `${kind} freemium over quota`).toEqual(normalise(callView(last), "A"));
        }
        // Paid step 1 with nothing enabled: each proxy binds its own new key and answers the
        // enable-paid text naming it (F4); equal once each mode's key is a placeholder.
        if (paid) {
          await equal(`${kind} paid step 1`, async (m) => {
            const seen = await call(m, paid.name, argsFor(paid));
            recordBoundKey(m, seen);
            return seen;
          });
        }
        await equal(`${kind} search_tools`, (m) => call(m, "search_tools", { query: CATEGORY }));
        if (paid ?? free) await equal(`${kind} get_tool`, (m) => call(m, "get_tool", { name: (paid ?? free)!.name }));
        if (free) await equal(`${kind} call_tool free`, (m) => call(m, "call_tool", { name: free.name, arguments: argsFor(free) }), callView);
      });
    },
    300_000,
  );

  it("API host: GET /agents/me/delegate answers alike for both credentials", async () => {
    const seen: Record<Mode, unknown> = { A: null, B: null };
    for (const m of MODES) {
      const res = await api("GET", "/agents/me/delegate", await bearerOf(worlds[m]));
      expect(res.status).toBe(200);
      seen[m] = normalise(res.body, m);
    }
    expect(seen.B).toEqual(seen.A);
  });

  describe.runIf(paidEnabled)("the paid path on an anvil fork: bind, approve, sign, receipt (R-MCP-5)", () => {
    it("tools/call and call_tool pay alike in both modes", async () => {
      const paid = catalogue.some((t) => t.routable && t.pricingMode === "PAID") ? toolOf("PAID") : undefined;
      expect(paid, "a routable paid tool").toBeDefined();
      await onBoth("/", async (p) => {
        const call = (m: Mode, name: string, args: Json) => observe(() => p[m].client.callTool({ name, arguments: args }));
        // Step 1: not enabled. Each proxy binds its key and names it in the link.
        for (const m of MODES) {
          const first = await call(m, paid!.name, argsFor(paid));
          const requirement = recordBoundKey(m, first);
          expect(requirement, `mode ${m}: a PAYMENT_REQUIRED naming a payer`).not.toBeNull();
          // The payer approves this key on the fork, as the enable-paid page would.
          await authorizeOnFork(requirement!.payer, boundKeys[m]!);
          await waitFor(() => p[m].stderr().includes("Paid calls are on"), 60_000);
        }
        // Step 2: the proxy signs and the backend settles.
        const paidCall = await equal("tools/call paid", (m) => call(m, paid!.name, argsFor(paid)), callView);
        expect(((paidCall.result as Json)._meta as Json)["assay/receipt"], "a receipt").toBeDefined();
        const paidMeta = await equal("call_tool paid", (m) => call(m, "call_tool", { name: paid!.name, arguments: argsFor(paid) }), callView);
        expect(((paidMeta.result as Json)._meta as Json)["assay/receipt"], "a receipt").toBeDefined();
      });
      // The API host reads each credential's own bound key back, alike.
      const seen: Record<Mode, unknown> = { A: null, B: null };
      for (const m of MODES) seen[m] = normalise((await api("GET", "/agents/me/delegate", await bearerOf(worlds[m]))).body, m);
      expect(seen.B).toEqual(seen.A);
    }, 300_000);
  });

  it("revoke: both credentials revoked; the next request is refused for both", async () => {
    const before = { A: await bearerOf(worlds.A), B: await bearerOf(worlds.B) };
    for (const m of MODES) {
      const res = await api("DELETE", `/agents/${agentId}/credentials/${worlds[m].credentialId}`, humanToken);
      expect(res.status, JSON.stringify(res.body)).toBe(204);
    }
    const refused: Record<Mode, unknown> = { A: null, B: null };
    for (const m of MODES) {
      const res = await reroutedFetch(`${MCP}/`, {
        method: "POST",
        headers: { authorization: `Bearer ${before[m]}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      refused[m] = { status: res.status, challenge: res.headers.get("www-authenticate") };
    }
    expect(refused.B).toEqual(refused.A);
    expect((refused.A as { status: number }).status).toBe(401);
    // Through the proxy: the API key is refused; the grant's refresh is refused and the proxy is
    // back to signing in (the same server outcome; the proxy's way to show it differs by mode).
    await onBoth("/", async (p) => {
      const a = await observe(() => p.A.client.listTools());
      expect((a.error as Json | undefined)?.message).toContain("Assay refused the API key in the environment.");
      const b = await observe(() => p.B.client.listTools());
      expect(((b.result as Json).tools as { name: string }[]).map((t) => t.name)).toEqual(["assay_sign_in"]);
    });
    if (boundaryReruns > 0) console.error(`equivalence: ${boundaryReruns} step(s) re-ran A after a shared limit fell between A and B`);
    if (env.ASSAY_MCP_E2E_VERBOSE === "1") console.error(outcomes.join("\n"));
  }, 120_000);
});

// ---- the paid path helpers -------------------------------------------------------------------

const boundKeys: Partial<Record<Mode, string>> = {};

interface Requirement {
  payer: string;
  delegate: string | null;
}

/** Reads the requirement and the key the enable-paid text names; records the key as `<delegate>`. */
function recordBoundKey(mode: Mode, seen: Json): Requirement | null {
  const result = seen.result as Json | undefined;
  const requirement = ((result?._meta as Json | undefined)?.["x402/paymentRequired"] as Requirement | undefined) ?? null;
  const text = ((result?.content as { text?: string }[] | undefined)?.[0]?.text ?? "") as string;
  const key = /#key=(0x[0-9a-fA-F]{40})/.exec(text)?.[1];
  if (key !== undefined && boundKeys[mode] === undefined) {
    boundKeys[mode] = getAddress(key);
    addOwnDelegate(mode, key);
  }
  return requirement;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await realFetch(ANVIL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** The payer's own `authorizeDelegate` on the fork (impersonated: fork only, no key). */
async function authorizeOnFork(payerCaip10: string, delegate: string): Promise<void> {
  const payer = getAddress(payerCaip10.split(":").pop()!);
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  const data = encodeFunctionData({
    abi: parseAbi(["function authorizeDelegate(address delegate, uint64 maxVoucherAmount, uint64 maxPerWindow, uint64 validUntil)"]),
    functionName: "authorizeDelegate",
    args: [getAddress(delegate), 500_000n, 5_000_000n, validUntil],
  });
  await rpc("anvil_impersonateAccount", [payer]);
  await rpc("anvil_setBalance", [payer, "0x56BC75E2D63100000"]);
  const hash = await rpc<string>("eth_sendTransaction", [{ from: payer, to: ESCROW.address, data }]);
  const receipt = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
  await rpc("anvil_stopImpersonatingAccount", [payer]);
  if (receipt?.status !== "0x1") throw new Error("authorizeDelegate reverted on the fork");
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 250));
  }
}
