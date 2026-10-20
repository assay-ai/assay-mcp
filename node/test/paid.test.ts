import { RUN } from "../src/version.js";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { builtInDeployments } from "../src/deployments.js";
import type { DelegationResult } from "../src/chain/reads.js";
import { QuoteCache, QUOTE_TTL_MS } from "../src/guards/quote-cache.js";
import { addDevOrigin } from "../src/profile/dev-origins.js";
import { resolveDeployment } from "../src/profile/deployments.js";
import { Keychain } from "../src/profile/keychain.js";
import { withLock } from "../src/profile/lock.js";
import { addPaidUrl, createProfile, readProfile, readState, removePaidUrl, writeLimits } from "../src/profile/profile.js";
import { openThroughGate } from "../src/proxy/browser-gate.js";
import { CallRegistry } from "../src/proxy/calls.js";
import {
  appendText,
  debtSuffix,
  enablePaidLink,
  fingerprint,
  notAllowedText,
  paymentState,
  prepareCallParams,
  quoteFromGetTool,
  quotesFromList,
  quotesFromSearch,
} from "../src/proxy/meta.js";
import { PaidPath, usdText, type PaidHost } from "../src/proxy/paid.js";
import { currentAccess } from "../src/oauth/tokens.js";
import { FakeAs, rerouteFetch } from "./helpers/fake-as.js";

type JsonRpcResponseLike = { jsonrpc: "2.0"; id: number; result: Record<string, unknown> };
import { declaresFormElicitation } from "../src/proxy/proxy.js";
import { VERSION } from "../src/version.js";
import { bundleFixture } from "./helpers/bundle.js";
import { API_KEY, CREDENTIAL_ID, FakeAssay, PAYER, PROVIDER, verifyVoucher, type NetworkEntry, type WireVoucher } from "./helpers/fake-assay.js";
import { MemoryKeyring } from "./helpers/memory-keyring.js";
import { FileKeyring } from "./helpers/file-keyring.js";

/**
 * Task 2.9: the paid path, driven by the real MCP SDK client over stdio against a fake Assay
 * (MCP + API + chain) whose voucher check follows the backend's. No real network, no real
 * keychain, no real profile: each test has its own profile directory and keyring file.
 */

const E2E_MCP = "http://localhost:3200";
const WEB = builtInDeployments().e2e.web;
const NET_ID = "eip155:46630";
const BUILT_IN = builtInDeployments().e2e.networks[NET_ID]!;
const NETWORK: NetworkEntry = { id: NET_ID, escrow: BUILT_IN.escrow, asset: BUILT_IN.asset, decimals: BUILT_IN.decimals };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let fixture: { dir: string; file: string };
let lockFixture: { dir: string; file: string };
/** Public anvil default account 4 (test only). */
const OTHER_PAYER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
let fake: FakeAssay;
let dir: string;
let keyringFile: string;
const clients: Client[] = [];

beforeAll(async () => {
  fixture = await bundleFixture(join(__dirname, "fixtures/paid-child.ts"));
  lockFixture = await bundleFixture(join(__dirname, "fixtures/lock-child.ts"));
}, 60_000);

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
  rmSync(lockFixture.dir, { recursive: true, force: true });
});

beforeEach(async () => {
  fake = new FakeAssay(NETWORK);
  await fake.start();
  dir = mkdtempSync(join(tmpdir(), "assay-mcp-paid-"));
  keyringFile = join(dir, "..", `${basename(dir)}-keyring.json`);
  addDevOrigin(dir, E2E_MCP);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(keyringFile, { force: true });
});

const profile = () => ({ dir, name: "default" });
const keychain = () => new Keychain(new FileKeyring(keyringFile), { profile: "default", environment: "e2e" });

/** A profile with the credential, and (when `key`) a delegate key in the keyring. */
async function seedProfile(key = true): Promise<string | null> {
  const pk = generatePrivateKey();
  const address = privateKeyToAccount(pk).address;
  await withLock(profile(), async (lock) => {
    createProfile(profile(), lock, {
      environment: "e2e",
      credentialId: CREDENTIAL_ID,
      agentLabel: "agent",
      createdAt: new Date().toISOString(),
      ...(key ? { delegateAddress: address, network: NET_ID } : {}),
    });
    if (key) await keychain().set(lock, "delegate_key", pk);
  });
  return key ? address : null;
}

/** Paid calls on: a key here, bound to the credential, with an active grant on chain. */
async function enabled(grant: Parameters<FakeAssay["grant"]>[1] = {}): Promise<string> {
  const address = (await seedProfile(true))!;
  fake.delegate = address;
  fake.grant(address, grant);
  return address;
}

async function setLimits(limits: { perCall?: string; perDay?: string; confirmAbove?: string | null }): Promise<void> {
  await withLock(profile(), (lock) => writeLimits(profile(), lock, { perCall: "0.50", perDay: "5", confirmAbove: null, providers: null, ...limits }));
}

type ElicitHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

async function connect(opts: { args?: string[]; elicit?: ElicitHandler; extraEnv?: Record<string, string> } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture.file, "--url", `${E2E_MCP}/`, ...(opts.args ?? [])],
    env: {
      ASSAY_MCP_DEV_ORIGINS: E2E_MCP,
      ASSAY_DEV_API_KEY: API_KEY,
      TEST_DIR: dir,
      TEST_KEYRING: keyringFile,
      TEST_PORT: String(fake.port),
      ...(opts.extraEnv ?? {}),
    },
    stderr: "pipe",
  });
  const err: string[] = [];
  transport.stderr?.on("data", (c: Buffer) => err.push(c.toString("utf8")));
  const client = new Client({ name: "test-host", version: "1.0.0" }, opts.elicit ? { capabilities: { elicitation: {} } } : {});
  if (opts.elicit) {
    const handler = opts.elicit;
    client.setRequestHandler(ElicitRequestSchema, async (request) => handler(request.params as Record<string, unknown>) as never);
  }
  clients.push(client);
  await client.connect(transport);
  return { client, stderr: () => err.join("") };
}

async function until<T>(check: () => T | undefined | null | false, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);
const metaOf = (r: unknown) => ((r as { _meta?: Record<string, unknown> })._meta ?? {});
const weatherCalls = () => fake.calls.filter((c) => c.name === "weather" || (c.name === "call_tool" && (c.params.arguments as { name?: string })?.name === "weather"));

// ---- through the proxy ----------------------------------------------------------------------

describe("paid path (SDK client → proxy → fake Assay)", () => {
  it("host-supplied assay/voucher stripped", async () => {
    const { client } = await connect();
    await client.callTool({ name: "echo", arguments: { a: 1 }, _meta: { "assay/voucher": { voucher: {}, signature: "0x00", providerId: "x" }, "assay/rail": "B", "other/key": 7 } });
    const seen = fake.calls.find((c) => c.name === "echo")!;
    expect(seen.meta["assay/voucher"]).toBeUndefined();
    expect(seen.meta["assay/rail"]).toBeUndefined();
    expect(seen.meta["other/key"]).toBe(7);
    expect(seen.meta["assay/idempotency-key"]).toMatch(UUID_RE);
  });

  it("idempotency key added and reused on the retry", async () => {
    await enabled();
    const { client, stderr } = await connect({ args: ["--log-level", "debug"] });
    await client.listTools();
    const r = await client.callTool({ name: "weather", arguments: { city: "x" } });
    expect(r.isError).toBeFalsy();
    const [first, retry] = weatherCalls();
    const key = first!.meta["assay/idempotency-key"];
    expect(key).toMatch(UUID_RE);
    expect(retry!.meta["assay/idempotency-key"]).toBe(key);
    expect(retry!.meta["assay/voucher"]).toBeDefined();
    expect(retry!.params.arguments).toEqual(first!.params.arguments);
    expect(fake.accepted).toHaveLength(1);
    expect(fake.accepted[0]!.idempotencyKey).toBe(key);
    expect(metaOf(r)["assay/receipt"]).toBeDefined();
    // Neither the signature nor the key reaches a log line, even at debug.
    const pk = (await keychain().get("delegate_key"))!;
    expect(stderr()).toContain("voucher signed");
    expect(stderr()).not.toContain(fake.accepted[0]!.signature.slice(2, 40));
    expect(stderr()).not.toContain(pk.slice(2, 40));

    // A key the host chose is kept, on the call and on the retry.
    await client.callTool({ name: "weather", arguments: { city: "y" }, _meta: { "assay/idempotency-key": "host-key-1" } });
    const keys = weatherCalls().slice(2).map((c) => c.meta["assay/idempotency-key"]);
    expect(keys).toEqual(["host-key-1", "host-key-1"]);
  });

  it("second PAYMENT_REQUIRED after signing → returned to host, no second voucher", async () => {
    await enabled();
    fake.repeatPaymentRequired = true;
    const { client } = await connect();
    await client.listTools();
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(r.isError).toBe(true);
    expect(metaOf(r)["x402/paymentRequired"]).toBeDefined();
    expect(metaOf(r)["assay-mcp/refused"]).toBeUndefined();
    const calls = weatherCalls();
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => c.meta["assay/voucher"] !== undefined)).toHaveLength(1);
    expect(readState(profile()).signed).toHaveLength(1);
  });

  it("call_tool path signs for the inner call", async () => {
    await enabled();
    const { client } = await connect();
    const r = await client.callTool({ name: "call_tool", arguments: { name: "weather", arguments: { city: "z" } } });
    expect(r.isError).toBeFalsy();
    expect(fake.accepted).toHaveLength(1);
    // No list was cached: the proxy asked get_tool for the inner tool itself (G3).
    expect(fake.calls.find((c) => c.name === "get_tool")!.params.arguments).toEqual({ name: "weather" });
    const retry = fake.calls.filter((c) => c.name === "call_tool")[1]!;
    expect(retry.params.arguments).toEqual({ name: "weather", arguments: { city: "z" } });
  });

  it("debt text appended exactly", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "owe", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`An unpaid call must be settled first. Settle it at ${WEB}/funding`);
    expect((metaOf(r)["assay/error"] as { code: string }).code).toBe("PAYMENT_DEBT_OUTSTANDING");
  });

  it('not-enabled text exactly §7.7 step 6, contains "#key=0x…" and the fingerprint (F4 binding)', async () => {
    await seedProfile(false);
    const { client, stderr } = await connect({ extraEnv: { TEST_POLL_MS: "100" } }) // default log level: the line must still show;
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(r.isError).toBe(true);
    // A key was generated and bound (challenge checked and signed by that key).
    const address = fake.delegate!;
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(fake.challenges).toEqual([address]);
    const fp = `${address.slice(-8, -4).toUpperCase()} ${address.slice(-4).toUpperCase()}`;
    const link = `${WEB}/agents/enable-paid?credential=${CREDENTIAL_ID}#key=${address}`;
    expect(textOf(r)).toBe(
      `This tool is paid, and paid calls are off for this agent. Open ${link} to turn them on (about a minute), then ask again. The page must show this payment key: ${fp}.`,
    );
    expect(textOf(r)).toContain("#key=0x");
    expect(metaOf(r)["x402/paymentRequired"]).toBeDefined(); // original _meta kept
    expect(fake.opened).toEqual([link]);
    expect(fake.accepted).toHaveLength(0);
    // The key is in the keyring only, never in a file or a log line.
    const pk = await keychain().get("delegate_key");
    expect(privateKeyToAccount(pk as `0x${string}`).address).toBe(address);
    expect(stderr()).not.toContain(pk!.slice(2));

    // The page is approved: the wait sees the grant on chain, Assay confirms it, and says so.
    const fullReads = () => fake.paths.filter((p) => p === "GET /api/v1/agents/me/delegate").length;
    await until(() => fake.paths.includes("GET /api/v1/agents/me/delegate/status"));
    // Three ticks of the wait (three eth_call per read on the one e2e RPC), none of them on the API.
    const calls = () => fake.rpcCalls.filter((m) => m === "eth_call").length;
    const reads = calls();
    await until(() => calls() >= reads + 9);
    const before = fullReads();
    fake.grant(address);
    await until(() => stderr().includes("Paid calls are on"));
    // One status read and one full read for the whole wait, however many ticks it took.
    expect(fake.paths.filter((p) => p === "GET /api/v1/agents/me/delegate/status")).toHaveLength(1);
    expect(fullReads()).toBe(before + 1);
    // Then the next call pays.
    const paid = await client.callTool({ name: "weather", arguments: {} });
    expect(paid.isError).toBeFalsy();
    expect(fake.accepted).toHaveLength(1);
  });

  it("an older backend (no status route, 404): the wait polls the full route as before and still turns paid calls on", async () => {
    await seedProfile(false);
    fake.statusRoute = false;
    const { client, stderr } = await connect({ extraEnv: { TEST_POLL_MS: "100" } });
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(textOf(r)).toContain("paid calls are off for this agent");
    await until(() => fake.paths.filter((p) => p === "GET /api/v1/agents/me/delegate").length >= 2);
    fake.grant(fake.delegate!);
    await until(() => stderr().includes("Paid calls are on"));
    expect(fake.paths.filter((p) => p === "GET /api/v1/agents/me/delegate/status")).toHaveLength(1);
    const paid = await client.callTool({ name: "weather", arguments: {} });
    expect(paid.isError).toBeFalsy();
  });

  it("binding: the challenge is checked against a Date-corrected clock (skew 100 s), refused past the clamp (200 s) after one retry", async () => {
    await seedProfile(false);
    fake.skewSeconds = 100;
    const { client } = await connect();
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(textOf(r)).toContain("/agents/enable-paid?credential=");
    expect(fake.delegate).not.toBeNull();

    fake.delegate = null;
    fake.challenges.length = 0;
    fake.skewSeconds = 200;
    const r2 = await client.callTool({ name: "weather", arguments: {} });
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toBe("Paid calls could not be set up: this computer's clock is too far from Assay's. Check the clock, then try again.");
    expect(fake.challenges).toHaveLength(2);
    expect(fake.delegate).toBeNull();
  });

  it("F5 step 3: an existing key with a live grant is bound to the credential and the call is paid", async () => {
    const address = (await seedProfile(true))!;
    fake.grant(address); // authorised on chain before; this credential has no key bound yet
    const { client } = await connect();
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(fake.delegate).toBe(address);
    expect(fake.challenges).toEqual([address]);
    expect(fake.accepted).toHaveLength(1);
    expect(fake.opened).toEqual([]);
  });

  it("browser opened at most once in 10 minutes across two processes", async () => {
    await seedProfile(false);
    const a = await connect();
    const b = await connect();
    const [ra, rb] = await Promise.all([a.client.callTool({ name: "weather", arguments: {} }), b.client.callTool({ name: "weather", arguments: {} })]);
    expect(textOf(ra)).toContain("#key=0x");
    expect(textOf(rb)).toContain("#key=0x");
    const again = await a.client.callTool({ name: "weather", arguments: {} });
    expect(textOf(again)).toContain("#key=0x");
    expect(fake.opened).toHaveLength(1);
    expect(readState(profile()).lastBrowserOpen).not.toBeNull();
  });

  it("URL not in paid-urls.json → the allow-paid text exactly, nothing signed", async () => {
    await enabled();
    await withLock(profile(), (lock) => removePaidUrl(profile(), lock, "/"));
    const { client } = await connect();
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(textOf(r)).toBe(`Paid calls through this server are off. To allow them, run in a terminal: npx -y @goassay-ai/mcp@${VERSION} allow-paid ${E2E_MCP}/`);
    expect(r.isError).toBe(true);
    expect(fake.accepted).toHaveLength(0);
    await withLock(profile(), (lock) => addPaidUrl(profile(), lock, "/"));
  });

  it("the payer is recorded after the first paid call; a later different payer is refused (G4 payer changed)", async () => {
    const address = await enabled();
    const { client } = await connect();
    expect((await client.callTool({ name: "weather", arguments: {} })).isError).toBeFalsy();
    expect(readProfile(profile())!.payer).toBe(PAYER);
    // The server now names another payer, whose on-chain grant also names our key.
    fake.payer = OTHER_PAYER;
    fake.grant(address);
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(r.isError).toBe(true);
    expect(metaOf(r)["assay-mcp/refused"]).toEqual({ guard: "G4", reason: `payer changed; run ${RUN} enable-paid` });
    expect(fake.accepted).toHaveLength(1);
    expect(readProfile(profile())!.payer).toBe(PAYER);
  });

  it("a bind answer naming another key → an error, no link, no browser", async () => {
    await seedProfile(false);
    fake.bindAnswerDelegate = OTHER_PAYER;
    const { client } = await connect();
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("Paid calls could not be set up: Assay did not accept the payment key. Try again.");
    expect(textOf(r)).not.toContain("enable-paid");
    expect(fake.opened).toEqual([]);
    expect(readProfile(profile())!.delegateAddress).toBeNull();
  });

  for (const [what, payTo] of [
    ["another escrow", `${NET_ID}:0x1111111111111111111111111111111111111111`],
    ["the escrow on another chain", `eip155:1:${BUILT_IN.escrow.split(":")[2]}`],
  ] as const) {
    it(`payTo ${what} → refused by G2 through the proxy, nothing signed`, async () => {
      await enabled();
      fake.payToOverride = payTo;
      const { client } = await connect();
      await client.listTools();
      const r = await client.callTool({ name: "weather", arguments: {} });
      expect(r.isError).toBe(true);
      expect(metaOf(r)["assay-mcp/refused"]).toEqual({ guard: "G2", reason: "the payment is not to the built-in escrow" });
      expect(fake.accepted).toHaveLength(0);
      expect(readState(profile()).signed).toHaveLength(0);
    });
  }

  it("binding holds no lock in its network phase: another process takes the profile lock meanwhile", async () => {
    await seedProfile(false);
    let taken = false;
    fake.beforeChallenge = async () => {
      const child = fork(lockFixture.file, [dir, "default", "hold"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("the lock was not free")), 5_000);
          child.on("message", (m) => {
            if (m === "acquired") {
              taken = true;
              child.send("release");
            } else if (m === "released") {
              clearTimeout(timer);
              resolve();
            }
          });
        });
      } finally {
        child.kill("SIGKILL");
      }
    };
    const { client } = await connect();
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(taken).toBe(true);
    expect(textOf(r)).toContain("#key=0x");
  });

  it("--no-paid → PAYMENT_REQUIRED passes through unchanged", async () => {
    await enabled();
    const { client } = await connect({ args: ["--no-paid"] });
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(textOf(r)).toContain("is paid on rail B");
    expect(metaOf(r)["assay-mcp/refused"]).toBeUndefined();
    expect(weatherCalls()).toHaveLength(1);
  });

  it("a guard refusal: the refusal text and _meta assay-mcp/refused, nothing signed (G3 above the quote)", async () => {
    await enabled();
    fake.maxAmount = 100_000n; // the quote says at most $0.10; the offer is $0.25
    const { client } = await connect();
    await client.listTools();
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("Assay asked for a payment this app refused: the amount is above the quoted price.");
    expect(metaOf(r)["assay-mcp/refused"]).toEqual({ guard: "G3", reason: "the amount is above the quoted price" });
    expect(metaOf(r)["x402/paymentRequired"]).toBeDefined();
    expect(fake.accepted).toHaveLength(0);
    expect(readState(profile()).signed).toHaveLength(0);
  });

  it("elicitation absent + confirmAbove set → refuse", async () => {
    await enabled();
    await setLimits({ confirmAbove: "0.10" });
    const { client } = await connect();
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(r.isError).toBe(true);
    expect((metaOf(r)["assay-mcp/refused"] as { guard: string }).guard).toBe("G7");
    expect(fake.accepted).toHaveLength(0);
    expect(readState(profile()).signed).toHaveLength(0);
  });

  it("elicitation: the prompt shows the amount, provider and tool from the guards' values; Pay signs, Cancel does not", async () => {
    await enabled();
    await setLimits({ confirmAbove: "0.10" });
    const asked: Record<string, unknown>[] = [];
    let answer = "accept";
    const { client } = await connect({
      elicit: async (params) => {
        asked.push(params);
        if (answer === "throw") throw new Error("the host failed");
        return { action: answer, content: {} };
      },
    });
    const r = await client.callTool({ name: "weather", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(asked[0]!.message).toBe(`Pay $0.25 to ${getAddress(PROVIDER)} for weather?`);
    expect(fake.accepted).toHaveLength(1);

    for (const a of ["decline", "cancel", "throw"]) {
      answer = a; // "throw": the host answers the elicitation with a JSON-RPC error
      const r2 = await client.callTool({ name: "weather", arguments: {} });
      expect(r2.isError).toBe(true);
      expect(textOf(r2)).toBe("The payment was cancelled. Nothing was paid.");
    }
    expect(fake.accepted).toHaveLength(1);
    expect(readState(profile()).signed).toHaveLength(1);
  });

  it("a host cancel (notifications/cancelled) while the user is asked: nothing is signed", async () => {
    await enabled();
    await setLimits({ confirmAbove: "0.10" });
    const controller = new AbortController();
    const { client } = await connect({
      elicit: async () => {
        controller.abort(); // the host gives up on the call: the SDK sends notifications/cancelled
        await new Promise((r) => setTimeout(r, 300));
        return { action: "accept", content: {} };
      },
    });
    await expect(client.callTool({ name: "weather", arguments: {} }, undefined, { signal: controller.signal })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 500));
    expect(weatherCalls().filter((c) => c.meta["assay/voucher"] !== undefined)).toHaveLength(0);
    expect(readState(profile()).signed).toHaveLength(0);
  });

  it("a server refusal for an inactive delegate drops the cached chain read", async () => {
    const address = await enabled();
    const { client } = await connect();
    await client.listTools();
    expect((await client.callTool({ name: "weather", arguments: {} })).isError).toBeFalsy();
    const reads = fake.rpcCalls.filter((m) => m === "eth_call").length;
    fake.delegateInactive = true;
    fake.grant(address, { revoked: true });
    const refused = await client.callTool({ name: "weather", arguments: {} });
    expect((metaOf(refused)["assay/error"] as { code: string }).code).toBe("PAYMENT_VOUCHER_DELEGATE_INACTIVE");
    // The next call reads the chain again (not the 10-minute cache) and stops signing.
    const next = await client.callTool({ name: "weather", arguments: {} });
    expect(fake.rpcCalls.filter((m) => m === "eth_call").length).toBeGreaterThan(reads);
    expect(textOf(next)).toContain("paid calls are off for this agent");
    expect(fake.accepted).toHaveLength(1);
  });

  it("no request to /escrow/debts or /escrow/next-seq ever (fetch spy)", async () => {
    await seedProfile(false);
    const { client } = await connect({ extraEnv: { TEST_POLL_MS: "100" } });
    await client.listTools();
    await client.callTool({ name: "owe", arguments: {} });
    await client.callTool({ name: "weather", arguments: {} }); // binds, link
    fake.grant(fake.delegate!);
    await client.callTool({ name: "weather", arguments: {} }); // pays
    await client.callTool({ name: "call_tool", arguments: { name: "weather", arguments: {} } });
    expect(fake.accepted).toHaveLength(2);
    expect(fake.fetched.length).toBeGreaterThan(0);
    expect(fake.fetched.filter((u) => /\/escrow\//.test(u))).toEqual([]);
    expect(fake.paths.filter((p) => /\/escrow\//.test(p))).toEqual([]);
    for (const u of fake.fetched) expect(new URL(u).origin).toMatch(/^(http:\/\/localhost:3200|http:\/\/localhost:3000|https:\/\/rpc\.testnet\.chain\.robinhood\.com)$/);
  });

  it(
    "10 processes sign at once → distinct seq from server, G7 sum exact",
    async () => {
      await enabled({ maxVoucherAmount: 1_000_000n });
      await setLimits({ perCall: "1", perDay: "5" });
      fake.price = 600_000n; // $0.60: 8 fit in $5, the 9th and 10th do not
      const hosts = await Promise.all(Array.from({ length: 10 }, () => connect()));
      const results = await Promise.all(hosts.map((h, i) => h.client.callTool({ name: "weather", arguments: { i } })));
      const paid = results.filter((r) => !r.isError);
      const refused = results.filter((r) => r.isError);
      expect(paid).toHaveLength(8);
      expect(refused).toHaveLength(2);
      for (const r of refused) expect((metaOf(r)["assay-mcp/refused"] as { guard: string }).guard).toBe("G7");
      const seqs = fake.accepted.map((a) => a.seq);
      expect(new Set(seqs).size).toBe(8);
      const signed = readState(profile()).signed;
      expect(signed).toHaveLength(8);
      expect(signed.reduce((s, e) => s + BigInt(e.amount), 0n)).toBe(4_800_000n);
      expect(fake.rejected).toEqual([]);
    },
    60_000,
  );
});

// ---- the fake's verifier against the signer vectors ---------------------------------------

describe("fake Assay verifier follows the backend (signer vectors)", () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, "../../vectors/vouchers.json"), "utf8")) as {
    testKey: { address: string };
    cases: { name: string; network: { caip2: string; escrow: string; asset: string; decimals: number }; requirement: Record<string, unknown>; wire: WireVoucher; signature: string }[];
  };
  for (const c of vectors.cases) {
    const net: NetworkEntry = { id: c.network.caip2, escrow: c.network.escrow, asset: c.network.asset, decimals: c.network.decimals };
    it(`accepts ${c.name}, refuses it mutated`, async () => {
      const signer = vectors.testKey.address;
      expect(await verifyVoucher(c.wire, c.signature, c.requirement, net, signer, c.wire.issuedAt + 1)).toBeNull();
      expect(await verifyVoucher({ ...c.wire, seq: String(BigInt(c.wire.seq) + 1n) }, c.signature, { ...c.requirement, seq: String(BigInt(c.wire.seq) + 1n) }, net, signer, c.wire.issuedAt + 1)).toBe("signature");
      expect(await verifyVoucher(c.wire, c.signature, c.requirement, net, PAYER, c.wire.issuedAt + 1)).toBe("signature");
      expect(await verifyVoucher(c.wire, c.signature, c.requirement, net, signer, c.wire.expiresAt)).toBe("expired");
    });
  }
});

// ---- units ----------------------------------------------------------------------------------

describe("meta", () => {
  it("prepareCallParams strips voucher and rail, keeps or adds the idempotency key, keeps the rest", () => {
    const host = { name: "t", arguments: { a: 1 }, _meta: { "assay/voucher": {}, "assay/rail": "A", "assay/idempotency-key": "k1", progressToken: 3 } };
    const p = prepareCallParams(host);
    expect(p._meta).toEqual({ "assay/idempotency-key": "k1", progressToken: 3 });
    expect(host._meta["assay/voucher"]).toEqual({}); // input unchanged
    expect((prepareCallParams({ name: "t" })._meta as Record<string, string>)["assay/idempotency-key"]).toMatch(UUID_RE);
    // A host key the server would refuse (over 128 characters, control characters, not a string) is replaced.
    for (const bad of ["k".repeat(129), "a\nb", "", 7]) {
      const key = (prepareCallParams({ name: "t", _meta: { "assay/idempotency-key": bad } })._meta as Record<string, unknown>)["assay/idempotency-key"];
      expect(key).toMatch(UUID_RE);
    }
    expect((prepareCallParams({ name: "t", _meta: { "assay/idempotency-key": "k".repeat(128) } })._meta as Record<string, unknown>)["assay/idempotency-key"]).toBe("k".repeat(128));
  });

  it("fingerprint is the last 8 hex digits in two upper-case groups", () => {
    expect(fingerprint("0x00000000000000000000000000000000_1a2b9f3c".replace("_", ""))).toBe("1A2B 9F3C");
  });

  it("the enable-paid link is built only from the web origin, a UUID and an address", () => {
    const a = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    expect(enablePaidLink("http://localhost:4000", CREDENTIAL_ID, a.toLowerCase())).toBe(`http://localhost:4000/agents/enable-paid?credential=${CREDENTIAL_ID}#key=${a}`);
    expect(enablePaidLink("http://localhost:4000", "../x", a)).toBeNull();
    expect(enablePaidLink("<WEB from ops config>", CREDENTIAL_ID, a)).toBeNull();
    expect(enablePaidLink("http://localhost:4000", CREDENTIAL_ID, "0x123")).toBeNull();
  });

  it("texts", () => {
    expect(notAllowedText("https://mcp.assay.ai/c/x")).toBe(`Paid calls through this server are off. To allow them, run in a terminal: npx -y @goassay-ai/mcp@${VERSION} allow-paid https://mcp.assay.ai/c/x`);
    // A URL with ? or & is quoted, so zsh and bash run it as one word (final review I1).
    expect(notAllowedText("https://mcp.assay.ai/?tools=a&free=1")).toBe(`Paid calls through this server are off. To allow them, run in a terminal: npx -y @goassay-ai/mcp@${VERSION} allow-paid 'https://mcp.assay.ai/?tools=a&free=1'`);
    expect(debtSuffix("http://localhost:4000/")).toBe(" Settle it at http://localhost:4000/funding");
    expect(appendText({ content: [{ type: "image" }, { type: "text", text: "A." }] }, " B")).toEqual({ content: [{ type: "image" }, { type: "text", text: "A. B" }] });
    expect(usdText(250_000n, 6)).toBe("$0.25");
    expect(usdText(5_000_000n, 6)).toBe("$5");
    expect(usdText(1n, 6)).toBe("$0.000001");
  });

  it("payment state", () => {
    expect(paymentState({ _meta: { "assay/error": { code: "PAYMENT_DEBT_OUTSTANDING" } } }).kind).toBe("debt");
    expect(paymentState({ _meta: { "assay/error": { code: "PAYMENT_REQUIRED" }, "x402/paymentRequired": { rail: "B" } } }).kind).toBe("payment-required");
    // A requirement under another error code is never paid.
    expect(paymentState({ _meta: { "assay/error": { code: "TOOL_NOT_ALLOWED" }, "x402/paymentRequired": { rail: "B" } } }).kind).toBe("error");
    expect(paymentState({ content: [] }).kind).toBe("none");
  });

  it("quotes from tools/list, search_tools and get_tool", () => {
    const price = { amount: "1", maxAmount: "2", asset: "eip155:1/erc20:0x0", display: "$" };
    expect(quotesFromList({ tools: [{ name: "a", _meta: { "assay/price": price } }, { name: "b" }, { name: "bad name", _meta: { "assay/price": price } }] })).toEqual([["a", { maxAmount: "2", asset: price.asset }]]);
    expect(quotesFromSearch({ structuredContent: { results: [{ name: "s", assayPrice: price }, { name: "t", assayPrice: null }] } })).toEqual([["s", { maxAmount: "2", asset: price.asset }]]);
    expect(quoteFromGetTool({ content: [{ type: "text", text: JSON.stringify({ name: "g", price }) }] })).toEqual(["g", { maxAmount: "2", asset: price.asset }]);
    expect(quoteFromGetTool({ structuredContent: { name: "g", price: { ...price, maxAmount: "1.5" } } })).toBeNull();
    expect(quoteFromGetTool({ isError: true, structuredContent: { name: "g", price } })).toBeNull();
  });

  it("form elicitation is declared by {} or a form key", () => {
    expect(declaresFormElicitation({ elicitation: {} })).toBe(true);
    expect(declaresFormElicitation({ elicitation: { form: {} } })).toBe(true);
    expect(declaresFormElicitation({ elicitation: { url: {} } })).toBe(false);
    expect(declaresFormElicitation({})).toBe(false);
  });
});

describe("quote cache", () => {
  it("keeps a quote 60 s per tool name", () => {
    let t = 1_000;
    const cache = new QuoteCache(() => t);
    cache.set("a", { maxAmount: "5", asset: "x" });
    t += QUOTE_TTL_MS;
    expect(cache.get("a")).toEqual({ maxAmount: "5", asset: "x" });
    t += 1;
    expect(cache.get("a")).toBeNull();
  });
});

describe("browser gate", () => {
  it("opens once per 10 minutes per profile", async () => {
    let t = 1_800_000_000_000;
    const opened: string[] = [];
    const open = async (u: string) => (opened.push(u), true);
    await seedProfile(false);
    expect(await openThroughGate(profile(), "u1", open, { now: () => t })).toBe(true);
    t += 599_000;
    expect(await openThroughGate(profile(), "u2", open, { now: () => t })).toBe(false);
    t += 1_000;
    expect(await openThroughGate(profile(), "u3", open, { now: () => t })).toBe(true);
    expect(opened).toEqual(["u1", "u3"]);
  });
});

// ---- PaidPath units (fake host, real profile files, the fake Assay over HTTP) ---------------

interface UnitOptions {
  confirmAbove?: string | null;
  elicit?: (calls: CallRegistry) => Promise<unknown>;
  bearer?: () => Promise<string | null>;
  key?: boolean;
  bound?: boolean;
}

async function unit(o: UnitOptions = {}) {
  const pk = generatePrivateKey();
  const address = privateKeyToAccount(pk).address;
  const clock = { now: Date.now() };
  const mem = new MemoryKeyring();
  const kc = new Keychain(mem, { profile: "default", environment: "e2e" });
  await withLock(profile(), async (lock) => {
    createProfile(profile(), lock, { environment: "e2e", credentialId: CREDENTIAL_ID, agentLabel: "agent", createdAt: new Date().toISOString(), ...(o.key !== false ? { delegateAddress: address, network: NET_ID } : {}) });
    if (o.key !== false) await kc.set(lock, "delegate_key", pk);
  });
  if (o.confirmAbove !== undefined) await setLimits({ confirmAbove: o.confirmAbove });
  const deployment = resolveDeployment({ url: `${E2E_MCP}/`, env: { ASSAY_MCP_DEV_ORIGINS: E2E_MCP }, devOrigins: [E2E_MCP], warn: () => {} });
  const calls = new CallRegistry(() => clock.now);
  const sent: Record<string, unknown>[] = [];
  const bearers: string[] = [];
  const chainRead = (delegate: string): DelegationResult => ({
    ok: true,
    value: {
      payer: PAYER,
      delegate,
      active: o.bound !== false,
      validUntil: String(Math.floor(clock.now / 1000) + 86400),
      maxVoucherAmount: "1000000",
      maxPerWindow: "10000000",
      delegateMaxVoucherAmount: "500000",
      delegateMaxPerWindow: "5000000",
      readAt: Math.floor(clock.now / 1000),
    },
  });
  const host: PaidHost = {
    calls,
    resend: async (_c, params) => (sent.push(params), { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "paid" }] } }),
    getTool: async () => ({ jsonrpc: "2.0", id: "g", result: {} }),
    canElicit: () => o.elicit !== undefined,
    elicit: async () => (o.elicit ? o.elicit(calls) : null),
    bearer: o.bearer ?? (async () => API_KEY),
    dateOffset: () => 0,
  };
  const quotes = new QuoteCache(() => clock.now);
  quotes.set("weather", { maxAmount: "250000", asset: NETWORK.asset });
  const realFetch = globalThis.fetch;
  const paid = new PaidPath(
    {
      deployment,
      profile: profile(),
      keychain: kc,
      noPaid: false,
      chain: { readDelegation: async (_n, _p, d) => chainRead(d), invalidate: () => {}, clear: () => {} },
      quotes,
      // The API, to the fake Assay; the bearer each request carried is recorded.
      fetch: async (url, init) => {
        bearers.push(String(init.bearer));
        const rest: RequestInit & { bearer?: unknown; log?: unknown } = { ...init };
        delete rest.bearer;
        delete rest.log;
        return realFetch(`http://127.0.0.1:${fake.port}${new URL(url).pathname}`, { ...rest, headers: { ...(rest.headers as Record<string, string>), authorization: `Bearer ${API_KEY}` } });
      },
      openBrowser: async () => true,
      stderr: () => {},
      now: () => clock.now,
      lockOptions: { timeoutMs: 3_000 },
    },
    host,
  );
  if (o.key !== false && o.bound !== false) fake.delegate = address;
  const required = () => (fake as unknown as { paymentRequired: (n: string, a: object) => Record<string, unknown> }).paymentRequired("weather", {});
  return { paid, calls, sent, bearers, clock, address, kc, required };
}

describe("PaidPath units", () => {
  it("Pay later than 120 s after the call → a clear message, nothing signed", async () => {
    const u = await unit({
      confirmAbove: "0.10",
      elicit: async () => {
        u.clock.now += 121_000; // the user clicks Pay 2 minutes and 1 second after the call
        return { action: "accept", content: {} };
      },
    });
    const call = u.calls.begin(1, "weather", prepareCallParams({ name: "weather", arguments: {} }))!;
    const out = await u.paid.onToolResult(call, { jsonrpc: "2.0", id: 1, result: u.required() });
    const result = (out as { result: Record<string, unknown> }).result;
    expect(textOf(result)).toBe("The payment was not made: it was confirmed more than 2 minutes after the call. Ask again to pay.");
    expect((metaOf(result)["assay-mcp/refused"] as { guard: string }).guard).toBe("G7");
    expect(u.sent).toEqual([]);
    expect(readState(profile()).signed).toEqual([]);
  });

  it("the one-voucher-per-call backstop: a second PAYMENT_REQUIRED for the same call goes back unsigned", async () => {
    const u = await unit();
    const call = u.calls.begin(1, "weather", prepareCallParams({ name: "weather", arguments: {} }))!;
    const first = await u.paid.onToolResult(call, { jsonrpc: "2.0", id: 1, result: u.required() });
    expect(textOf((first as { result: unknown }).result)).toBe("paid");
    expect(u.sent).toHaveLength(1);
    const second: JsonRpcResponseLike = { jsonrpc: "2.0", id: 1, result: u.required() };
    const out = await u.paid.onToolResult(call, second);
    expect(out).toBe(second);
    expect(u.sent).toHaveLength(1);
    expect(readState(profile()).signed).toHaveLength(1);
  });

  it("a host cancel (notifications/cancelled) during the confirmation: nothing is signed", async () => {
    const u = await unit({
      confirmAbove: "0.10",
      elicit: async (calls) => {
        calls.cancel(1);
        return { action: "accept", content: {} };
      },
    });
    const call = u.calls.begin(1, "weather", prepareCallParams({ name: "weather", arguments: {} }))!;
    const out = await u.paid.onToolResult(call, { jsonrpc: "2.0", id: 1, result: u.required() });
    expect(textOf((out as { result: unknown }).result)).toBe("The payment was cancelled. Nothing was paid.");
    expect(u.sent).toEqual([]);
    expect(call.claimVoucher()).toBe(false);
  });

  it("an expired access token during binding refreshes (taking the profile lock) and does not deadlock", async () => {
    // The real refresh path: an expired access token in the keychain, a live refresh token, the
    // fake AS; `currentAccess` refreshes under the profile lock, which the binder must not hold.
    const as = new FakeAs();
    as.clock = Math.floor(Date.now() / 1000);
    await as.start();
    const realFetch = globalThis.fetch;
    globalThis.fetch = rerouteFetch(realFetch, as.port);
    try {
      const pair = as.seedGrant();
      const deployment = resolveDeployment({ url: `${E2E_MCP}/`, env: { ASSAY_MCP_DEV_ORIGINS: E2E_MCP }, devOrigins: [E2E_MCP], warn: () => {} });
      const tokens = new Keychain(new MemoryKeyring(), { profile: "default", environment: "e2e" });
      await withLock(profile(), (lock) => tokens.storeTokens(lock, { refreshToken: pair.refreshToken, accessToken: { token: pair.accessToken, expiresAt: Math.floor(Date.now() / 1000) - 10 } }));
      const ctx = { profile: profile(), deployment, keychain: tokens, lockOptions: { timeoutMs: 3_000 } };
      const u = await unit({ key: false, bound: false, bearer: () => currentAccess(ctx) });
      const call = u.calls.begin(1, "weather", prepareCallParams({ name: "weather", arguments: {} }))!;
      const started = Date.now();
      const out = await u.paid.onToolResult(call, { jsonrpc: "2.0", id: 1, result: u.required() });
      expect(Date.now() - started).toBeLessThan(2_500);
      const text = textOf((out as { result: unknown }).result);
      expect(text).toContain(`/agents/enable-paid?credential=${CREDENTIAL_ID}#key=`);
      expect(as.tokenCalls("refresh_token")).toHaveLength(1);
      // Every API request carried the refreshed token, never the expired one.
      expect(u.bearers.length).toBeGreaterThanOrEqual(2);
      for (const b of u.bearers) expect(b).not.toBe(pair.accessToken);
    } finally {
      globalThis.fetch = realFetch;
      await as.stop();
    }
  });

  it("2.9 m2: signing out during the bind network phase records nothing and creates no key afterwards", async () => {
    const u = await unit({ key: false, bound: false });
    fake.beforeChallenge = async () => {
      // The sign-out: it deletes the payment key under the profile lock.
      await withLock(profile(), (lock) => u.kc.delete(lock, "delegate_key"));
    };
    const call = u.calls.begin(1, "weather", prepareCallParams({ name: "weather", arguments: {} }))!;
    const out = await u.paid.onToolResult(call, { jsonrpc: "2.0", id: 1, result: u.required() });
    expect(textOf((out as { result: unknown }).result)).toContain("you signed out while the payment key was being bound");
    expect(await u.kc.get("delegate_key")).toBeNull();
    expect(readProfile(profile())?.delegateAddress ?? null).toBeNull();
    expect(u.sent).toEqual([]);
  });

  it("2.9 m1: three windows binding at once end with one key, no 'changed in another window' error", async () => {
    const u = await unit({ key: false, bound: false });
    const calls = [1, 2, 3].map((id) => u.calls.begin(id, "weather", prepareCallParams({ name: "weather", arguments: {} }))!);
    const outs = await Promise.all(calls.map((call, i) => u.paid.onToolResult(call, { jsonrpc: "2.0", id: i + 1, result: u.required() })));
    for (const out of outs) expect(textOf((out as { result: unknown }).result)).not.toContain("changed in another window");
    expect(await u.kc.get("delegate_key")).not.toBeNull();
  });

  it("hold 2 compare-and-set: a key replaced during the network phase is not recorded; the binding is redone for the new key", async () => {
    const u = await unit({ key: false, bound: false });
    let swapped = false;
    fake.beforeChallenge = async () => {
      if (swapped) return;
      swapped = true;
      const other = generatePrivateKey();
      await withLock(profile(), (lock) => u.kc.set(lock, "delegate_key", other));
    };
    const call = u.calls.begin(1, "weather", prepareCallParams({ name: "weather", arguments: {} }))!;
    const out = await u.paid.onToolResult(call, { jsonrpc: "2.0", id: 1, result: u.required() });
    const now = privateKeyToAccount((await u.kc.get("delegate_key")) as `0x${string}`).address;
    expect(fake.challenges).toHaveLength(2);
    expect(fake.delegate).toBe(now);
    expect(textOf((out as { result: unknown }).result)).toContain(`#key=${now}`);
  });
});
