import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtInDeployments } from "../src/deployments.js";
import { addDevOrigin } from "../src/profile/dev-origins.js";
import { Keychain } from "../src/profile/keychain.js";
import { withLock } from "../src/profile/lock.js";
import { addPaidUrl, createProfile, readProfile, readState } from "../src/profile/profile.js";
import { bundleFixture } from "./helpers/bundle.js";
import { API_KEY, CREDENTIAL_ID, FakeAssay, type NetworkEntry } from "./helpers/fake-assay.js";
import { FileKeyring } from "./helpers/file-keyring.js";

/**
 * Task 2.17, R-MCP-5 against the fake Assay: API-key mode (A) binds, guards and pays exactly like
 * OAuth mode (B). The same script runs once per mode, each on its own fake server, profile
 * directory and keyring file, through the real `serve` over stdio; the host-visible answers, the
 * requests the server saw and the local state are compared after each mode's own key (and its
 * fingerprint) become placeholders. The real-backend twin of this is
 * test/integration/equivalence.test.ts, whose paid part needs an anvil fork.
 */

const E2E_MCP = "http://localhost:3200";
const NET_ID = "eip155:46630";
const BUILT_IN = builtInDeployments().e2e.networks[NET_ID]!;
const NETWORK: NetworkEntry = { id: NET_ID, escrow: BUILT_IN.escrow, asset: BUILT_IN.asset, decimals: BUILT_IN.decimals };
/** Secret-shaped test values (not real secrets). */
const ACCESS_TOKEN = `assay_at_${"m".repeat(43)}`;
const REFRESH_TOKEN = `assay_rt_${"n".repeat(43)}`;

type Mode = "A" | "B";

let fixture: { dir: string; file: string };
const cleanup: (() => void)[] = [];

beforeAll(async () => {
  fixture = await bundleFixture(join(__dirname, "fixtures/paid-child.ts"));
}, 60_000);

afterAll(() => {
  for (const c of cleanup.splice(0)) c();
  rmSync(fixture.dir, { recursive: true, force: true });
});

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** One mode's world: a fake server, a first-time profile directory and keyring, and the proxy. */
async function world(mode: Mode) {
  const fake = new FakeAssay(NETWORK);
  await fake.start();
  const dir = mkdtempSync(join(tmpdir(), `assay-mcp-modes-${mode}-`));
  const keyringFile = join(dir, "..", `${dir.split("/").pop()}-keyring.json`);
  addDevOrigin(dir, E2E_MCP);
  const profile = { dir, name: "default" };
  if (mode === "A") {
    // What `add` leaves for an API-key user: paid calls allowed on `/`, no profile yet.
    await withLock(profile, (lock) => addPaidUrl(profile, lock, "/"));
  } else {
    // What a finished F1 sign-in leaves: the token pair and the profile with the credential.
    fake.bearers.add(ACCESS_TOKEN);
    const keychain = new Keychain(new FileKeyring(keyringFile), { profile: "default", environment: "e2e" });
    await withLock(profile, async (lock) => {
      await keychain.storeTokens(lock, { refreshToken: REFRESH_TOKEN, accessToken: { token: ACCESS_TOKEN, expiresAt: Math.floor(Date.now() / 1000) + 3600 } });
      createProfile(profile, lock, { environment: "e2e", credentialId: CREDENTIAL_ID, agentLabel: "agent", createdAt: new Date().toISOString() });
    });
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture.file, "--url", `${E2E_MCP}/`],
    env: {
      ASSAY_MCP_DEV_ORIGINS: E2E_MCP,
      ...(mode === "A" ? { ASSAY_DEV_API_KEY: API_KEY } : {}),
      TEST_DIR: dir,
      TEST_KEYRING: keyringFile,
      TEST_PORT: String(fake.port),
      TEST_POLL_MS: "100",
    },
    stderr: "pipe",
  });
  const err: string[] = [];
  transport.stderr?.on("data", (c: Buffer) => err.push(c.toString("utf8")));
  const client = new Client({ name: "test-host", version: "1.0.0" });
  await client.connect(transport);
  cleanup.push(() => {
    void client.close().catch(() => {});
    void fake.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(keyringFile, { force: true });
  });
  return { fake, client, profile, stderr: () => err.join("") };
}

/** Each mode's own key and fingerprint → placeholders; fresh ids, signatures and times masked. */
function normalise(value: unknown, key: string | null): unknown {
  let text = JSON.stringify(value);
  if (key !== null) {
    const fp = `${key.slice(-8, -4).toUpperCase()} ${key.slice(-4).toUpperCase()}`;
    text = text.replace(new RegExp(key, "gi"), "<delegate>").split(fp).join("<fingerprint>");
  }
  text = text
    .replace(/0x[0-9a-fA-F]{130}/g, "<signature>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, (m) => (m === CREDENTIAL_ID ? m : "<uuid>"))
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>")
    .replace(/"(issuedAt|expiresAt)":\d+/g, '"$1":"<n>"');
  return JSON.parse(text);
}

/** The whole F4 + paid script; returns what the host, the server and the profile saw. */
async function script(mode: Mode) {
  const w = await world(mode);
  const call = (name: string, args: Record<string, unknown> = {}) => w.client.callTool({ name, arguments: args });
  const steps: Record<string, unknown> = {};
  // 1. Not enabled: a key is generated, bound to the credential, and named in the link.
  steps.notEnabled = await call("weather");
  const key = w.fake.delegate;
  // 2. The person approves on the page (the chain now holds the grant); the poll sees it.
  w.fake.grant(key!);
  await until(() => w.stderr().includes("Paid calls are on"));
  // 3. Paid, on tools/call and on call_tool.
  steps.paid = await call("weather", { city: "x" });
  steps.paidMeta = await call("call_tool", { name: "weather", arguments: { city: "y" } });
  // 4. A guard refusal (G3: the price is above the quoted maxAmount), nothing signed.
  w.fake.maxAmount = w.fake.price;
  w.fake.price = w.fake.price * 2n;
  await call("get_tool", { name: "weather" });
  w.fake.maxAmount = w.fake.price / 2n;
  steps.refused = await call("weather", { city: "z" });
  const record = readProfile(w.profile);
  return {
    key,
    view: normalise(
      {
        steps,
        server: {
          challenges: w.fake.challenges.length,
          accepted: w.fake.accepted.map((a) => ({ amount: a.amount, idempotencyKey: typeof a.idempotencyKey })),
          rejected: w.fake.rejected,
          calls: w.fake.calls.map((c) => ({ name: c.name, metaKeys: Object.keys(c.meta).sort() })),
          // The binding requests. The credential reads (GET /agents/me/delegate) are left out: their
          // count follows the starting state (a first-time API-key profile has no credential id yet,
          // a signed-in one does) and the poll's timing.
          binding: w.fake.paths.filter((p) => p.startsWith("POST /api/")),
          credentialRead: w.fake.paths.includes("GET /api/v1/agents/me/delegate"),
        },
        profile: { credentialId: record?.credentialId, delegateAddress: record?.delegateAddress, network: record?.network, payer: record?.payer },
        spent: readState(w.profile).signed.map((s) => s.amount),
        pendingBinding: readState(w.profile).pendingBinding ?? null,
      },
      key,
    ),
  };
}

describe("R-MCP-5: API-key mode binds, guards and pays exactly like OAuth mode (fake Assay)", () => {
  it("the same F4 binding, link, paid calls and guard refusal in both modes", async () => {
    const a = await script("A");
    const b = await script("B");
    expect(a.key).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(b.key).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(b.key).not.toBe(a.key); // each profile made its own key
    expect(b.view).toEqual(a.view);

    // Not vacuous: what the script did, read from mode A's view.
    const view = a.view as { steps: Record<string, unknown>; server: { accepted: unknown[]; challenges: number } };
    expect(textOf(view.steps.notEnabled)).toContain("#key=<delegate>");
    expect(textOf(view.steps.notEnabled)).toContain("<fingerprint>");
    expect((view.steps.paid as { isError?: boolean }).isError).toBeFalsy();
    expect((view.steps.paidMeta as { _meta: Record<string, unknown> })._meta["assay/receipt"]).toBeDefined();
    expect((view.steps.refused as { _meta: Record<string, { guard: string }> })._meta["assay-mcp/refused"]!.guard).toBe("G3");
    expect(view.server.accepted).toHaveLength(2);
    expect(view.server.challenges).toBe(1);
  }, 60_000);
});
