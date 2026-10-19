import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { builtInDeployments, type Deployments } from "../src/deployments.js";
import {
  CACHE_TTL_MS,
  ESCROW_READ_ABI,
  MAX_BLOCK_SPREAD,
  createChainReader,
  toGuardChain,
  type ChainReaderOptions,
} from "../src/chain/reads.js";
import { MAX_RESPONSE_BYTES, RpcError, ethCall } from "../src/chain/rpc.js";
import { pinnedPost } from "../src/chain/pinned-fetch.js";

// Public anvil default accounts (test only).
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DELEGATE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NETWORK = "eip155:46630";
const CHAIN_ID_HEX = "0xb626"; // 46630
const ESCROW = "0x1D2625efD87c2fc10b8563f3F0890072845Fcf41";

const ABI = parseAbi([
  "struct Delegation { uint64 maxVoucherAmount; uint64 maxPerWindow; uint64 spentInWindow; uint64 windowStartedAt; uint64 validUntil; uint32 listPosition; bool revoked; }",
  "struct Escrow { uint128 balance; uint64 seqHigh; uint64 authNonce; uint64 maxVoucherAmount; uint64 maxPerWindow; uint64 spentInWindow; uint64 windowStartedAt; uint64 withdrawRequested; uint64 withdrawAvailableAt; uint128 totalRedeemed; uint128 totalWithdrawn; uint128 totalFunded; }",
  "function escrowOf(address buyer) view returns (Escrow)",
  "function delegationOf(address payer, address delegate) view returns (Delegation)",
  "function effectiveCapsOf(address payer, address delegate) view returns (uint64 maxVoucherAmount, uint64 maxPerWindow, uint64 delegateMaxVoucherAmount, uint64 delegateMaxPerWindow)",
]);

interface EscrowView {
  balance: bigint;
  seqHigh: bigint;
  authNonce: bigint;
  maxVoucherAmount: bigint;
  maxPerWindow: bigint;
  spentInWindow: bigint;
  windowStartedAt: bigint;
  withdrawRequested: bigint;
  withdrawAvailableAt: bigint;
  totalRedeemed: bigint;
  totalWithdrawn: bigint;
  totalFunded: bigint;
}

interface ChainView {
  chainId: string;
  /** Latest block height this RPC reports. */
  height: bigint;
  escrow: EscrowView;
  /** Per-block overrides of the caps, to model state that changed at a block. */
  capsAt?: Map<bigint, [bigint, bigint, bigint, bigint]>;
  delegation: {
    maxVoucherAmount: bigint;
    maxPerWindow: bigint;
    spentInWindow: bigint;
    windowStartedAt: bigint;
    validUntil: bigint;
    listPosition: number;
    revoked: boolean;
  };
  caps: [bigint, bigint, bigint, bigint];
}

function baseView(): ChainView {
  return {
    chainId: CHAIN_ID_HEX,
    height: 1000n,
    escrow: {
      balance: 50000000n,
      seqHigh: 3n,
      authNonce: 1n,
      maxVoucherAmount: 1000000n,
      maxPerWindow: 10000000n,
      spentInWindow: 0n,
      windowStartedAt: 0n,
      withdrawRequested: 0n,
      withdrawAvailableAt: 0n,
      totalRedeemed: 0n,
      totalWithdrawn: 0n,
      totalFunded: 50000000n,
    },
    delegation: {
      maxVoucherAmount: 500000n,
      maxPerWindow: 5000000n,
      spentInWindow: 0n,
      windowStartedAt: 0n,
      validUntil: 1788591800n,
      listPosition: 0,
      revoked: false,
    },
    caps: [1000000n, 10000000n, 500000n, 5000000n],
  };
}

type Behaviour =
  | { kind: "ok" }
  | { kind: "down" }
  | { kind: "hang" }
  | { kind: "redirect" }
  | { kind: "status"; status: number }
  | { kind: "raw"; body: string }
  | { kind: "huge" }
  | { kind: "result"; result: unknown };

interface FakeRpc {
  url: string;
  view: ChainView;
  behaviour: Behaviour;
  calls: { method: string; fn?: string; to?: string; block?: unknown }[];
  close(): Promise<void>;
}

async function fakeRpc(): Promise<FakeRpc> {
  const fake: Omit<FakeRpc, "url" | "close"> = { view: baseView(), behaviour: { kind: "ok" }, calls: [] };
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const b = fake.behaviour;
      if (b.kind === "down") {
        req.socket.destroy();
        return;
      }
      if (b.kind === "hang") return;
      if (b.kind === "redirect") {
        res.writeHead(307, { location: "http://127.0.0.1:1/" }).end();
        return;
      }
      if (b.kind === "status") {
        res.writeHead(b.status, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (b.kind === "raw") {
        res.writeHead(200, { "content-type": "application/json" }).end(b.body);
        return;
      }
      if (b.kind === "huge") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"jsonrpc":"2.0","id":1,"result":"0x${"0".repeat(MAX_RESPONSE_BYTES * 2)}"}`);
        return;
      }
      const msg = JSON.parse(body) as { id: unknown; method: string; params: unknown[] };
      let result: unknown;
      if (msg.method === "eth_chainId") {
        fake.calls.push({ method: msg.method });
        result = fake.view.chainId;
      } else if (msg.method === "eth_blockNumber") {
        fake.calls.push({ method: msg.method });
        result = `0x${fake.view.height.toString(16)}`;
      } else if (msg.method === "eth_call") {
        const [tx, block] = msg.params as [{ to: string; data: Hex }, unknown];
        const decoded = decodeFunctionData({ abi: ABI, data: tx.data });
        fake.calls.push({ method: msg.method, fn: decoded.functionName, to: tx.to, block });
        if (b.kind === "result") result = b.result;
        else if (decoded.functionName === "delegationOf") {
          result = encodeFunctionResult({ abi: ABI, functionName: "delegationOf", result: fake.view.delegation });
        } else if (decoded.functionName === "escrowOf") {
          result = encodeFunctionResult({ abi: ABI, functionName: "escrowOf", result: fake.view.escrow });
        } else {
          const at = typeof block === "string" ? fake.view.capsAt?.get(BigInt(block)) : undefined;
          result = encodeFunctionResult({ abi: ABI, functionName: "effectiveCapsOf", result: at ?? fake.view.caps });
        }
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  });
}

let a: FakeRpc;
let b: FakeRpc;

beforeAll(async () => {
  a = await fakeRpc();
  b = await fakeRpc();
});
afterAll(async () => {
  await a.close();
  await b.close();
});
afterEach(() => {
  for (const f of [a, b]) {
    f.view = baseView();
    f.behaviour = { kind: "ok" };
    f.calls = [];
  }
});

/** The built-in table with production's RPCs replaced by the two fake servers. */
function tableWith(rpc: string[]): Deployments {
  const t = structuredClone(builtInDeployments());
  t.production.networks[NETWORK]!.rpc = rpc;
  return t;
}

function reader(extra: Partial<ChainReaderOptions> = {}, rpc = [a.url, b.url]) {
  let now = 1_000_000;
  const r = createChainReader({
    environment: "production",
    profile: "default",
    deployments: tableWith(rpc),
    timeoutMs: 300,
    now: () => now,
    ...extra,
  });
  return { r, advance: (ms: number) => (now += ms) };
}

const AGREED = {
  payer: PAYER,
  delegate: DELEGATE,
  active: true,
  validUntil: "1788591800",
  maxVoucherAmount: "1000000",
  maxPerWindow: "10000000",
  delegateMaxVoucherAmount: "500000",
  delegateMaxPerWindow: "5000000",
};

describe("readDelegation", () => {
  it("agree → values", async () => {
    const { r } = reader();
    const res = await r.readDelegation(NETWORK, PAYER, DELEGATE);
    expect(res).toEqual({ ok: true, value: AGREED });
    for (const f of [a, b]) {
      const calls = f.calls.filter((c) => c.method === "eth_call");
      expect(calls.map((c) => c.fn).sort()).toEqual(["delegationOf", "effectiveCapsOf", "escrowOf"]);
      for (const c of calls) {
        expect(c.to?.toLowerCase()).toBe(ESCROW.toLowerCase());
        expect(c.block).toBe(`0x${(1000n - 1n).toString(16)}`);
      }
      expect(f.calls.some((c) => c.method === "eth_blockNumber")).toBe(true);
      expect(f.calls.some((c) => c.method === "eth_chainId")).toBe(true);
    }
    expect(toGuardChain(res)).toEqual({
      payer: PAYER,
      active: true,
      validUntil: "1788591800",
      maxVoucherAmount: "1000000",
      delegateMaxVoucherAmount: "500000",
    });
  });

  it("disagree → CHAIN_UNCONFIRMED", async () => {
    b.view.caps = [1000000n, 10000000n, 900000n, 5000000n];
    const { r } = reader();
    const res = await r.readDelegation(NETWORK, PAYER, DELEGATE);
    expect(res).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
    expect(toGuardChain(res)).toBeNull();
  });

  it("disagree on delegationOf alone → CHAIN_UNCONFIRMED", async () => {
    b.view.delegation = { ...b.view.delegation, revoked: true };
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
  });

  it("one RPC on another chain → CHAIN_UNCONFIRMED", async () => {
    b.view.chainId = "0x1";
    a.view.chainId = "0x1";
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
  });

  it("one down → CHAIN_UNCONFIRMED", async () => {
    b.behaviour = { kind: "down" };
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
  });

  it("one hangs past the timeout → CHAIN_UNCONFIRMED", async () => {
    a.behaviour = { kind: "hang" };
    const { r } = reader({ timeoutMs: 100 });
    const started = Date.now();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("an RPC that is not listed in deployments is never contacted", async () => {
    const { r } = reader({}, [a.url, a.url.replace("127.0.0.1", "localhost")]);
    await r.readDelegation(NETWORK, PAYER, DELEGATE);
    expect(b.calls).toEqual([]);
  });

  it.each<[string, Behaviour]>([
    ["a redirect", { kind: "redirect" }],
    ["HTTP 500", { kind: "status", status: 500 }],
    ["not JSON", { kind: "raw", body: "<html>" }],
    ["a JSON-RPC error", { kind: "raw", body: '{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}' }],
    ["a body over the size cap", { kind: "huge" }],
    ["a short result", { kind: "result", result: "0x00" }],
    ["a non-hex result", { kind: "result", result: "0xzz" }],
    ["a numeric result", { kind: "result", result: 7 }],
    ["an empty result", { kind: "result", result: "0x" }],
    ["an over-long result", { kind: "result", result: `0x${"00".repeat(32 * 12)}` }],
  ])("one RPC answering %s → CHAIN_UNCONFIRMED", async (_name, behaviour) => {
    b.behaviour = behaviour;
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
  });

  it("both answering a non-canonical word (dirty uint64 high bits) → CHAIN_UNCONFIRMED", async () => {
    const good = encodeFunctionResult({ abi: ABI, functionName: "effectiveCapsOf", result: baseView().caps });
    const dirty = `0x${"ff".repeat(24)}${good.slice(2 + 48)}`;
    for (const f of [a, b]) f.behaviour = { kind: "result", result: dirty };
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
  });

  it("revoked or never-granted → active false, delegate caps from the chain", async () => {
    for (const f of [a, b]) {
      f.view.delegation = { ...f.view.delegation, revoked: true };
    }
    const { r } = reader();
    const res = await r.readDelegation(NETWORK, PAYER, DELEGATE);
    expect(res).toMatchObject({ ok: true, value: { active: false } });

    for (const f of [a, b]) {
      f.view.delegation = { ...baseView().delegation, validUntil: 0n, maxVoucherAmount: 0n, maxPerWindow: 0n };
      f.view.caps = [1000000n, 10000000n, 0n, 0n];
    }
    const { r: r2 } = reader();
    expect(await r2.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({
      ok: true,
      value: { active: false, validUntil: "0", delegateMaxVoucherAmount: "0" },
    });
  });

  it("the delegate cap is the lower of the current grant and the effective envelope", async () => {
    // A payer raised the cap: the envelope still holds the old one for the tighten delay,
    // and a lowered cap keeps the higher held value in the envelope. Admission uses the lower.
    for (const f of [a, b]) {
      f.view.delegation = { ...f.view.delegation, maxVoucherAmount: 200000n, maxPerWindow: 2000000n };
    }
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({
      ok: true,
      value: { delegateMaxVoucherAmount: "200000", delegateMaxPerWindow: "2000000" },
    });
  });

  it("cache 10 min then re-read", async () => {
    const { r, advance } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toEqual({ ok: true, value: AGREED });
    const callsAfterFirst = a.calls.length;
    expect(CACHE_TTL_MS).toBe(10 * 60 * 1000);

    for (const f of [a, b]) f.view.caps = [1000000n, 10000000n, 400000n, 5000000n];
    advance(CACHE_TTL_MS - 1);
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toEqual({ ok: true, value: AGREED });
    expect(a.calls.length).toBe(callsAfterFirst);

    advance(1);
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toEqual({
      ok: true,
      value: { ...AGREED, delegateMaxVoucherAmount: "400000" },
    });
    expect(a.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("the cache is per profile, payer and delegate; a failure is not cached", async () => {
    const t = tableWith([a.url, b.url]);
    const now = () => 5;
    const one = createChainReader({ environment: "production", profile: "one", deployments: t, now });
    const two = createChainReader({ environment: "production", profile: "two", deployments: t, now });
    await one.readDelegation(NETWORK, PAYER, DELEGATE);
    const n = a.calls.length;
    await two.readDelegation(NETWORK, PAYER, DELEGATE);
    expect(a.calls.length).toBeGreaterThan(n);

    b.behaviour = { kind: "down" };
    const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    expect(await one.readDelegation(NETWORK, other, DELEGATE)).toMatchObject({ ok: false });
    b.behaviour = { kind: "ok" };
    expect(await one.readDelegation(NETWORK, other, DELEGATE)).toMatchObject({ ok: true });
  });

  it("fresh: true skips the cache (enable-paid confirmation)", async () => {
    const { r } = reader();
    await r.readDelegation(NETWORK, PAYER, DELEGATE);
    const n = a.calls.length;
    await r.readDelegation(NETWORK, PAYER, DELEGATE, { fresh: true });
    expect(a.calls.length).toBeGreaterThan(n);
  });

  it("concurrent reads share one round of requests", async () => {
    const { r } = reader();
    const [x, y] = await Promise.all([
      r.readDelegation(NETWORK, PAYER, DELEGATE),
      r.readDelegation(NETWORK, PAYER, DELEGATE),
    ]);
    expect(x).toEqual(y);
    expect(a.calls.filter((c) => c.fn === "delegationOf")).toHaveLength(1);
  });

  it.each([
    ["an unknown network", "eip155:1", PAYER, DELEGATE],
    ["a bad payer", NETWORK, "0x123", DELEGATE],
    ["a bad delegate", NETWORK, PAYER, "not-an-address"],
    ["a payer on another chain", "eip155:46630", `eip155:1:${PAYER}`, DELEGATE],
    ["a prototype key as network", "__proto__", PAYER, DELEGATE],
  ])("refuses %s without any request", async (_name, network, payer, delegate) => {
    const { r } = reader();
    expect(await r.readDelegation(network, payer, delegate)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
    expect(a.calls).toEqual([]);
  });

  it("accepts CAIP-10 and lower-case addresses and returns checksummed ones", async () => {
    const { r } = reader();
    const res = await r.readDelegation(NETWORK, `${NETWORK}:${PAYER}`, DELEGATE.toLowerCase());
    expect(res).toEqual({ ok: true, value: AGREED });
  });

  it("refuses production with fewer than two RPCs", async () => {
    const { r } = reader({}, [a.url]);
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
    expect(a.calls).toEqual([]);
  });

  it("refuses placeholder RPCs and plain http to a non-loopback host", async () => {
    for (const rpc of [["<operator RPC>", "<public RPC>"], [a.url, "http://rpc.example.com"]]) {
      const { r } = reader({}, rpc);
      expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
    }
  });

  it("a single-RPC dev entry reads its one RPC", async () => {
    const t = structuredClone(builtInDeployments());
    t.e2e.networks[NETWORK]!.rpc = [a.url];
    const r = createChainReader({ environment: "e2e", profile: "default", deployments: t });
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toEqual({ ok: true, value: AGREED });
  });

  it("the reason never carries a URL or an address", async () => {
    b.behaviour = { kind: "down" };
    const { r } = reader();
    const res = await r.readDelegation(NETWORK, PAYER, DELEGATE);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).not.toMatch(/127\.0\.0\.1|localhost|0x[0-9a-fA-F]{6}/);
    }
  });

  it("the read ABI is exactly the backend's three views", () => {
    expect(ESCROW_READ_ABI.map((f) => ("name" in f ? f.name : "")).sort()).toEqual([
      "delegationOf",
      "effectiveCapsOf",
      "escrowOf",
    ]);
    for (const f of ESCROW_READ_ABI) expect(f).toMatchObject({ type: "function", stateMutability: "view" });
  });

  it("the escrow caps are the lower of the envelope and the payer's current caps", async () => {
    // The payer just lowered the escrow caps: the envelope still holds the old ones.
    for (const f of [a, b]) f.view.escrow = { ...f.view.escrow, maxVoucherAmount: 300000n, maxPerWindow: 3000000n };
    const { r } = reader();
    const res = await r.readDelegation(NETWORK, PAYER, DELEGATE);
    expect(res).toMatchObject({ ok: true, value: { maxVoucherAmount: "300000", maxPerWindow: "3000000" } });
    expect(toGuardChain(res)).toMatchObject({ maxVoucherAmount: "300000" });

    // The payer raised them: the envelope keeps the lower held value for the tighten delay.
    for (const f of [a, b]) f.view.escrow = { ...baseView().escrow, maxVoucherAmount: 9000000n, maxPerWindow: 90000000n };
    const { r: r2 } = reader();
    expect(await r2.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({
      ok: true,
      value: { maxVoucherAmount: "1000000", maxPerWindow: "10000000" },
    });
  });

  it("disagree on escrowOf alone → CHAIN_UNCONFIRMED", async () => {
    b.view.escrow = { ...b.view.escrow, maxVoucherAmount: 2n };
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
  });

  it("RPCs a few blocks apart read one pinned block, min(heights) - 1, and agree", async () => {
    a.view.height = 1003n;
    b.view.height = 1000n;
    // State changed at block 1000: an RPC reading its own latest would disagree.
    for (const f of [a, b]) f.view.capsAt = new Map([[1000n, [1000000n, 10000000n, 1n, 1n]], [1003n, [1000000n, 10000000n, 1n, 1n]]]);
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toEqual({ ok: true, value: AGREED });
    for (const f of [a, b]) {
      const blocks = new Set(f.calls.filter((c) => c.method === "eth_call").map((c) => c.block));
      expect([...blocks]).toEqual([`0x${(999n).toString(16)}`]);
    }
  });

  it("RPCs exactly MAX_BLOCK_SPREAD apart still read", async () => {
    a.view.height = 1000n + MAX_BLOCK_SPREAD;
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: true });
  });

  it("RPCs more than MAX_BLOCK_SPREAD apart → CHAIN_UNCONFIRMED, with no eth_call", async () => {
    expect(MAX_BLOCK_SPREAD).toBe(5n);
    a.view.height = 1000n + MAX_BLOCK_SPREAD + 1n;
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
    for (const f of [a, b]) expect(f.calls.filter((c) => c.method === "eth_call")).toEqual([]);
  });

  it("a chain at block 0 has no block to pin → CHAIN_UNCONFIRMED", async () => {
    for (const f of [a, b]) f.view.height = 0n;
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
  });

  it("a real disagreement at the pinned block still refuses", async () => {
    a.view.height = 1002n;
    b.view.capsAt = new Map([[999n, [1000000n, 10000000n, 7n, 5000000n]]]);
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
  });

  // The anvil fork CI job sets ASSAY_ANVIL_FORK=1 after authorising DELEGATE for PAYER on the fork
  // with the caps in ASSAY_ANVIL_EXPECT (JSON of the agreed value). Skipped everywhere else, so no
  // test reaches a network it did not start.
  it.skipIf(process.env.ASSAY_ANVIL_FORK !== "1")("the anvil fork (CI job) returns the authorised caps", async () => {
    const r = createChainReader({ environment: "anvil", profile: "default" });
    const payer = process.env.ASSAY_ANVIL_PAYER ?? PAYER;
    const delegate = process.env.ASSAY_ANVIL_DELEGATE ?? DELEGATE;
    const expected = JSON.parse(process.env.ASSAY_ANVIL_EXPECT ?? "{}") as Record<string, unknown>;
    const res = await r.readDelegation(NETWORK, payer, delegate);
    expect(res).toMatchObject({ ok: true, value: { active: true, ...expected } });
  });
});

describe("rpc / pinned fetch", () => {
  it("pinnedPost refuses a URL outside its allow-list", async () => {
    await expect(
      pinnedPost("http://127.0.0.1:1/", "{}", { allowed: [a.url], timeoutMs: 100, maxBytes: 1024 }),
    ).rejects.toThrow();
    expect(a.calls).toEqual([]);
  });

  it("ethCall rejects a mismatched JSON-RPC id", async () => {
    b.behaviour = { kind: "raw", body: '{"jsonrpc":"2.0","id":999,"result":"0x"}' };
    await expect(
      ethCall(b.url, { to: ESCROW, data: "0x" }, 1n, { allowed: [b.url], timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(RpcError);
  });
});
