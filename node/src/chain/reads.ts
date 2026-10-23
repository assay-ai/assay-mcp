/**
 * The proxy's read-only view of the escrow: the delegate grant and its caps (G4, G6; spec §7.8,
 * §7.15, M6).
 *
 * - Three views only, with the backend's ABI: `delegationOf(payer, delegate)`,
 *   `effectiveCapsOf(payer, delegate)` and `escrowOf(payer)` (`assay-evm/src/AssayEscrow.sol`).
 *   Each cap is the lower of the effective envelope and the current value: strictest wins.
 * - The escrow and the RPCs come from the selected entry of `deployments.json`, never from the
 *   server or from code.
 * - Every listed RPC is read, and each must answer the same chain id and the same bytes. All
 *   reads run at one pinned block `B = min(heights) - 1`, so RPCs a block apart still agree; heights
 *   more than `MAX_BLOCK_SPREAD` apart refuse. A failure, a timeout or any disagreement gives
 *   `CHAIN_UNCONFIRMED`, which guards treat as "no read" (fail closed).
 * - An agreed result is cached for 10 minutes per profile, payer and delegate. Failures are not
 *   cached.
 */
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, getAddress, isAddress, parseAbi } from "viem";
import {
  DEV_ENVIRONMENTS,
  builtInDeployments,
  isPlaceholder,
  parseCaip10,
  type Deployments,
  type Environment,
} from "../deployments.js";
import { isAllowedRpcUrl } from "./pinned-fetch.js";
import { DEFAULT_TIMEOUT_MS, ethBlockNumber, ethCall, ethChainId } from "./rpc.js";

/** How long an agreed read stands (G4: "at most every 10 minutes"). */
export const CACHE_TTL_MS = 10 * 60 * 1000;
/** The most two RPCs' latest block heights may differ before the read refuses. */
export const MAX_BLOCK_SPREAD = 5n;
/** Cached entries per reader; the oldest is dropped beyond this. */
const MAX_CACHE_ENTRIES = 64;

/** The two escrow views, verbatim from the backend's `ASSAY_ESCROW_ABI`. */
export const ESCROW_READ_ABI = parseAbi([
  "struct Delegation { uint64 maxVoucherAmount; uint64 maxPerWindow; uint64 spentInWindow; uint64 windowStartedAt; uint64 validUntil; uint32 listPosition; bool revoked; }",
  "struct Escrow { uint128 balance; uint64 seqHigh; uint64 authNonce; uint64 maxVoucherAmount; uint64 maxPerWindow; uint64 spentInWindow; uint64 windowStartedAt; uint64 withdrawRequested; uint64 withdrawAvailableAt; uint128 totalRedeemed; uint128 totalWithdrawn; uint128 totalFunded; }",
  "function escrowOf(address buyer) view returns (Escrow)",
  "function delegationOf(address payer, address delegate) view returns (Delegation)",
  "function effectiveCapsOf(address payer, address delegate) view returns (uint64 maxVoucherAmount, uint64 maxPerWindow, uint64 delegateMaxVoucherAmount, uint64 delegateMaxPerWindow)",
]);

/** ABI-encoded return sizes: static tuples of 7 and 12 words, and 4 words. */
const DELEGATION_BYTES = 7 * 32;
const ESCROW_BYTES = 12 * 32;
const CAPS_BYTES = 4 * 32;

/** The agreed chain state. Integers are decimal strings (uint64 can exceed 2^53). */
export interface DelegationState {
  /** Checksummed payer address. */
  payer: string;
  /** Checksummed delegate address. */
  delegate: string;
  /** The grant was written and is not revoked (`validUntil != 0 && !revoked`). */
  active: boolean;
  /** `delegationOf(...).validUntil`, Unix seconds; the guard compares it with the clock. */
  validUntil: string;
  /**
   * The escrow's cap per voucher: the lower of `effectiveCapsOf(...).maxVoucherAmount` and the
   * current `escrowOf(payer).maxVoucherAmount`.
   */
  maxVoucherAmount: string;
  /** Same rule for the escrow's window cap. */
  maxPerWindow: string;
  /**
   * The delegate's cap per voucher: the lower of `effectiveCapsOf(...).delegateMaxVoucherAmount`
   * (0 when the grant cannot sign now) and the current grant's `maxVoucherAmount`.
   */
  delegateMaxVoucherAmount: string;
  /** Same rule for the delegate's window cap. */
  delegateMaxPerWindow: string;
  /** When the read started, Unix seconds on the reader's clock. Kept on cached hits. */
  readAt: number;
}

export type DelegationResult =
  | { ok: true; value: DelegationState }
  | { ok: false; code: "CHAIN_UNCONFIRMED"; reason: string };

/** The guard's `chain` input (G4, G6): the SDK's `ChainState`, so the proxy passes it without a cast. */
export type { ChainState } from "@goassay-ai/sdk/core";
import type { ChainState } from "@goassay-ai/sdk/core";

/**
 * The agreed state for the guard, or `null` when there is none (fail closed). A read made for
 * any key other than `localKey` (the proxy's own delegate key) is also `null`.
 */
export function toGuardChain(result: DelegationResult, localKey: string): ChainState | null {
  if (!result.ok) return null;
  const v = result.value;
  const local = /^0x[0-9a-fA-F]{40}$/.test(localKey) && isAddress(localKey, { strict: false }) ? getAddress(localKey) : null;
  if (local === null || getAddress(v.delegate) !== local) return null;
  return {
    payer: v.payer,
    delegate: v.delegate,
    readAt: v.readAt,
    active: v.active,
    validUntil: v.validUntil,
    maxVoucherAmount: v.maxVoucherAmount,
    delegateMaxVoucherAmount: v.delegateMaxVoucherAmount,
  };
}

export interface ChainReaderOptions {
  environment: Environment;
  /** The profile this reader serves; cached reads never cross profiles. */
  profile: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Milliseconds clock for the cache. */
  now?: () => number;
  /** Tests only: a table in place of the built-in one. The CLI never passes this. */
  deployments?: Deployments;
}

export interface ChainReader {
  readDelegation(
    network: string,
    payer: string,
    delegate: string,
    opts?: { fresh?: boolean },
  ): Promise<DelegationResult>;
  /**
   * Drops the cached read for one payer and delegate on one network, so the next read goes to
   * the chain. The proxy (Task 2.9) calls it when the server refuses a voucher for a revoked or
   * expired delegate, or when G4/G6 refuses, so a revocation stops signing on the next call.
   */
  invalidate(payer: string, delegate: string, network: string): void;
  /** Drops every cached read of this reader. */
  clear(): void;
}

function unconfirmed(reason: string): DelegationResult {
  return { ok: false, code: "CHAIN_UNCONFIRMED", reason };
}

/** A bare `0x` address in any case, or a CAIP-10 account on `chainId`; checksummed, or null. */
function account(value: unknown, chainId: number): `0x${string}` | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("eip155:")) {
    const parsed = parseCaip10(value);
    return parsed && parsed.chainId === chainId ? getAddress(parsed.address) : null;
  }
  return /^0x[0-9a-fA-F]{40}$/.test(value) && isAddress(value, { strict: false }) ? getAddress(value) : null;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : "failed");

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

interface RawRead {
  delegation: `0x${string}`;
  caps: `0x${string}`;
  escrow: `0x${string}`;
}

export function createChainReader(options: ChainReaderOptions): ChainReader {
  const table = options.deployments ?? builtInDeployments();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dev = DEV_ENVIRONMENTS.includes(options.environment);
  // `gen` orders reads: a result is stored only when no newer read or invalidation came first,
  // so a slow, older read never overwrites a newer one.
  let gen = 0;
  let clearedAt = 0;
  const cache = new Map<string, { at: number; gen: number; value: DelegationState }>();
  const floors = new Map<string, number>();
  const inFlight = new Map<string, { gen: number; promise: Promise<DelegationResult> }>();

  /** The cache key, with addresses normalised so CAIP-10 and case variants share one entry. */
  function keyOf(network: string, payer: string, delegate: string): string {
    const chain = /^eip155:([1-9][0-9]*)$/.exec(String(network));
    const chainId = chain ? Number(chain[1]) : 0;
    const norm = (x: string) => account(x, chainId) ?? String(x).toLowerCase();
    return JSON.stringify([options.profile, String(network), norm(payer), norm(delegate)]);
  }

  async function readOnce(network: string, payerIn: string, delegateIn: string, readAt: number): Promise<DelegationResult> {
    const entry = table[options.environment];
    const n = entry && Object.hasOwn(entry.networks, network) ? entry.networks[network] : undefined;
    const chain = /^eip155:([1-9][0-9]*)$/.exec(network);
    if (!n || !chain) return unconfirmed("network not in the deployment entry");
    const chainId = Number(chain[1]);

    const escrow = parseCaip10(n.escrow);
    if (!escrow || escrow.chainId !== chainId) return unconfirmed("escrow not configured");
    const payer = account(payerIn, chainId);
    const delegate = account(delegateIn, chainId);
    if (!payer || !delegate) return unconfirmed("bad payer or delegate");

    const rpcs = Array.isArray(n.rpc) ? n.rpc : [];
    if (rpcs.length < (dev ? 1 : 2) || new Set(rpcs).size !== rpcs.length) return unconfirmed("not enough RPCs");
    if (rpcs.some((u) => isPlaceholder(u) || !isAllowedRpcUrl(u, dev))) return unconfirmed("RPC not usable");
    // Outside dev, agreement means something only if the RPCs are different hosts.
    if (!dev && new Set(rpcs.map((u) => new URL(u).hostname.toLowerCase())).size !== rpcs.length) {
      return unconfirmed("RPCs share a host");
    }

    const to = getAddress(escrow.address);
    const delegationData = encodeFunctionData({ abi: ESCROW_READ_ABI, functionName: "delegationOf", args: [payer, delegate] });
    const capsData = encodeFunctionData({ abi: ESCROW_READ_ABI, functionName: "effectiveCapsOf", args: [payer, delegate] });
    const rpcOpts = { allowed: rpcs, timeoutMs, allowLoopbackHttp: dev };

    const escrowData = encodeFunctionData({ abi: ESCROW_READ_ABI, functionName: "escrowOf", args: [payer] });

    // Round 1: chain id and latest height from every RPC.
    const heads = await Promise.allSettled(
      rpcs.map(async (url) => {
        const [id, height] = await Promise.all([ethChainId(url, rpcOpts), ethBlockNumber(url, rpcOpts)]);
        return { id, height };
      }),
    );
    const heights: bigint[] = [];
    for (const [i, h] of heads.entries()) {
      if (h.status === "rejected") return unconfirmed(`rpc[${i}] ${errorMessage(h.reason)}`);
      if (h.value.id !== chainId) return unconfirmed("an RPC is on another chain");
      heights.push(h.value.height);
    }
    const low = heights.reduce((x, y) => (y < x ? y : x));
    const high = heights.reduce((x, y) => (y > x ? y : x));
    if (high - low > MAX_BLOCK_SPREAD) return unconfirmed("RPCs are too far apart");
    if (low < 1n) return unconfirmed("no block to pin");
    // One block behind the lowest head, so every RPC has it.
    const block = low - 1n;

    // Round 2: every read at the pinned block on every RPC.
    const settled = await Promise.allSettled(
      rpcs.map(async (url): Promise<RawRead> => {
        const [delegation, caps, escrowRaw] = await Promise.all([
          ethCall(url, { to, data: delegationData }, block, rpcOpts),
          ethCall(url, { to, data: capsData }, block, rpcOpts),
          ethCall(url, { to, data: escrowData }, block, rpcOpts),
        ]);
        return { delegation, caps, escrow: escrowRaw };
      }),
    );

    const reads: RawRead[] = [];
    for (const [i, s] of settled.entries()) {
      if (s.status === "rejected") return unconfirmed(`rpc[${i}] ${errorMessage(s.reason)}`);
      reads.push(s.value);
    }
    const first = reads[0]!;
    for (const r of reads) {
      if (r.delegation !== first.delegation || r.caps !== first.caps || r.escrow !== first.escrow) {
        return unconfirmed("RPCs disagree");
      }
    }

    const decoded = decode(first);
    if (!decoded) return unconfirmed("malformed escrow answer");
    const { d, caps, e } = decoded;
    return {
      ok: true,
      value: {
        payer,
        delegate,
        active: d.validUntil !== 0n && !d.revoked,
        validUntil: d.validUntil.toString(),
        maxVoucherAmount: min(caps[0], e.maxVoucherAmount).toString(),
        maxPerWindow: min(caps[1], e.maxPerWindow).toString(),
        delegateMaxVoucherAmount: min(caps[2], d.maxVoucherAmount).toString(),
        delegateMaxPerWindow: min(caps[3], d.maxPerWindow).toString(),
        readAt,
      },
    };
  }

  /** The newest generation an invalidation or clear has passed for `key`. */
  const floor = (key: string): number => Math.max(clearedAt, floors.get(key) ?? 0);

  return {
    async readDelegation(network, payer, delegate, opts = {}) {
      const key = keyOf(network, payer, delegate);
      if (!opts.fresh) {
        const hit = cache.get(key);
        const t = now();
        if (hit && hit.gen > floor(key) && t >= hit.at && t - hit.at < CACHE_TTL_MS) {
          return { ok: true, value: hit.value };
        }
        const pending = inFlight.get(key);
        if (pending && pending.gen > floor(key)) return pending.promise;
      }
      const myGen = ++gen;
      const started = now();
      const promise = readOnce(network, payer, delegate, Math.floor(started / 1000))
        .catch(() => unconfirmed("read failed"))
        .then((res) => {
          const current = cache.get(key);
          const newest = myGen > floor(key) && (!current || current.gen < myGen);
          if (newest) {
            if (res.ok) {
              cache.delete(key);
              cache.set(key, { at: started, gen: myGen, value: res.value });
              if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
            } else {
              cache.delete(key);
            }
          }
          return res;
        })
        .finally(() => {
          if (inFlight.get(key)?.gen === myGen) inFlight.delete(key);
        });
      inFlight.set(key, { gen: myGen, promise });
      return promise;
    },
    invalidate(payer, delegate, network) {
      const key = keyOf(network, payer, delegate);
      floors.set(key, gen);
      cache.delete(key);
      inFlight.delete(key);
      if (floors.size > MAX_CACHE_ENTRIES * 4) {
        // Bounded: collapse every per-key floor into one reader-wide floor.
        floors.clear();
        clearedAt = gen;
      }
    },
    clear() {
      clearedAt = gen;
      cache.clear();
      floors.clear();
      inFlight.clear();
    },
  };
}

/**
 * Decodes both answers, refusing anything that is not exactly the canonical encoding: the right
 * length, no dirty high bits in a uint64/uint32 word, and a bool of 0 or 1.
 */
function decode(raw: RawRead): {
  d: { maxVoucherAmount: bigint; maxPerWindow: bigint; validUntil: bigint; revoked: boolean };
  caps: readonly [bigint, bigint, bigint, bigint];
  e: { maxVoucherAmount: bigint; maxPerWindow: bigint };
} | null {
  if (
    raw.delegation.length !== 2 + DELEGATION_BYTES * 2 ||
    raw.caps.length !== 2 + CAPS_BYTES * 2 ||
    raw.escrow.length !== 2 + ESCROW_BYTES * 2
  ) {
    return null;
  }
  try {
    const d = decodeFunctionResult({ abi: ESCROW_READ_ABI, functionName: "delegationOf", data: raw.delegation });
    const caps = decodeFunctionResult({ abi: ESCROW_READ_ABI, functionName: "effectiveCapsOf", data: raw.caps });
    const dAgain = encodeFunctionResult({ abi: ESCROW_READ_ABI, functionName: "delegationOf", result: d });
    const capsAgain = encodeFunctionResult({ abi: ESCROW_READ_ABI, functionName: "effectiveCapsOf", result: caps });
    const e = decodeFunctionResult({ abi: ESCROW_READ_ABI, functionName: "escrowOf", data: raw.escrow });
    const eAgain = encodeFunctionResult({ abi: ESCROW_READ_ABI, functionName: "escrowOf", result: e });
    if (
      dAgain.toLowerCase() !== raw.delegation ||
      capsAgain.toLowerCase() !== raw.caps ||
      eAgain.toLowerCase() !== raw.escrow
    ) {
      return null;
    }
    return { d, caps, e };
  } catch {
    return null;
  }
}
