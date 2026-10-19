import { getAddress, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount, toAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtInDeployments } from "@assay-core/deployments.js";
import { API_KEY, CREDENTIAL_ID, FakeAssay, PAYER, type NetworkEntry } from "../../../node/test/helpers/fake-assay.js";
import { AssayClient, AssayConfigError, Signers, type AssayClientOptions, type Signer } from "../src/index.js";

/**
 * Task 4.2: paid calls through the SDK against the proxy tests' fake Assay (MCP + API + chain),
 * whose voucher check follows the backend's. The e2e origins and RPC are rerouted at `fetch`,
 * after `pinnedFetch`'s checks. No real network, keychain or profile.
 */

const E2E_MCP = "http://localhost:3200";
const E2E_API = "http://localhost:3000";
const NET_ID = "eip155:46630";
const E2E = builtInDeployments().e2e;
const BUILT_IN = E2E.networks[NET_ID]!;
const NETWORK: NetworkEntry = { id: NET_ID, escrow: BUILT_IN.escrow, asset: BUILT_IN.asset, decimals: BUILT_IN.decimals };
const RPC_ORIGINS = new Set(BUILT_IN.rpc.map((r) => new URL(r).origin));
const realFetch = globalThis.fetch;

let fake: FakeAssay;
const clients: AssayClient[] = [];

beforeEach(async () => {
  fake = new FakeAssay(NETWORK);
  await fake.start();
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const base = `http://127.0.0.1:${fake.port}`;
    if (u.origin === E2E_MCP || u.origin === E2E_API) return realFetch(`${base}${u.pathname}${u.search}`, init);
    if (RPC_ORIGINS.has(u.origin)) return realFetch(`${base}/__rpc`, init);
    throw new TypeError(`no network in tests: ${u.origin}`);
  }) as typeof fetch);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  vi.restoreAllMocks();
  await fake.stop();
});

/** A KMS stand-in: a viem custom account whose `signTypedData` is a spy over a local key; `delayMs` makes it slow like a real KMS. */
function kms(pk: Hex = generatePrivateKey(), delayMs = 0) {
  const local = privateKeyToAccount(pk);
  const signTypedData = vi.fn(async (params: Parameters<LocalAccount["signTypedData"]>[0]) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return local.signTypedData(params);
  });
  const account = toAccount({
    address: local.address,
    signMessage: () => Promise.reject(new Error("not used")),
    signTransaction: () => Promise.reject(new Error("not used")),
    signTypedData: signTypedData as unknown as LocalAccount["signTypedData"],
  });
  return { account, signTypedData, address: local.address, signer: Signers.fromAccount(account) };
}

async function make(signer: Signer | undefined, extra: Partial<AssayClientOptions> = {}): Promise<AssayClient> {
  const client = new AssayClient({
    url: `${E2E_MCP}/`,
    apiKey: API_KEY,
    dev: { origins: [E2E_MCP] },
    ...(signer ? { signer, maxPerCall: "0.50", maxPerDay: "5" } : {}),
    ...extra,
  });
  clients.push(client);
  await client.connect();
  return client;
}

/** Paid calls on: the key bound to the credential and an active grant from `PAYER` on chain. */
function enable(address: string): void {
  fake.delegate = getAddress(address);
  fake.grant(address);
}

const voucherSigns = (spy: ReturnType<typeof kms>["signTypedData"]) => spy.mock.calls.filter(([p]) => p.primaryType === "Voucher").length;

describe("constructor", () => {
  it("signer set without maxPerCall or maxPerDay → throws", () => {
    const signer = Signers.fromPrivateKey(generatePrivateKey());
    const base = { url: "https://mcp.assay.ai/", apiKey: API_KEY, signer };
    expect(() => new AssayClient(base)).toThrow(/maxPerCall/);
    expect(() => new AssayClient({ ...base, maxPerCall: "0.50" })).toThrow(/maxPerDay/);
    expect(() => new AssayClient({ ...base, maxPerDay: "5" })).toThrow(/maxPerCall/);
    expect(() => new AssayClient({ ...base, maxPerCall: "0", maxPerDay: "5" })).toThrow(/maxPerCall/);
    expect(() => new AssayClient({ ...base, maxPerCall: "1", maxPerDay: "0.5" })).toThrow(/above maxPerDay/);
    expect(() => new AssayClient({ ...base, maxPerCall: "0.50", maxPerDay: "5" })).not.toThrow();
  });

  it("a signer must come from Signers", () => {
    const fakeSigner = { kind: "account", address: PAYER } as unknown as Signer;
    expect(() => new AssayClient({ url: "https://mcp.assay.ai/", apiKey: API_KEY, signer: fakeSigner, maxPerCall: "0.5", maxPerDay: "5" })).toThrow(AssayConfigError);
  });

  it("urls must be on the same deployment", () => {
    const signer = Signers.fromPrivateKey(generatePrivateKey());
    expect(
      () => new AssayClient({ url: `${E2E_MCP}/`, apiKey: API_KEY, dev: { origins: [E2E_MCP] }, signer, maxPerCall: "0.5", maxPerDay: "5", urls: ["https://mcp.assay.ai/"] }),
    ).toThrow(/same Assay deployment/);
  });
});

describe("bindDelegate and enablePaidCallsUrl", () => {
  it("binds through the checked challenge, and is idempotent", async () => {
    const k = kms();
    const client = await make(k.signer);
    expect(() => client.enablePaidCallsUrl()).toThrow(/bindDelegate/);
    expect(await client.bindDelegate()).toEqual({ credentialId: CREDENTIAL_ID, delegate: k.address, alreadyBound: false });
    expect(fake.delegate).toBe(k.address);
    expect(fake.challenges).toEqual([k.address]);
    expect(await client.bindDelegate()).toEqual({ credentialId: CREDENTIAL_ID, delegate: k.address, alreadyBound: true });
    expect(fake.challenges).toHaveLength(1);
    expect(k.signTypedData).toHaveBeenCalledTimes(1);
  });

  it("the link carries the key in the #key= fragment only", async () => {
    const k = kms();
    const client = await make(k.signer);
    await client.bindDelegate();
    const link = client.enablePaidCallsUrl();
    expect(link).toBe(`${E2E.web}/agents/enable-paid?credential=${CREDENTIAL_ID}#key=${k.address}`);
    const u = new URL(link);
    expect([...u.searchParams.keys()]).toEqual(["credential"]);
    expect(u.search).not.toContain(k.address.slice(2).toLowerCase());
    expect(u.hash).toBe(`#key=${k.address}`);
  });

  it("a bind answer naming another key is refused", async () => {
    const k = kms();
    fake.bindAnswerDelegate = PAYER;
    const client = await make(k.signer);
    await expect(client.bindDelegate()).rejects.toThrow("Assay did not accept the payment key");
    expect(() => client.enablePaidCallsUrl()).toThrow(/bindDelegate/);
  });

  it("without a signer, bindDelegate throws", async () => {
    const client = await make(undefined);
    await expect(client.bindDelegate()).rejects.toThrow(/signer/);
  });
});

describe("paid calls", () => {
  it("fromAccount path signs through account.signTypedData (a KMS stub)", async () => {
    const k = kms();
    const client = await make(k.signer);
    await client.bindDelegate();
    fake.grant(k.address);
    const r = await client.callTool("weather", { city: "Lisbon" });
    expect(r.ok).toBe(true);
    expect(r.receipt).toBeDefined();
    expect(fake.accepted).toHaveLength(1);
    expect(fake.rejected).toEqual([]);
    const kinds = k.signTypedData.mock.calls.map(([p]) => p.primaryType);
    expect(kinds).toEqual(["DelegateBinding", "Voucher"]);
    // The voucher it signed is the one the server verified, for the escrow of the built-in table.
    const voucher = k.signTypedData.mock.calls[1]![0] as { domain: { verifyingContract: string; chainId: number } };
    expect(voucher.domain.verifyingContract).toBe(getAddress(BUILT_IN.escrow.split(":").pop()!));
    expect(voucher.domain.chainId).toBe(46630);
    // Same idempotency key on the paid retry.
    const weather = fake.calls.filter((c) => c.name === "weather");
    expect(weather).toHaveLength(2);
    expect(weather[1]!.meta["assay/idempotency-key"]).toBe(weather[0]!.meta["assay/idempotency-key"]);
  });

  it("signs the exact amount, payee and asset that were checked", async () => {
    const k = kms();
    enable(k.address);
    const client = await make(k.signer);
    await client.callTool("weather");
    const sent = fake.calls.find((c) => c.meta["assay/voucher"] !== undefined)!.meta["assay/voucher"] as { voucher: Record<string, unknown> };
    expect(sent.voucher.payTo).toBe(BUILT_IN.escrow);
    expect(sent.voucher.amount).toEqual({ amount: String(fake.price), asset: BUILT_IN.asset, decimals: BUILT_IN.decimals });
    const typed = k.signTypedData.mock.calls[0]![0] as unknown as { message: { amount: bigint } };
    expect(typed.message.amount).toBe(fake.price);
  });

  it("signer address === payer (from chain read) → refused, nothing read or signed", async () => {
    const k = kms();
    fake.payer = k.address;
    enable(k.address);
    const client = await make(k.signer);
    const r = await client.callTool("weather");
    expect(r.ok).toBe(false);
    expect(r.refused).toEqual({ guard: "G5", reason: "the signer is the payer; use a dedicated payment key" });
    expect(k.signTypedData).not.toHaveBeenCalled();
    expect(fake.rpcCalls).toEqual([]);
    expect(fake.accepted).toEqual([]);
  });

  it("maxPerCall is enforced (G7) before signing", async () => {
    const k = kms();
    enable(k.address);
    const client = await make(k.signer, { maxPerCall: "0.10" });
    const r = await client.callTool("weather");
    expect(r.refused?.guard).toBe("G7");
    expect(r.refused?.reason).toBe("the amount is above the local limit per call");
    expect(k.signTypedData).not.toHaveBeenCalled();
    expect(fake.accepted).toEqual([]);
  });

  it("maxPerDay is enforced across calls and across clients with the same key", async () => {
    const pk = generatePrivateKey();
    const a = kms(pk);
    const b = kms(pk);
    enable(a.address);
    const c1 = await make(a.signer, { maxPerDay: "0.75" });
    const c2 = await make(b.signer, { maxPerDay: "0.75" });
    expect((await c1.callTool("weather")).ok).toBe(true);
    expect((await c2.callTool("weather")).ok).toBe(true);
    expect((await c1.callTool("weather")).ok).toBe(true);
    const fourth = await c2.callTool("weather");
    expect(fourth.refused).toEqual({ guard: "G7", reason: "the amount would pass the local limit per 24 hours" });
    expect(fake.accepted).toHaveLength(3);
    expect(voucherSigns(a.signTypedData) + voucherSigns(b.signTypedData)).toBe(3);
  });

  it("concurrent calls never pass maxPerDay together, even with a slow signer", async () => {
    // A slow KMS opens the window between the guards and the signature: the spend must be recorded before it.
    const k = kms(generatePrivateKey(), 200);
    enable(k.address);
    const client = await make(k.signer, { maxPerDay: "1" });
    const results = await Promise.all(Array.from({ length: 6 }, () => client.callTool("weather")));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(results.filter((r) => r.refused?.guard === "G7")).toHaveLength(2);
    expect(voucherSigns(k.signTypedData)).toBe(4);
  });

  it("a guard refusal signs nothing (G3: amount above the quote)", async () => {
    const k = kms();
    enable(k.address);
    fake.maxAmount = fake.price - 1n;
    const client = await make(k.signer);
    const r = await client.callTool("weather");
    expect(r.refused?.guard).toBe("G3");
    expect(r.content).toEqual([{ type: "text", text: "Assay asked for a payment this app refused: the amount is above the quoted price." }]);
    expect(k.signTypedData).not.toHaveBeenCalled();
  });

  it("payTo other than the built-in escrow → G2, nothing signed", async () => {
    const k = kms();
    enable(k.address);
    fake.payToOverride = `${NET_ID}:${PAYER}`;
    const client = await make(k.signer);
    expect((await client.callTool("weather")).refused?.guard).toBe("G2");
    expect(k.signTypedData).not.toHaveBeenCalled();
  });

  it("no active grant on chain → G4, nothing signed", async () => {
    const k = kms();
    fake.delegate = k.address;
    const client = await make(k.signer);
    expect((await client.callTool("weather")).refused?.guard).toBe("G4");
    expect(k.signTypedData).not.toHaveBeenCalled();
  });

  it("a key not bound to this API key is refused with the next step", async () => {
    const k = kms();
    const client = await make(k.signer);
    const r = await client.callTool("weather");
    expect(r.refused?.guard).toBe("G5");
    expect(r.refused?.reason).toMatch(/bindDelegate\(\).*enablePaidCallsUrl\(\)/);
    expect(k.signTypedData).not.toHaveBeenCalled();
  });

  it("G11 is the urls allow list", async () => {
    const k = kms();
    enable(k.address);
    const client = await make(k.signer, { urls: [`${E2E_MCP}/?tools=echo`] });
    expect((await client.callTool("weather")).refused).toEqual({ guard: "G11", reason: "paid calls through this server are off" });
    expect(k.signTypedData).not.toHaveBeenCalled();
    const allowed = await make(k.signer, { urls: [`${E2E_MCP}`] });
    expect((await allowed.callTool("weather")).ok).toBe(true);
  });

  it("a second PAYMENT_REQUIRED after signing is returned, with no second voucher", async () => {
    const k = kms();
    enable(k.address);
    fake.repeatPaymentRequired = true;
    const client = await make(k.signer);
    const r = await client.callTool("weather");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("PAYMENT_REQUIRED");
    expect(voucherSigns(k.signTypedData)).toBe(1);
    expect(fake.calls.filter((c) => c.name === "weather")).toHaveLength(2);
  });

  it("without a signer, a paid tool is ok:false and nothing is signed", async () => {
    const client = await make(undefined);
    const r = await client.callTool("weather");
    expect(r).toMatchObject({ ok: false, error: { code: "PAYMENT_REQUIRED" } });
    expect(fake.calls.filter((c) => c.name === "weather")).toHaveLength(1);
  });

  it("debt: the answer with the funding link, and no /escrow request ever", async () => {
    const k = kms();
    enable(k.address);
    const client = await make(k.signer);
    const r = await client.callTool("owe");
    expect(r.ok).toBe(false);
    expect((r.content[0] as { text: string }).text).toBe(`An unpaid call must be settled first. Settle it at ${E2E.web}/funding`);
    await client.callTool("weather");
    expect(fake.paths.some((p) => p.includes("/escrow"))).toBe(false);
  });

  it("call_tool pays for the inner tool", async () => {
    const k = kms();
    enable(k.address);
    const client = await make(k.signer);
    const r = await client.callTool("call_tool", { name: "weather", arguments: { city: "Lisbon" } });
    expect(r.ok).toBe(true);
    expect(fake.accepted).toHaveLength(1);
  });

  it("the quote comes from listTools, else from get_tool just before signing", async () => {
    const k = kms();
    enable(k.address);
    const listed = await make(k.signer);
    await listed.listTools();
    await listed.callTool("weather");
    expect(fake.calls.filter((c) => c.name === "get_tool")).toHaveLength(0);
    const fresh = await make(k.signer);
    await fresh.callTool("weather");
    expect(fake.calls.filter((c) => c.name === "get_tool")).toHaveLength(1);
    expect(fake.accepted).toHaveLength(2);
  });
});
