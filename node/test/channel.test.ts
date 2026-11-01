import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChannelVoucher,
  CHANNEL_DEBT_RENEWED_TEXT,
  CHANNEL_DEBT_RETRY_TEXT,
  channelDebtNoRecordText,
  OTHER_WALLET_DEBT_TEXT,
  channelKey,
  DEBT_COLLECTING_TEXT,
  parseBook,
  type ChannelBook,
} from "@goassay-ai/sdk/core";
import { getAddress, recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChainReader, ChannelResult, DelegationResult } from "../src/chain/reads.js";
import { builtInDeployments } from "../src/deployments.js";
import { QuoteCache } from "../src/guards/quote-cache.js";
import { addDevOrigin } from "../src/profile/dev-origins.js";
import { resolveDeployment } from "../src/profile/deployments.js";
import { Keychain } from "../src/profile/keychain.js";
import { withLock } from "../src/profile/lock.js";
import { addPaidUrl, createProfile, readProfile, readState } from "../src/profile/profile.js";
import { CallRegistry } from "../src/proxy/calls.js";
import { CHANNEL_RETRY_TEXT, unsettledText } from "../src/proxy/channel-lane.js";
import { prepareCallParams } from "../src/proxy/meta.js";
import { PaidPath, type PaidHost } from "../src/proxy/paid.js";
import { MemoryKeyring } from "./helpers/memory-keyring.js";

/**
 * Channel vouchers in the proxy: the lane record in `state.json` under the profile lock, the
 * increase-only spend record, the chain check of a lane, and the answers to channel refusals.
 * A fake host and chain reader; real profile files. Nothing leaves the process.
 */

const E2E_MCP = "http://localhost:3200";
const NET_ID = "eip155:46630";
const NET = builtInDeployments().e2e.networks[NET_ID]!;
const ESCROW = NET.escrow.split(":")[2]!;
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PROVIDER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const PROVIDER_ID = "00000000-0000-4000-8000-000000000001";
const PRICE = "100000";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "assay-mcp-channel-"));
  addDevOrigin(dir, E2E_MCP);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const profile = () => ({ dir, name: "default" });
const caip = (a: string) => `${NET_ID}:${getAddress(a)}`;

function requirement(delegate: string): Record<string, unknown> {
  return {
    rail: "B",
    scheme: "voucher",
    network: NET_ID,
    payer: caip(PAYER),
    payTo: NET.escrow,
    provider: caip(PROVIDER),
    providerId: PROVIDER_ID,
    amount: { amount: PRICE, asset: NET.asset, decimals: NET.decimals },
    resource: "/mcp/tools/weather",
    requestHash: `sha256:${"ab".repeat(32)}`,
    seq: "7",
    maxTimeoutSeconds: 300,
    signers: ["payer", "delegate"],
    delegate: caip(delegate),
  };
}

function offer(delegate: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "channel-v1",
    network: NET_ID,
    payer: caip(PAYER),
    provider: caip(PROVIDER),
    providerId: PROVIDER_ID,
    price: { amount: PRICE, asset: NET.asset, decimals: NET.decimals },
    contractVersion: 3,
    domain: { name: "Assay Settlement", version: "2", chainId: 46630, verifyingContract: ESCROW },
    primaryType: "ChannelVoucher",
    minLifeSeconds: 60,
    maxLifeSeconds: 300,
    maxOpenChannels: 16,
    signers: ["payer", "delegate"],
    delegate: caip(delegate),
    ...extra,
  };
}

const paymentRequired = (delegate: string, o?: Record<string, unknown> | null) => ({
  isError: true,
  content: [{ type: "text", text: "paid" }],
  _meta: {
    "assay/error": { code: "PAYMENT_REQUIRED", retryable: true },
    "x402/paymentRequired": requirement(delegate),
    ...(o === null ? {} : { "assay/channelRequired": o ?? offer(delegate) }),
  },
});

const refusal = (code: string, extra: Record<string, unknown> = {}) => ({
  isError: true,
  content: [{ type: "text", text: code }],
  _meta: { "assay/error": { code, retryable: true, ...extra } },
});

type Envelope = { voucher: { channelId: Hex; cumulative: string; calls: number; issuedAt: number; expiresAt: number; payer: Hex; provider: Hex }; signature: Hex };

interface Setup {
  answer?: (meta: Record<string, unknown>, n: number) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  channelState?: (key: string) => bigint | null;
  pk?: Hex;
  now?: { t: number };
  /** The API (`fetch`); default: none (a request fails the test). */
  api?: (url: string, init: { method?: string; body?: unknown }) => { status: number; body: unknown };
  noPaid?: boolean;
  /** The n-th channel resend gets a JSON-RPC error (no `result`). */
  rpcErrorAt?: number;
}

/** Paid calls on, in a real profile; a fake host and chain. `sent` holds every paid retry's `_meta`. */
async function unit(o: Setup = {}) {
  const pk = o.pk ?? generatePrivateKey();
  const address = privateKeyToAccount(pk).address;
  const clock = o.now ?? { t: Date.now() };
  const kc = new Keychain(new MemoryKeyring(), { profile: "default", environment: "e2e" });
  await withLock(profile(), async (lock) => {
    if (readProfile(profile()) === null) {
      createProfile(profile(), lock, { environment: "e2e", credentialId: "5b8f3c1e-2a4d-4e6f-9a1b-3c5d7e9f0a2b", agentLabel: "agent", createdAt: new Date().toISOString(), delegateAddress: address, network: NET_ID });
      addPaidUrl(profile(), lock, "/");
    }
    await kc.set(lock, "delegate_key", pk);
  });
  const deployment = resolveDeployment({ url: `${E2E_MCP}/`, env: { ASSAY_MCP_DEV_ORIGINS: E2E_MCP }, devOrigins: [E2E_MCP], warn: () => {} });
  const calls = new CallRegistry(() => clock.t);
  const sent: Record<string, unknown>[] = [];
  const channelReads: string[] = [];
  const delegation = (delegate: string): DelegationResult => ({
    ok: true,
    value: {
      payer: PAYER,
      delegate,
      active: true,
      validUntil: String(Math.floor(clock.t / 1000) + 86400),
      maxVoucherAmount: "1000000",
      maxPerWindow: "10000000",
      delegateMaxVoucherAmount: "500000",
      delegateMaxPerWindow: "5000000",
      readAt: Math.floor(clock.t / 1000),
    },
  });
  const chain: ChainReader = {
    readDelegation: async (_n, _p, d) => delegation(d),
    invalidate: () => {},
    clear: () => {},
    readChannel: async (_n, key): Promise<ChannelResult> => {
      channelReads.push(key);
      const state = o.channelState ? o.channelState(key) : 0n;
      return state === null ? { ok: false, code: "CHAIN_UNCONFIRMED", reason: "test" } : { ok: true, state };
    },
  };
  let n = 0;
  let k = 0;
  const host: PaidHost = {
    calls,
    resend: async (_c, params) => {
      const meta = params._meta as Record<string, unknown>;
      sent.push(meta);
      if (meta["assay/channelVoucher"] && o.rpcErrorAt === k++) {
        return { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "internal error" } };
      }
      const out = meta["assay/channelVoucher"] ? await o.answer?.(meta, n++) : undefined;
      return { jsonrpc: "2.0", id: 1, result: out ?? { content: [{ type: "text", text: "paid" }], _meta: { "assay/receipt": { intentId: "i" } } } };
    },
    getTool: async () => ({ jsonrpc: "2.0", id: "g", result: {} }),
    canElicit: () => false,
    elicit: async () => null,
    bearer: async () => "assay_sk_live_TESTONLY",
    dateOffset: () => 0,
  };
  const quotes = new QuoteCache(() => clock.t);
  quotes.set("weather", { maxAmount: "250000", asset: NET.asset });
  const paid = new PaidPath(
    {
      deployment,
      profile: profile(),
      keychain: kc,
      noPaid: o.noPaid ?? false,
      chain,
      quotes,
      fetch: async (url: string, init: { method?: string; body?: unknown }) => {
        if (!o.api) throw new Error("no API in this test");
        const a = o.api(url, init);
        return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
      },
      openBrowser: async () => true,
      stderr: () => {},
      now: () => clock.t,
      lockOptions: { timeoutMs: 3_000 },
      channelNetworks: [NET_ID],
    },
    host,
  );
  let id = 0;
  /** One host call answered with `first` (default: PAYMENT_REQUIRED with a channel offer). */
  const call = async (first?: Record<string, unknown>) => {
    const c = calls.begin(++id, "weather", prepareCallParams({ name: "weather", arguments: {}, _meta: paid.callMeta() }))!;
    try {
      const out = await paid.onToolResult(c, { jsonrpc: "2.0", id, result: first ?? paymentRequired(address) });
      return (out as { result: Record<string, unknown> }).result;
    } finally {
      calls.end(c);
    }
  };
  const channelSent = () => sent.map((m) => m["assay/channelVoucher"] as Envelope | undefined).filter((e): e is Envelope => e !== undefined);
  const pairs = () => channelSent().map((e) => [e.voucher.cumulative, e.voucher.calls]);
  /** Moves the clock; the G3 quote is seen again (a quote is kept 60 s). */
  const advance = (ms: number) => {
    clock.t += ms;
    quotes.set("weather", { maxAmount: "250000", asset: NET.asset });
  };
  return { paid, call, sent, channelSent, pairs, address, clock, pk, channelReads, advance };
}

const textOf = (r: Record<string, unknown>) => (r.content as { text: string }[])[0]!.text;
const book = (): ChannelBook => readState(profile()).channels ?? { version: 1, lanes: [] };

describe("proxy: channel lane", () => {
  it("offers channel-v1 on calls only for a channel-capable network, never with --no-paid", async () => {
    const u = await unit();
    expect(u.paid.callMeta()).toEqual({ "assay/paymentSchemes": ["channel-v1", "voucher"] });
    const off = new PaidPath({ ...(u.paid as unknown as { o: object }).o, channelNetworks: [] } as never, {} as never);
    expect(off.callMeta()).toEqual({});
    const noPaid = new PaidPath({ ...(u.paid as unknown as { o: object }).o, noPaid: true } as never, {} as never);
    expect(noPaid.callMeta()).toEqual({});
  });

  it("signs the contract's ChannelVoucher from state.json: price, then total + price; spend counts increases", async () => {
    const u = await unit();
    expect(textOf(await u.call())).toBe("paid");
    expect(textOf(await u.call())).toBe("paid");
    expect(u.pairs()).toEqual([
      ["100000", 1],
      ["200000", 2],
    ]);
    const [a, b] = u.channelSent();
    expect(a!.voucher.channelId).toBe(b!.voucher.channelId);
    const lane = book().lanes[0]!;
    expect(lane).toMatchObject({ maxSigned: "200000", callsSigned: 2, inFlightSince: null, retired: false });
    expect(readState(profile()).signed.map((e) => e.amount)).toEqual([PRICE, PRICE]);
    const net = { id: NET_ID, chainId: 46630, escrow: getAddress(ESCROW), asset: NET.asset, decimals: NET.decimals };
    const { typedData } = buildChannelVoucher(lane, { ...b!.voucher, cumulative: BigInt(b!.voucher.cumulative) }, net);
    expect(await recoverTypedDataAddress({ ...typedData, signature: b!.signature })).toBe(u.address);
  });

  it("ignores any cumulative the server names", async () => {
    const u = await unit();
    const address = u.address;
    await u.call(paymentRequired(address, offer(address, { cumulative: "4000000", calls: 40 })));
    expect(u.pairs()).toEqual([["100000", 1]]);
  });

  it("an offer for another escrow is never signed: the call is paid per call", async () => {
    const u = await unit();
    const other = { ...(offer(u.address).domain as object), verifyingContract: "0x1111111111111111111111111111111111111111" };
    await u.call(paymentRequired(u.address, offer(u.address, { domain: other })));
    expect(u.channelSent()).toEqual([]);
    expect(u.sent[0]!["assay/voucher"]).toBeDefined();
  });

  it("PAYMENT_UNSETTLED_LIMIT: the agent reads the wait; the same pair is signed again, and counted once", async () => {
    const u = await unit({ answer: (_m, n) => (n === 0 ? refusal("PAYMENT_UNSETTLED_LIMIT", { retryAfter: 1500 }) : undefined) });
    const r = await u.call();
    expect(textOf(r)).toBe("Waiting for earlier payments to settle on chain; retry in about 25 minutes. Nothing was charged.");
    expect(r.isError).toBe(true);
    await u.call();
    expect(u.pairs()).toEqual([
      ["100000", 1],
      ["100000", 1],
    ]);
    expect(readState(profile()).signed.map((e) => e.amount)).toEqual([PRICE]);
    expect(unsettledText(30)).toBe("Waiting for earlier payments to settle on chain; retry in about 1 minute. Nothing was charged.");
  });

  it("PAYMENT_UNSETTLED_LIMIT on the unsigned call: the same text, nothing signed", async () => {
    const u = await unit();
    const r = await u.call(refusal("PAYMENT_UNSETTLED_LIMIT", { retryAfter: 120 }));
    expect(textOf(r)).toBe("Waiting for earlier payments to settle on chain; retry in about 2 minutes. Nothing was charged.");
    expect(u.sent).toEqual([]);
  });

  it("CHANNEL_ROTATE: one voucher for the call, a retry text; the next call opens a new lane", async () => {
    const u = await unit({ answer: (_m, n) => (n === 1 ? refusal("CHANNEL_ROTATE") : undefined) });
    await u.call();
    expect(textOf(await u.call())).toBe(CHANNEL_RETRY_TEXT);
    await u.call();
    const s = u.channelSent();
    expect(u.pairs()).toEqual([
      ["100000", 1],
      ["200000", 2],
      ["100000", 1],
    ]);
    expect(s[2]!.voucher.channelId).not.toBe(s[0]!.voucher.channelId);
    expect(book().lanes.find((l) => l.channelId === s[0]!.voucher.channelId)?.retired).toBe(true);
    expect(u.paid.callMeta()).not.toEqual({});
  });

  it("five rotations within an hour stop channel offers for an hour", async () => {
    const u = await unit({ answer: () => refusal("CHANNEL_ROTATE") });
    for (let i = 0; i < 5; i++) expect(textOf(await u.call())).toBe(CHANNEL_RETRY_TEXT);
    expect(u.paid.callMeta()).toEqual({});
    await u.call();
    expect(u.sent.at(-1)!["assay/voucher"]).toBeDefined();
    expect(u.channelSent()).toHaveLength(5);
  });

  it("a re-armed pair is not re-signed for free once its first signature can no longer settle", async () => {
    const clock = { t: Date.now() };
    const u = await unit({ now: clock, answer: (_m, n) => (n === 0 ? refusal("PAYMENT_UNSETTLED_LIMIT", { retryAfter: 900 }) : undefined) });
    await u.call();
    u.advance((240 + 7201) * 1000);
    await u.call();
    const s = u.channelSent();
    expect(s[1]!.voucher.channelId).not.toBe(s[0]!.voucher.channelId);
    expect(s[1]!.voucher).toMatchObject({ cumulative: "100000", calls: 1 });
    // The new lane's price is counted: both signatures are in the spend record.
    expect(readState(profile()).signed.map((e) => e.amount)).toEqual([PRICE, PRICE]);
  });

  it("CHANNEL_LIMIT: a retry text, channels paused for an hour (calls pay per call), the lane re-armed", async () => {
    const clock = { t: Date.now() };
    const u = await unit({ now: clock, answer: (_m, n) => (n === 0 ? refusal("CHANNEL_LIMIT", { retryAfter: 60 }) : undefined) });
    expect(textOf(await u.call())).toBe(CHANNEL_RETRY_TEXT);
    expect(u.paid.callMeta()).toEqual({});
    await u.call();
    expect(u.sent.at(-1)!["assay/voucher"]).toBeDefined();
    u.advance(3_601_000);
    await u.call();
    const s = u.channelSent();
    expect(u.pairs()).toEqual([
      ["100000", 1],
      ["100000", 1],
    ]);
    expect(s[1]!.voucher.channelId).toBe(s[0]!.voucher.channelId);
  });

  it("any other refusal retires the lane", async () => {
    const u = await unit({ answer: (_m, n) => (n === 0 ? refusal("CHANNEL_DESYNC") : undefined) });
    await u.call();
    await u.call();
    const s = u.channelSent();
    expect(u.pairs()).toEqual([
      ["100000", 1],
      ["100000", 1],
    ]);
    expect(s[1]!.voucher.channelId).not.toBe(s[0]!.voucher.channelId);
  });

  it("a lane not checked for 10 minutes is checked against channelBooks; one the chain shows more than is retired", async () => {
    const clock = { t: Date.now() };
    const settled = new Map<string, bigint>();
    const u = await unit({ now: clock, channelState: (k) => settled.get(k) ?? 0n });
    await u.call();
    const lane = book().lanes[0]!;
    const key = channelKey(lane.payer, lane.signer, lane.provider, lane.channelId);
    u.advance(601_000);
    settled.set(key, 100000n | (1n << 56n));
    await u.call();
    expect(u.channelReads).toEqual([key]);
    expect(u.pairs().at(-1)).toEqual(["200000", 2]);

    // A record behind the chain (a restored copy of state.json): retired, and a new lane opened.
    u.advance(601_000);
    settled.set(key, 500000n | (5n << 56n));
    await u.call();
    const last = u.channelSent().at(-1)!;
    expect(last.voucher.channelId).not.toBe(lane.channelId);
    expect(last.voucher).toMatchObject({ cumulative: "100000", calls: 1 });
    expect(book().lanes.find((l) => l.channelId === lane.channelId)?.retired).toBe(true);
  });

  it("no agreed chain read: the lane is left alone and the call is paid per call", async () => {
    const clock = { t: Date.now() };
    let fail = false;
    const u = await unit({ now: clock, channelState: () => (fail ? null : 0n) });
    await u.call();
    u.advance(601_000);
    fail = true;
    await u.call();
    expect(u.sent.at(-1)!["assay/voucher"]).toBeDefined();
    expect(book().lanes[0]).toMatchObject({ retired: false, maxSigned: "100000" });
  });

  it("a damaged lane record in state.json is never reset: paid calls stop (fail closed)", async () => {
    const u = await unit();
    await u.call();
    await withLock(profile(), async (lock) => {
      const { writePrivateFile } = await import("../src/profile/paths.js");
      const { profileFile } = await import("../src/profile/paths.js");
      writePrivateFile(dir, profileFile("default", "state"), JSON.stringify({ version: 1, signed: [], lastBrowserOpen: null, channels: { version: 1, lanes: [{ channelId: "0xzz" }] } }));
      lock.assertHeld();
    });
    const r = await u.call();
    expect(r.isError).toBe(true);
    expect(u.channelSent()).toHaveLength(1);
    expect(() => readState(profile())).toThrow(/state file: invalid channels/);
  });

  it("two hosts on one profile never sign conflicting totals", async () => {
    const h1 = await unit();
    const h2 = await unit({ pk: h1.pk });
    await Promise.all([h1.call(), h2.call(), h1.call(), h2.call(), h1.call(), h2.call()]);
    const all = [...h1.channelSent(), ...h2.channelSent()];
    expect(all).toHaveLength(6);
    expect(new Set(all.map((e) => `${e.voucher.channelId}:${e.voucher.cumulative}`)).size).toBe(6);
    // Each lane's totals are its own record's: 1, 2, 3 ... calls of the price, none twice.
    const lanes = parseBook(readState(profile()).channels).lanes;
    for (const lane of lanes) {
      const mine = all.filter((e) => e.voucher.channelId === lane.channelId).map((e) => e.voucher.calls).sort((x, y) => x - y);
      expect(mine).toEqual(Array.from({ length: lane.callsSigned }, (_v, i) => i + 1));
      expect(BigInt(lane.maxSigned)).toBe(BigInt(PRICE) * BigInt(lane.callsSigned));
    }
    expect(readState(profile()).signed).toHaveLength(6);
  });

  it("the server's open-channel cap is kept: a call while the only lane is busy is paid per call", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const u = await unit({ answer: async (_m, n) => (n === 0 ? (await gate, undefined) : undefined) });
    const one = offer(u.address, { maxOpenChannels: 1 });
    const first = u.call(paymentRequired(u.address, one));
    // Wait until the first voucher is out (its lane in flight), then call again.
    while (u.channelSent().length === 0) await new Promise((r) => setTimeout(r, 5));
    await u.call(paymentRequired(u.address, one));
    release();
    await first;
    expect(u.channelSent()).toHaveLength(1);
    expect(u.sent.filter((m) => m["assay/voucher"] !== undefined)).toHaveLength(1);
    expect(book().lanes).toHaveLength(1);
  });
});

// ---- channel-debt renew ----------------------------------------------------------------------

const DEBT_ID = "00000000-0000-4000-8000-000000000042";
const debtAnswer = () => ({
  isError: true,
  content: [{ type: "text", text: "An unpaid call must be settled first." }],
  _meta: { "assay/error": { code: "PAYMENT_DEBT_OUTSTANDING", retryable: false } },
});
const SETTLE_TEXT = "An unpaid call must be settled first. Settle it at http://localhost:4000/funding";

const NO_RECORD_TEXT = channelDebtNoRecordText("http://localhost:4000");

/** A CHANNEL debt on this profile's first lane (or `lane`), pair `(200000, 2)` unless `channel` says. */
const channelDebt = (over: Record<string, unknown> = {}, channel: Record<string, unknown> = {}) => ({
  intentId: DEBT_ID,
  payer: caip(PAYER),
  state: "OPEN",
  voucherFormat: "CHANNEL",
  channel: { cumulative: "200000", calls: 2, channelId: book().lanes[0]?.channelId, ...channel },
  ...over,
});

/** The API of a payer with one debt: `GET /escrow/debts`, and the renew route (201 unless `post` says). */
function debtApi(o: { debts?: () => unknown[]; post?: () => { status: number; body: unknown } } = {}) {
  const requests: { method: string; url: string; body: unknown }[] = [];
  let debts = o.debts ?? (() => [channelDebt()]);
  const api = (url: string, init: { method?: string; body?: unknown }) => {
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ method: init.method ?? "GET", url, body });
    if (url.endsWith("/escrow/debts")) return { status: 200, body: { success: true, data: { account: caip(PAYER), debts: debts() } } };
    if (/\/escrow\/debts\/[0-9a-f-]+\/voucher$/.test(url)) return o.post?.() ?? { status: 201, body: { success: true, data: { status: "REPLACING" } } };
    return { status: 404, body: { success: false, error: { code: "NOT_FOUND" } } };
  };
  const posts = () => requests.filter((r) => r.method === "POST");
  return { api, requests, posts, setDebts: (d: () => unknown[]) => (debts = d) };
}

describe("proxy: channel debt renew", () => {
  it("renews the debt's pair on the lane it names, once, and the agent reads that it is being collected", async () => {
    const d = debtApi();
    const u = await unit({ api: d.api });
    for (let i = 0; i < 3; i++) await u.call();
    const spent = readState(profile()).signed.length;
    const r = await u.call(debtAnswer());
    expect(textOf(r)).toBe(CHANNEL_DEBT_RENEWED_TEXT);
    expect(r.isError).toBe(true);
    expect(d.posts()).toHaveLength(1);
    const post = d.posts()[0]!;
    expect(post.url).toBe(`http://localhost:3000/api/v1/escrow/debts/${DEBT_ID}/voucher`);
    const env = (post.body as { channelVoucher: Envelope }).channelVoucher;
    const lane = book().lanes[0]!;
    expect(env.voucher).toMatchObject({ cumulative: "200000", calls: 2, payer: getAddress(PAYER), channelId: lane.channelId });
    expect(env.voucher.expiresAt - env.voucher.issuedAt).toBe(240);
    const net = { id: NET_ID, chainId: 46630, escrow: getAddress(ESCROW), asset: NET.asset, decimals: NET.decimals };
    const { typedData } = buildChannelVoucher(lane, { ...env.voucher, cumulative: 200_000n }, net);
    expect(await recoverTypedDataAddress({ ...typedData, signature: env.signature })).toBe(u.address);
    // Not counted again as a spend, and the lane's totals do not move.
    expect(readState(profile()).signed).toHaveLength(spent);
    expect(lane).toMatchObject({ maxSigned: "300000", callsSigned: 3, renewedIssuedAt: env.voucher.issuedAt });
    // Within a minute the next refusal only lists (no second signature): still being collected,
    // whether the debt is REPLACING now or still listed OPEN.
    for (const state of ["REPLACING", "OPEN"]) {
      d.setDebts(() => [channelDebt({ state })]);
      const lists = d.requests.length;
      expect(textOf(await u.call(debtAnswer()))).toBe(CHANNEL_DEBT_RENEWED_TEXT);
      expect(d.requests.length).toBe(lists + 1);
    }
    expect(d.posts()).toHaveLength(1);
  });

  it("never signs a larger or unsigned pair, another lane, or a debt naming no lane: the no-record text", async () => {
    for (const channel of [
      { cumulative: "400000", calls: 4 },
      { cumulative: "150000", calls: 2 },
      { channelId: `0x${"ab".repeat(32)}` },
      { channelId: undefined },
    ]) {
      const d = debtApi({ debts: () => [channelDebt({}, channel)] });
      const u = await unit({ api: d.api });
      for (let i = 0; i < 3; i++) await u.call();
      const signed = book().lanes[0]!;
      expect(textOf(await u.call(debtAnswer()))).toBe(NO_RECORD_TEXT);
      expect(d.posts()).toEqual([]);
      expect(book().lanes[0]).toEqual(signed);
      rmSync(join(dir, "default"), { recursive: true, force: true });
    }
  });

  it("a pair the server refused (CHANNEL_DESYNC) is never renewed", async () => {
    const desync = () => ({ isError: true, content: [{ type: "text", text: "x" }], _meta: { "assay/error": { code: "CHANNEL_DESYNC", retryable: false } } });
    const d = debtApi({ debts: () => [channelDebt({}, { cumulative: "300000", calls: 3 })] });
    const u = await unit({ api: d.api, answer: (_m, n) => (n === 2 ? desync() : undefined) });
    for (let i = 0; i < 3; i++) await u.call();
    expect(book().lanes[0]).toMatchObject({ retired: true, maxSigned: "300000" });
    expect(textOf(await u.call(debtAnswer()))).toBe(NO_RECORD_TEXT);
    expect(d.posts()).toEqual([]);
  });

  it("a debt a person settled in the portal (per-call REPLACING, also a moved channel debt): the neutral collecting text", async () => {
    const d = debtApi({
      debts: () => [{ intentId: DEBT_ID, payer: caip(PAYER), state: "REPLACING", voucherFormat: "PER_CALL", channel: null }],
    });
    const u = await unit({ api: d.api });
    for (let i = 0; i < 3; i++) await u.call();
    const r = await u.call(debtAnswer());
    expect(textOf(r)).toBe(DEBT_COLLECTING_TEXT);
    expect(textOf(r)).not.toContain("already signed");
    expect(d.posts()).toEqual([]);
  });

  it("per-call debts keep their behaviour: the settle text, nothing signed", async () => {
    const d = debtApi({ debts: () => [{ intentId: DEBT_ID, payer: caip(PAYER), state: "OPEN", voucherFormat: "PER_CALL", channel: null }] });
    const u = await unit({ api: d.api });
    await u.call();
    expect(textOf(await u.call(debtAnswer()))).toBe(SETTLE_TEXT);
    expect(d.posts()).toEqual([]);
  });

  it("a refused renew: call again soon, never the settle text; within a minute no second signature", async () => {
    const d = debtApi({ post: () => ({ status: 409, body: { success: false, error: { code: "PAYMENT_DEBT_NOT_YET_REPLACEABLE" } } }) });
    const u = await unit({ api: d.api });
    for (let i = 0; i < 3; i++) await u.call();
    expect(textOf(await u.call(debtAnswer()))).toBe(CHANNEL_DEBT_RETRY_TEXT);
    expect(textOf(await u.call(debtAnswer()))).toBe(CHANNEL_DEBT_RETRY_TEXT);
    expect(d.posts()).toHaveLength(1);
  });

  it("a renew refused for good (CHANNEL_DESYNC): the no-record text, never 'call again'; within a minute too", async () => {
    const d = debtApi({ post: () => ({ status: 409, body: { success: false, error: { code: "CHANNEL_DESYNC" } } }) });
    const u = await unit({ api: d.api });
    for (let i = 0; i < 3; i++) await u.call();
    expect(textOf(await u.call(debtAnswer()))).toBe(NO_RECORD_TEXT);
    expect(textOf(await u.call(debtAnswer()))).toBe(NO_RECORD_TEXT);
    expect(d.posts()).toHaveLength(1);
  });

  it("another wallet's channel debt of the organization: its own text, nothing signed, never the no-record text", async () => {
    const other = "eip155:46630:0x976EA74026E726554dB657fA54763abd0C3a0aa9";
    const d = debtApi({ debts: () => [channelDebt({ payer: other })] });
    const u = await unit({ api: d.api });
    for (let i = 0; i < 3; i++) await u.call();
    expect(textOf(await u.call(debtAnswer()))).toBe(OTHER_WALLET_DEBT_TEXT);
    expect(textOf(await u.call(debtAnswer()))).toBe(OTHER_WALLET_DEBT_TEXT);
    expect(d.posts()).toEqual([]);
  });

  it("no lane in state.json, or --no-paid: the API is never asked", async () => {
    const d = debtApi();
    const u = await unit({ api: d.api });
    expect(textOf(await u.call(debtAnswer()))).toBe(SETTLE_TEXT);
    expect(d.requests).toEqual([]);
    for (let i = 0; i < 3; i++) await u.call();
    const quiet = await unit({ api: d.api, noPaid: true });
    expect(textOf(await quiet.call(debtAnswer()))).toBe(SETTLE_TEXT);
    expect(d.requests).toEqual([]);
  });

  it("a debt that refuses a channel voucher re-arms the lane and renews", async () => {
    const d = debtApi();
    const u = await unit({ api: d.api, answer: (_m, n) => (n === 3 ? debtAnswer() : undefined) });
    for (let i = 0; i < 3; i++) await u.call();
    expect(textOf(await u.call())).toBe(CHANNEL_DEBT_RENEWED_TEXT);
    expect(book().lanes[0]).toMatchObject({ retired: false, reuseTop: true, maxSigned: "400000", callsSigned: 4 });
    expect(d.posts()).toHaveLength(1);
  });
});

describe("proxy: channel voucher with no answer", () => {
  // Spec 12.4: "no answer | retired (its pair stays renewable: it may have been stored)".
  for (const [name, setup] of [
    ["the resend throws", { answer: (_m: Record<string, unknown>, n: number) => {
      if (n === 2) throw new Error("socket hang up");
      return undefined;
    } }],
    ["a JSON-RPC error with no result", { rpcErrorAt: 2 }],
  ] as const) {
    it(`${name}: the lane is retired, its pair stays renewable, and a later debt on it is renewed`, async () => {
      const d = debtApi({ debts: () => [channelDebt({}, { cumulative: "300000", calls: 3 })] });
      const u = await unit({ api: d.api, ...setup });
      await u.call();
      await u.call();
      await u.call().catch(() => undefined);
      const lane = book().lanes[0]!;
      expect(lane).toMatchObject({ retired: true, maxSigned: "300000", callsSigned: 3 });
      expect(lane.renewable).toContainEqual(["300000", 3]);
      expect(textOf(await u.call(debtAnswer()))).toBe(CHANNEL_DEBT_RENEWED_TEXT);
      expect(d.posts()).toHaveLength(1);
      const env = (d.posts()[0]!.body as { channelVoucher: Envelope }).channelVoucher;
      expect(env.voucher).toMatchObject({ cumulative: "300000", calls: 3, channelId: lane.channelId });
    });
  }
});
