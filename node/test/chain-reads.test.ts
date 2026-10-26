import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { builtInDeployments, type Deployments } from "../src/deployments.js";
import {
  CACHE_TTL_MS,
  ESCROW_READ_ABI,
  MAX_BLOCK_SPREAD,
  READ_ATTEMPTS,
  RETRY_DELAYS_MS,
  RETRY_WINDOW_MS,
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
const ESCROW = "0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f";
/** Production runs on Robinhood Chain mainnet; the dev entries above stay on testnet. */
const PROD_NETWORK = "eip155:4663";

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
  | { kind: "redirect"; to: string }
  | { kind: "slowCalls"; ms: number }
  | { kind: "custom"; handle: (res: ServerResponse) => void }
  | { kind: "status"; status: number }
  | { kind: "raw"; body: string }
  | { kind: "huge" }
  | { kind: "result"; result: unknown };

interface FakeRpc {
  url: string;
  view: ChainView;
  behaviour: Behaviour;
  /** The next this many requests answer HTTP 503 (a transient failure), whatever `behaviour` says. */
  failNext: number;
  calls: { method: string; fn?: string; to?: string; block?: unknown }[];
  close(): Promise<void>;
}

async function fakeRpc(): Promise<FakeRpc> {
  const fake: Omit<FakeRpc, "url" | "close"> = { view: baseView(), behaviour: { kind: "ok" }, failNext: 0, calls: [] };
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const b = fake.behaviour;
      if (fake.failNext > 0) {
        fake.failNext--;
        res.writeHead(503, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (b.kind === "down") {
        req.socket.destroy();
        return;
      }
      if (b.kind === "hang") return;
      if (b.kind === "redirect") {
        // A 307 keeps the method and body, so a client that follows it re-posts to `to`.
        res.writeHead(307, { location: b.to }).end();
        return;
      }
      if (b.kind === "custom") {
        b.handle(res);
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
      const msg = JSON.parse(body) as { id: unknown; method: string; params: unknown[] };
      if (b.kind === "huge") {
        // A well-formed answer (the request id echoed) that is only wrong in size.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: `0x${"0".repeat(MAX_RESPONSE_BYTES * 2)}` }));
        return;
      }
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
      const send = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      // The answer is computed on receipt; `slowCalls` only delays sending it.
      if (b.kind === "slowCalls" && msg.method === "eth_call") setTimeout(send, b.ms);
      else send();
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
    f.failNext = 0;
    f.calls = [];
  }
  slept = [];
  onSleep = () => {};
});

/** The waits between attempts, recorded instead of slept; `onSleep` runs at each. */
let slept: number[] = [];
let onSleep: () => void = () => {};
const sleep = async (ms: number): Promise<void> => {
  slept.push(ms);
  onSleep();
};
const rounds = (f: FakeRpc): number => f.calls.filter((c) => c.method === "eth_blockNumber").length;

/**
 * The built-in table with `env`'s RPCs replaced. The fake servers are plain http on loopback,
 * which only dev entries accept, so the reading tests run as `anvil` with both servers listed.
 */
function tableWith(rpc: string[], env: "anvil" | "production" = "anvil"): Deployments {
  const t = structuredClone(builtInDeployments());
  t[env].networks[env === "production" ? PROD_NETWORK : NETWORK]!.rpc = rpc;
  return t;
}

function reader(extra: Partial<ChainReaderOptions> = {}, rpc = [a.url, b.url]) {
  let now = 1_000_000;
  const r = createChainReader({
    environment: "anvil",
    profile: "default",
    deployments: tableWith(rpc),
    timeoutMs: 300,
    now: () => now,
    sleep,
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
  readAt: 1000,
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
    expect(toGuardChain(res, DELEGATE)).toEqual({
      payer: PAYER,
      delegate: DELEGATE,
      readAt: 1000,
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
    expect(toGuardChain(res, DELEGATE)).toBeNull();
  });

  it("toGuardChain refuses a read made for another delegate than the local key", async () => {
    const { r } = reader();
    const res = await r.readDelegation(NETWORK, PAYER, DELEGATE);
    expect(res.ok).toBe(true);
    expect(toGuardChain(res, DELEGATE.toLowerCase())).toMatchObject({ delegate: DELEGATE });
    expect(toGuardChain(res, "0x90F79bf6EB2c4f870365E785982E1f101E93b906")).toBeNull();
    expect(toGuardChain(res, "not-a-key")).toBeNull();
  });

  it("disagree on delegationOf alone → CHAIN_UNCONFIRMED", async () => {
    b.view.delegation = { ...b.view.delegation, revoked: true };
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
  });

  it.each([
    ["only the second RPC", ["b"]],
    ["only the first RPC", ["a"]],
    ["both RPCs", ["a", "b"]],
  ])("%s on another chain → CHAIN_UNCONFIRMED", async (_name, which) => {
    for (const w of which) (w === "a" ? a : b).view.chainId = "0x1";
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({
      ok: false,
      code: "CHAIN_UNCONFIRMED",
      reason: "an RPC is on another chain",
    });
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
    ["a redirect", { kind: "redirect", to: "" }],
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
    // The redirect points at the other, honest server: following it would make both agree.
    b.behaviour = behaviour.kind === "redirect" ? { kind: "redirect", to: a.url } : behaviour;
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
      value: { ...AGREED, delegateMaxVoucherAmount: "400000", readAt: 1600 },
    });
    expect(a.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("the cache is per profile, payer and delegate; a failure is not cached", async () => {
    const t = tableWith([a.url, b.url]);
    const now = () => 5;
    const one = createChainReader({ environment: "anvil", profile: "one", deployments: t, now, sleep });
    const two = createChainReader({ environment: "anvil", profile: "two", deployments: t, now, sleep });
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

  it("the cache key includes the delegate: another key of the same payer is read afresh", async () => {
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: true, value: { active: true } });
    const n = a.calls.length;
    // The second key has no grant on chain.
    for (const f of [a, b]) {
      f.view.delegation = { ...f.view.delegation, validUntil: 0n, maxVoucherAmount: 0n, maxPerWindow: 0n };
    }
    const otherKey = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
    const res = await r.readDelegation(NETWORK, PAYER, otherKey);
    expect(a.calls.length).toBeGreaterThan(n);
    expect(res).toMatchObject({ ok: true, value: { delegate: otherKey, active: false } });
  });

  it("the cache key includes the payer: another payer of the same key is read afresh", async () => {
    const { r } = reader();
    await r.readDelegation(NETWORK, PAYER, DELEGATE);
    const n = a.calls.length;
    const otherPayer = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const res = await r.readDelegation(NETWORK, otherPayer, DELEGATE);
    expect(a.calls.length).toBeGreaterThan(n);
    expect(res).toMatchObject({ ok: true, value: { payer: otherPayer } });
  });

  it("the cache key includes the network: the same payer and key on another network is read afresh", async () => {
    // A second network whose RPCs are the same servers; they answer chain 46630, so a real read
    // for eip155:31337 refuses. A key without the network would return the cached 46630 read.
    const t = tableWith([a.url, b.url]);
    t.anvil.networks["eip155:31337"] = {
      ...t.anvil.networks[NETWORK]!,
      escrow: `eip155:31337:${ESCROW}`,
      asset: "eip155:31337/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3",
    };
    const r = createChainReader({ environment: "anvil", profile: "default", deployments: t, now: () => 1_000_000 });
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: true });
    const n = a.calls.length;
    expect(await r.readDelegation("eip155:31337", PAYER, DELEGATE)).toMatchObject({
      ok: false,
      reason: "an RPC is on another chain",
    });
    expect(a.calls.length).toBeGreaterThan(n);
  });

  it("CAIP-10 and case variants of one key share one cache entry", async () => {
    const { r } = reader();
    await r.readDelegation(NETWORK, PAYER, DELEGATE);
    const n = a.calls.length;
    await r.readDelegation(NETWORK, `${NETWORK}:${PAYER}`, DELEGATE.toLowerCase());
    expect(a.calls.length).toBe(n);
  });

  it("invalidate(payer, delegate, network) makes the next read go to the chain", async () => {
    const { r } = reader();
    await r.readDelegation(NETWORK, PAYER, DELEGATE);
    for (const f of [a, b]) f.view.delegation = { ...f.view.delegation, revoked: true };
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ value: { active: true } });
    r.invalidate(PAYER, DELEGATE, NETWORK);
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ value: { active: false } });
  });

  it("an older read still in flight never overwrites a newer one (fresh, or after invalidate)", async () => {
    const waitForCalls = async () => {
      while (a.calls.filter((c) => c.method === "eth_call").length < 3) await new Promise((r) => setTimeout(r, 5));
    };
    for (const mode of ["fresh", "invalidate"] as const) {
      for (const f of [a, b]) {
        f.calls = [];
        f.view = baseView();
        f.behaviour = { kind: "slowCalls", ms: 150 };
      }
      const { r } = reader({ timeoutMs: 2000 });
      // Read A: its eth_call answers (old state) are computed now and sent 150 ms later.
      const older = r.readDelegation(NETWORK, PAYER, DELEGATE);
      await waitForCalls();
      for (const f of [a, b]) {
        f.view.delegation = { ...f.view.delegation, revoked: true };
        f.behaviour = { kind: "ok" };
      }
      let newer;
      if (mode === "fresh") newer = await r.readDelegation(NETWORK, PAYER, DELEGATE, { fresh: true });
      else {
        r.invalidate(PAYER, DELEGATE, NETWORK);
        newer = await r.readDelegation(NETWORK, PAYER, DELEGATE);
      }
      expect(newer).toMatchObject({ ok: true, value: { active: false } });
      expect(await older).toMatchObject({ ok: true, value: { active: true } });
      // The cache keeps the newer state.
      expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: true, value: { active: false } });
    }
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

  // Production refusals are decided before any request: none of these URLs is ever contacted.
  it.each([
    ["fewer than two RPCs", ["https://rpc-a.example.com"], "not enough RPCs"],
    ["placeholder RPCs", ["<operator RPC>", "<public RPC>"], "RPC not usable"],
    ["plain http to a non-loopback host", ["https://rpc-a.example.com", "http://rpc-b.example.com"], "RPC not usable"],
    ["plain http to loopback (dev entries only)", ["https://rpc-a.example.com", "http://127.0.0.1:8547"], "RPC not usable"],
    ["two RPCs on one host", ["https://rpc.example.com/a", "https://RPC.example.com/b"], "RPCs share a host"],
  ])("production refuses %s", async (_name, rpc, reason) => {
    const r = createChainReader({ environment: "production", profile: "default", deployments: tableWith(rpc, "production") });
    expect(await r.readDelegation(PROD_NETWORK, PAYER, DELEGATE)).toEqual({ ok: false, code: "CHAIN_UNCONFIRMED", reason });
  });

  it("production refuses the fake loopback servers even though they would agree", async () => {
    const r = createChainReader({
      environment: "production",
      profile: "default",
      deployments: tableWith([a.url, b.url], "production"),
    });
    expect(await r.readDelegation(PROD_NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, reason: "RPC not usable" });
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  it("a single-RPC dev entry reads its one RPC", async () => {
    const t = structuredClone(builtInDeployments());
    t.e2e.networks[NETWORK]!.rpc = [a.url];
    const r = createChainReader({ environment: "e2e", profile: "default", deployments: t, now: () => 1_000_000 });
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
    expect(toGuardChain(res, DELEGATE)).toMatchObject({ maxVoucherAmount: "300000" });

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

  it("RPCs more than MAX_BLOCK_SPREAD apart → CHAIN_UNCONFIRMED after every attempt, with no eth_call", async () => {
    expect(MAX_BLOCK_SPREAD).toBe(120n);
    a.view.height = 1000n + MAX_BLOCK_SPREAD + 1n;
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toEqual({ ok: false, code: "CHAIN_UNCONFIRMED", reason: "RPCs are too far apart" });
    for (const f of [a, b]) expect(f.calls.filter((c) => c.method === "eth_call")).toEqual([]);
    expect(rounds(a)).toBe(READ_ATTEMPTS);
    expect(slept).toEqual([...RETRY_DELAYS_MS]);
  });

  it("RPCs 100 blocks apart read at min(heights) - 1 and agree", async () => {
    a.view.height = 1100n;
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toEqual({ ok: true, value: AGREED });
    for (const f of [a, b]) {
      expect([...new Set(f.calls.filter((c) => c.method === "eth_call").map((c) => c.block))]).toEqual([`0x${(999n).toString(16)}`]);
    }
    expect(slept).toEqual([]);
  });

  it("the retry budget is 3 attempts after 300 ms and 1 s, within a 5 s window", () => {
    expect(READ_ATTEMPTS).toBe(3);
    expect(RETRY_DELAYS_MS).toEqual([300, 1000]);
    expect(RETRY_WINDOW_MS).toBe(5000);
  });

  it("an RPC failing on attempt 1 and answering on attempt 2 → the agreed read", async () => {
    b.failNext = 1;
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toEqual({ ok: true, value: AGREED });
    expect(slept).toEqual([300]);
    expect(rounds(a)).toBe(2);
  });

  it("RPCs too far apart on attempt 1 that catch up by attempt 2 → a read at the new pinned block", async () => {
    a.view.height = 1000n + MAX_BLOCK_SPREAD + 30n;
    onSleep = () => {
      b.view.height = 1100n;
    };
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: true });
    expect(slept).toEqual([300]);
    for (const f of [a, b]) {
      expect([...new Set(f.calls.filter((c) => c.method === "eth_call").map((c) => c.block))]).toEqual([`0x${(1099n).toString(16)}`]);
    }
  });

  it("an eth_call timing out on attempt 1 reruns the whole read, heights included", async () => {
    // Round 1 on `b` answers at once; its eth_calls pass the 300 ms timeout until the first wait.
    b.behaviour = { kind: "slowCalls", ms: 400 };
    onSleep = () => {
      b.behaviour = { kind: "ok" };
    };
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toEqual({ ok: true, value: AGREED });
    expect(slept).toEqual([300]);
    expect(rounds(a)).toBe(2);
    expect(rounds(b)).toBe(2);
  });

  it("an RPC failing on every attempt → CHAIN_UNCONFIRMED after 3 attempts; the failure is not cached", async () => {
    b.failNext = READ_ATTEMPTS * 2;
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
    expect(slept).toEqual([300, 1000]);
    expect(rounds(a)).toBe(READ_ATTEMPTS);
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toEqual({ ok: true, value: AGREED });
  });

  it("no new attempt starts once the retry window has passed", async () => {
    a.behaviour = { kind: "hang" };
    const { r } = reader({ timeoutMs: 100, sleep: async (ms) => void slept.push(ms) });
    const realNow = performance.now.bind(performance);
    let shift = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => realNow() + shift);
    onSleep = () => {};
    try {
      // The first attempt "takes" longer than the window: the clock jumps while it runs.
      setTimeout(() => (shift = RETRY_WINDOW_MS), 20);
      expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, code: "CHAIN_UNCONFIRMED" });
      expect(slept).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a disagreement at the pinned block is final: no retry", async () => {
    b.view.caps = [1000000n, 10000000n, 900000n, 5000000n];
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toEqual({ ok: false, code: "CHAIN_UNCONFIRMED", reason: "RPCs disagree" });
    expect(slept).toEqual([]);
    expect(rounds(a)).toBe(1);
    expect(rounds(b)).toBe(1);
  });

  it("an RPC on another chain is final: no retry", async () => {
    b.view.chainId = "0x1";
    const { r } = reader();
    expect(await r.readDelegation(NETWORK, PAYER, DELEGATE)).toMatchObject({ ok: false, reason: "an RPC is on another chain" });
    expect(slept).toEqual([]);
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
  const BODY = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] });
  const loop = (allowed: string[], maxBytes = 1024) => ({ allowed, timeoutMs: 1000, maxBytes, allowLoopbackHttp: true });

  it("pinnedPost refuses a URL outside its allow-list", async () => {
    await expect(pinnedPost(b.url, BODY, loop([a.url]))).rejects.toThrow("url not allowed");
    expect(b.calls).toEqual([]);
  });

  it("pinnedPost refuses loopback http unless the caller allows it", async () => {
    await expect(pinnedPost(a.url, BODY, { allowed: [a.url], timeoutMs: 1000, maxBytes: 1024 })).rejects.toThrow(
      "url scheme or host not allowed",
    );
    expect(a.calls).toEqual([]);
    await expect(pinnedPost(a.url, BODY, loop([a.url]))).resolves.toContain('"result":"0xb626"');
  });

  it("pinnedPost refuses a redirect and never reaches its target, even an allowed one", async () => {
    a.behaviour = { kind: "redirect", to: b.url };
    await expect(pinnedPost(a.url, BODY, loop([a.url, b.url]))).rejects.toThrow("redirect refused");
    expect(b.calls).toEqual([]);
  });

  it("pinnedPost refuses a declared content-length over the cap", async () => {
    a.behaviour = {
      kind: "custom",
      handle: (res) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: 7, result: "0x" + "0".repeat(2000) });
        res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
        res.end(body);
      },
    };
    await expect(pinnedPost(a.url, BODY, loop([a.url]))).rejects.toThrow("response too large");
  });

  it("pinnedPost cuts a chunked body (no content-length) at the cap", async () => {
    a.behaviour = {
      kind: "custom",
      handle: (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"jsonrpc":"2.0","id":7,"result":"0x');
        for (let i = 0; i < 8; i++) res.write("0".repeat(256));
        res.end('"}');
      },
    };
    await expect(pinnedPost(a.url, BODY, loop([a.url]))).rejects.toThrow("response too large");
    // The same answer passes under a cap it fits in, so the refusal above is the cap.
    await expect(pinnedPost(a.url, BODY, loop([a.url], 4096))).resolves.toContain('"id":7');
  });

  it("ethCall rejects a mismatched JSON-RPC id", async () => {
    b.behaviour = { kind: "raw", body: '{"jsonrpc":"2.0","id":999,"result":"0x"}' };
    await expect(
      ethCall(b.url, { to: ESCROW, data: "0x" }, 1n, { allowed: [b.url], timeoutMs: 300, allowLoopbackHttp: true }),
    ).rejects.toBeInstanceOf(RpcError);
  });
});
