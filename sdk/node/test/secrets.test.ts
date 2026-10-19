import { inspect } from "node:util";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtInDeployments } from "@assay-core/deployments.js";
import { API_KEY, FakeAssay, PAYER, type NetworkEntry } from "../../../node/test/helpers/fake-assay.js";
import { AssayClient, Signers } from "../src/index.js";

/**
 * R-SDK-7 and review I1: the private key and the API key never reach an error, a log line, a
 * return value, `JSON.stringify`, `util.inspect` or `String()`. Every output channel of a full
 * run (bind, paid call, refusals, bad input) is collected and searched for both.
 */

const E2E_MCP = "http://localhost:3200";
const NET_ID = "eip155:46630";
const BUILT_IN = builtInDeployments().e2e.networks[NET_ID]!;
const NETWORK: NetworkEntry = { id: NET_ID, escrow: BUILT_IN.escrow, asset: BUILT_IN.asset, decimals: BUILT_IN.decimals };
const RPC_ORIGINS = new Set(BUILT_IN.rpc.map((r) => new URL(r).origin));
const realFetch = globalThis.fetch;

let fake: FakeAssay;
const written: string[] = [];

beforeEach(async () => {
  fake = new FakeAssay(NETWORK);
  await fake.start();
  written.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const base = `http://127.0.0.1:${fake.port}`;
    if (u.origin === E2E_MCP || u.origin === "http://localhost:3000") return realFetch(`${base}${u.pathname}${u.search}`, init);
    if (RPC_ORIGINS.has(u.origin)) return realFetch(`${base}/__rpc`, init);
    throw new TypeError("no network in tests");
  }) as typeof fetch);
  // Every log channel: stdout, stderr and console.
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
  }
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void written.push(args.map((a) => inspect(a)).join(" ")));
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fake.stop();
});

/** Every form a value can be shown or serialised in. */
function shown(value: unknown): string[] {
  const out = [inspect(value, { depth: 10 }), inspect(value, { depth: 10, showHidden: true, getters: true }), String(value)];
  try {
    out.push(JSON.stringify(value) ?? "");
  } catch {
    // not serialisable: the other forms are checked
  }
  if (value instanceof Error) out.push(value.message, value.stack ?? "");
  return out;
}

function expectNoSecret(texts: string[], secrets: string[]): void {
  const forms = secrets.flatMap((s) => [s, s.toLowerCase(), s.toUpperCase(), s.replace(/^0x/, ""), s.replace(/^0x/, "").toLowerCase()]);
  for (const text of texts) for (const f of forms) expect(text.includes(f), `a secret appeared in: ${text.slice(0, 200)}`).toBe(false);
}

describe("secrets", () => {
  it("private key never in any thrown error, log or return value", async () => {
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    const seen: unknown[] = [];
    const attempt = async (fn: () => unknown) => {
      try {
        seen.push(await fn());
      } catch (err) {
        seen.push(err);
      }
    };

    const signer = Signers.fromPrivateKey(pk);
    seen.push(signer, { ...signer }, Object.keys(signer));
    // Bad keys: the error never echoes what was passed.
    await attempt(() => Signers.fromPrivateKey(`${pk}00` as Hex));
    await attempt(() => Signers.fromPrivateKey(pk.slice(0, 40) as Hex));
    await attempt(() => Signers.fromPrivateKey(pk.slice(2) as Hex));
    const generated = Signers.keygen();
    seen.push(generated);

    const client = new AssayClient({ url: `${E2E_MCP}/`, apiKey: API_KEY, dev: { origins: [E2E_MCP] }, signer, maxPerCall: "0.50", maxPerDay: "0.50" });
    seen.push(client);
    await client.connect();
    await attempt(() => client.callTool("weather")); // not bound yet: refused
    await attempt(() => client.bindDelegate());
    await attempt(() => client.bindDelegate());
    seen.push(client.enablePaidCallsUrl());
    fake.grant(address);
    await attempt(() => client.listTools());
    await attempt(() => client.callTool("weather")); // paid
    await attempt(() => client.callTool("weather")); // paid
    await attempt(() => client.callTool("weather")); // G7 per day
    fake.payer = address;
    await attempt(() => client.callTool("weather")); // signer is the payer
    fake.payer = PAYER;
    fake.bindAnswerDelegate = PAYER;
    fake.delegate = null;
    await attempt(() => client.bindDelegate()); // refused bind
    seen.push(client);
    await client.close();

    expect(fake.accepted).toHaveLength(2);
    expect(seen.some((v) => v instanceof Error)).toBe(true);
    expectNoSecret([...seen.flatMap(shown), ...written], [pk, generated.privateKey]);
    // The generated key is readable on purpose, and only by name.
    expect(getAddress(privateKeyToAccount(generated.privateKey).address)).toBe(generated.address);
    expect(JSON.parse(JSON.stringify(generated))).toEqual({ address: generated.address });
  });

  it("inspect, JSON and String of the client never contain the API key or the private key", async () => {
    const pk = generatePrivateKey();
    const kinds = [
      new AssayClient({ url: "https://mcp.assay.ai/", apiKey: API_KEY }),
      new AssayClient({ url: "https://mcp.assay.ai/", apiKey: API_KEY, signer: Signers.fromPrivateKey(pk), maxPerCall: "0.5", maxPerDay: "5" }),
    ];
    for (const c of kinds) {
      const texts = [...shown(c), ...shown({ wrapped: c }), ...shown([c]), `${c}`, inspect(c, { showHidden: true, depth: Infinity, getters: true })];
      expectNoSecret(texts, [API_KEY, pk]);
      expect(Object.keys(c)).toEqual([]);
    }
    expect(JSON.parse(JSON.stringify(kinds[1]))).toEqual({ url: "https://mcp.assay.ai/", signer: { kind: "privateKey", address: privateKeyToAccount(pk).address } });
  });

  it("the signer's secret is not reachable from the Signer object", () => {
    const pk = generatePrivateKey();
    const signer = Signers.fromPrivateKey(pk);
    const props = Reflect.ownKeys(signer).map(String);
    expect(props).toEqual(["kind"]);
    expect(Object.isFrozen(signer)).toBe(true);
    expectNoSecret(shown(signer), [pk]);
  });
});
