import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { builtInDeployments } from "../src/deployments.js";
import { addDevOrigin } from "../src/profile/dev-origins.js";
import { Keychain } from "../src/profile/keychain.js";
import { LOCK_DIR_SUFFIX, OWNER_FILE, readOwner, STALE_MS, withLock } from "../src/profile/lock.js";
import { addPaidUrl, readProfile } from "../src/profile/profile.js";
import { bundleFixture } from "./helpers/bundle.js";
import { E2E_MCP, FakeAs } from "./helpers/fake-as.js";
import { API_KEY, CREDENTIAL_ID, FakeAssay, type NetworkEntry } from "./helpers/fake-assay.js";
import { FakeMcp } from "./helpers/fake-mcp.js";
import { FileKeyring } from "./helpers/file-keyring.js";

/**
 * Task 2.17, spec §12.4 "Concurrency", through the proxy itself: every case runs real child
 * processes of `serve` (the proxy's entry, bundled from the source), driven over stdio by the
 * MCP SDK client. Each test has its own temporary profile directory, shared by its processes
 * the way windows on one machine share one, and a keyring file standing in for the OS keychain.
 * The real keychain and the real profile are never touched (the global guard checks the latter).
 *
 * - 10 processes get a 401 at once → one refresh on the server, no revoke;
 * - two first-time processes → one consent and one grant (sign-in), one payment key (F4);
 * - a holder killed while it holds the profile lock → its lock is reclaimed once stale.
 */

const SIGN_IN = { name: "assay_sign_in", arguments: {} };
const NET_ID = "eip155:46630";
const BUILT_IN = builtInDeployments().e2e.networks[NET_ID]!;
const NETWORK: NetworkEntry = { id: NET_ID, escrow: BUILT_IN.escrow, asset: BUILT_IN.asset, decimals: BUILT_IN.decimals };
const WEB = builtInDeployments().e2e.web;

let serveFixture: { dir: string; file: string };
let paidFixture: { dir: string; file: string };
let dir: string;
let keyringFile: string;
const clients: Client[] = [];

beforeAll(async () => {
  [serveFixture, paidFixture] = await Promise.all([bundleFixture(join(__dirname, "fixtures/serve-child.ts")), bundleFixture(join(__dirname, "fixtures/paid-child.ts"))]);
}, 60_000);

afterAll(() => {
  rmSync(serveFixture.dir, { recursive: true, force: true });
  rmSync(paidFixture.dir, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "assay-mcp-concurrency-"));
  keyringFile = join(dir, "..", `${basename(dir)}-keyring.json`);
  addDevOrigin(dir, E2E_MCP);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  rmSync(dir, { recursive: true, force: true });
  rmSync(keyringFile, { force: true });
});

const profile = () => ({ dir, name: "default" });
const keyringEntries = (): Record<string, string> => (existsSync(keyringFile) ? (JSON.parse(readFileSync(keyringFile, "utf8")) as Record<string, string>) : {});
const lockDir = () => join(dir, "profiles", `default${LOCK_DIR_SUFFIX}`);
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

async function until<T>(check: () => T | undefined | null | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** One proxy process (`serve` over stdio) and its SDK client. */
async function spawnProxy(fixture: { file: string }, env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture.file, "--url", `${E2E_MCP}/`],
    env: { ASSAY_MCP_DEV_ORIGINS: E2E_MCP, TEST_DIR: dir, TEST_KEYRING: keyringFile, ...env },
    stderr: "pipe",
  });
  const err: string[] = [];
  transport.stderr?.on("data", (c: Buffer) => err.push(c.toString("utf8")));
  const client = new Client({ name: "test-host", version: "1.0.0" });
  const changed: number[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changed.push(Date.now());
  });
  clients.push(client);
  await client.connect(transport);
  return { client, transport, changed, stderr: () => err.join(""), pid: () => transport.pid };
}

describe("§12.4 concurrency, OAuth mode (fake AS + fake MCP)", () => {
  let as: FakeAs;
  let mcp: FakeMcp;

  beforeEach(async () => {
    as = new FakeAs();
    as.clock = Math.floor(Date.now() / 1000);
    await as.start();
    mcp = new FakeMcp(as);
    await mcp.start();
  });

  afterEach(async () => {
    await mcp.stop();
    await as.stop();
  });

  const proxy = () => spawnProxy(serveFixture, { TEST_AS_PORT: String(as.port), TEST_MCP_PORT: String(mcp.port) });

  /** A stored grant, as an earlier sign-in left it; the stored access token looks valid locally. */
  async function signedIn() {
    const pair = as.seedGrant();
    const keychain = new Keychain(new FileKeyring(keyringFile), { profile: "default", environment: "e2e" });
    await withLock(profile(), (lock) =>
      keychain.storeTokens(lock, { refreshToken: pair.refreshToken, accessToken: { token: pair.accessToken, expiresAt: Math.floor(Date.now() / 1000) + 3600 } }),
    );
    return pair;
  }

  it("10 processes get a 401 at once → one server refresh, no revoke, every call served", async () => {
    const pair = await signedIn();
    const procs = await Promise.all(Array.from({ length: 10 }, () => proxy()));
    for (const p of procs) expect((await p.client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    expect(as.tokenCalls("refresh_token")).toHaveLength(0);

    // The server ends the access token (it expired on the server's clock); the local copy still
    // looks valid, so all ten send it, get 401 and race to refresh.
    as.clock += 7_200;
    as.tokenDelayMs = 300;
    const lists = await Promise.all(procs.map((p) => p.client.listTools()));
    for (const l of lists) expect(l.tools.map((t) => t.name)).toEqual(["echo"]);

    expect(as.tokenCalls("refresh_token")).toHaveLength(1);
    expect(as.requests.filter((r) => r.path === "/oauth/revoke")).toHaveLength(0);
    expect(as.grants.every((g) => !g.revoked)).toBe(true);
    // Every retry carried the one new access token.
    const bearers = new Set(mcp.requests.filter((r) => (r.json as { method?: string })?.method === "tools/list").map((r) => r.headers.authorization));
    expect(bearers.size).toBe(2);
    expect(bearers.has(`Bearer ${pair.accessToken}`)).toBe(true);
    // One stored generation, and nothing in the keyring but the rotated pair.
    const stored = keyringEntries();
    expect(Object.keys(stored).sort()).toEqual(["ai.assay.mcp/default@e2e/access_token", "ai.assay.mcp/default@e2e/refresh_token"]);
    expect(stored["ai.assay.mcp/default@e2e/refresh_token"]).not.toBe(pair.refreshToken);
    for (const p of procs) expect(p.stderr()).not.toMatch(/assay_(at|rt)_/);
  }, 60_000);

  it("two first-time processes sign in at once → one consent, one grant, one stored credential", async () => {
    expect(existsSync(join(dir, "profiles"))).toBe(false);
    const [a, b] = await Promise.all([proxy(), proxy()]);
    const texts = (await Promise.all([a.client.callTool(SIGN_IN), b.client.callTool(SIGN_IN)])).map(textOf);
    expect(texts.filter((t) => t.startsWith("Approve in your browser: "))).toHaveLength(1);
    await until(() => a.changed.length > 0 && b.changed.length > 0);

    expect(mcp.opened).toHaveLength(1); // one consent page
    expect(as.authorizeParams).toHaveLength(1);
    expect(as.tokenCalls("authorization_code")).toHaveLength(1);
    expect(as.grants).toHaveLength(1);
    expect(Object.keys(keyringEntries()).sort()).toEqual(["ai.assay.mcp/default@e2e/access_token", "ai.assay.mcp/default@e2e/refresh_token"]);
    for (const p of [a, b]) expect((await p.client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    await until(() => readProfile(profile())?.credentialId);
    expect(readProfile(profile())!.credentialId).toBe(as.grants[0]!.credentialId);
  }, 30_000);

  it("a holder killed while it holds the profile lock (mid-refresh) → the lock is reclaimed once stale; one rotation, no revoke", async () => {
    const pair = await signedIn();
    const holder = await proxy();
    const waiter = await proxy();
    expect((await holder.client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);

    // The holder refreshes under the profile lock; the token endpoint never answers.
    as.clock += 7_200;
    as.misbehave["/oauth/token"] = "stall";
    void holder.client.listTools().catch(() => {});
    await until(() => as.tokenCalls("refresh_token").length === 1);
    const owner = await until(() => readOwner(lockDir()));
    expect(owner.pid).toBe(holder.pid());
    process.kill(owner.pid, "SIGKILL");
    await until(() => {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch {
        return true;
      }
    });

    // The dead holder's lock is still there; once its last touch is older than 30 s it is stale.
    expect(readOwner(lockDir())).toEqual(owner);
    const old = (Date.now() - STALE_MS - 1_000) / 1000;
    utimesSync(join(lockDir(), OWNER_FILE), old, old);
    utimesSync(lockDir(), old, old);
    delete as.misbehave["/oauth/token"];

    expect((await waiter.client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    // The stalled request never reached the token logic, so the waiter's is the one rotation.
    expect(as.tokenCalls("refresh_token")).toHaveLength(2);
    expect(as.requests.filter((r) => r.path === "/oauth/revoke")).toHaveLength(0);
    expect(as.grants.every((g) => !g.revoked)).toBe(true);
    expect(keyringEntries()["ai.assay.mcp/default@e2e/refresh_token"]).not.toBe(pair.refreshToken);
    // Reclaimed and released: no lock and no moved-away lock directory left behind.
    expect(existsSync(lockDir())).toBe(false);
  }, 30_000);
});

describe("§12.4 concurrency, the paid path (fake Assay, API-key mode)", () => {
  let fake: FakeAssay;

  beforeEach(async () => {
    fake = new FakeAssay(NETWORK);
    await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  it("two first-time processes hit PAYMENT_REQUIRED at once → one payment key, bound, one enable-paid page", async () => {
    // First time: no profile and no key; only the URL is allowed for paid calls (as `add` leaves it).
    await withLock(profile(), (lock) => addPaidUrl(profile(), lock, "/"));
    const env = { ASSAY_DEV_API_KEY: API_KEY, TEST_PORT: String(fake.port) };
    const [a, b] = await Promise.all([spawnProxy(paidFixture, env), spawnProxy(paidFixture, env)]);
    // Both windows are held in their network phase until each has asked for a challenge, so the
    // race is real: the server keeps one live challenge per credential (AgentDelegateService), and
    // the second request replaces the first window's challenge.
    fake.beforeChallenge = async () => {
      const end = Date.now() + 1_500;
      while (fake.challenges.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    };
    const first = (await Promise.all([a.client.callTool({ name: "weather", arguments: {} }), b.client.callTool({ name: "weather", arguments: {} })])).map(textOf);

    // One key: generated once, under the lock, and stored once; every challenge was for it.
    const keys = Object.entries(keyringEntries()).filter(([k]) => k.endsWith("/delegate_key"));
    expect(keys).toHaveLength(1);
    const address = privateKeyToAccount(keys[0]![1] as `0x${string}`).address;
    expect(fake.challenges.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fake.challenges)).toEqual(new Set([address]));
    // Each window shows the link naming that key, or (when its challenge was replaced by the
    // sibling's and the bind was refused) the "try again" text; never another key.
    const link = `${WEB}/agents/enable-paid?credential=${CREDENTIAL_ID}#key=${address}`;
    const retry = "Paid calls could not be set up: Assay did not accept the payment key. Try again.";
    for (const t of first) expect(t.includes(link) || t === retry, t).toBe(true);
    expect(fake.opened.length).toBeLessThanOrEqual(1);
    // Asked again one after the other, both name the same key, bound on the server.
    for (const p of [a, b]) expect(textOf(await p.client.callTool({ name: "weather", arguments: {} }))).toContain(link);
    expect(fake.delegate).toBe(address);
    expect(Object.keys(keyringEntries()).filter((k) => k.endsWith("/delegate_key"))).toHaveLength(1);
    // One consent page: the enable-paid link opened once for the profile.
    expect(fake.opened).toEqual([link]);
    expect(readProfile(profile())).toMatchObject({ credentialId: CREDENTIAL_ID, delegateAddress: address, network: NET_ID });
    expect(fake.accepted).toHaveLength(0);
  }, 30_000);
});
