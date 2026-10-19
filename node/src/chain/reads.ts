/**
 * The proxy's read-only view of the escrow: the delegate grant and its caps (G4, G6; spec §7.8,
 * §7.15, M6).
 *
 * - Two views only, with the backend's ABI: `delegationOf(payer, delegate)` and
 *   `effectiveCapsOf(payer, delegate)` (`assay-evm/src/X402Escrow.sol`).
 * - The escrow and the RPCs come from the selected entry of `deployments.json`, never from the
 *   server or from code.
 * - Every listed RPC is read, and each must answer the same chain id and the same bytes. A
 *   failure, a timeout or any disagreement gives `CHAIN_UNCONFIRMED`, which guards treat as "no
 *   read" (fail closed).
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
import { DEFAULT_TIMEOUT_MS, ethCall, ethChainId } from "./rpc.js";

/** How long an agreed read stands (G4: "at most every 10 minutes"). */
export const CACHE_TTL_MS = 10 * 60 * 1000;
/** Cached entries per reader; the oldest is dropped beyond this. */
const MAX_CACHE_ENTRIES = 64;

/** The two escrow views, verbatim from the backend's `X402_ESCROW_ABI`. */
export const ESCROW_READ_ABI = parseAbi([
  "struct Delegation { uint64 maxVoucherAmount; uint64 maxPerWindow; uint64 spentInWindow; uint64 windowStartedAt; uint64 validUntil; uint32 listPosition; bool revoked; }",
  "function delegationOf(address payer, address delegate) view returns (Delegation)",
  "function effectiveCapsOf(address payer, address delegate) view returns (uint64 maxVoucherAmount, uint64 maxPerWindow, uint64 delegateMaxVoucherAmount, uint64 delegateMaxPerWindow)",
]);

/** ABI-encoded return sizes: a static 7-word tuple and 4 words. */
const DELEGATION_BYTES = 7 * 32;
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
  /** The escrow's cap per voucher, `effectiveCapsOf(...).maxVoucherAmount`. */
  maxVoucherAmount: string;
  /** The escrow's cap per window, `effectiveCapsOf(...).maxPerWindow`. */
  maxPerWindow: string;
  /**
   * The delegate's cap per voucher: the lower of `effectiveCapsOf(...).delegateMaxVoucherAmount`
   * (0 when the grant cannot sign now) and the current grant's `maxVoucherAmount`.
   */
  delegateMaxVoucherAmount: string;
  /** Same rule for the delegate's window cap. */
  delegateMaxPerWindow: string;
}

export type DelegationResult =
  | { ok: true; value: DelegationState }
  | { ok: false; code: "CHAIN_UNCONFIRMED"; reason: string };

/** The guard's `chain` input (G4, G6): the agreed state, or `null` when there is none. */
export interface GuardChainState {
  payer: string;
  active: boolean;
  validUntil: string;
  maxVoucherAmount: string;
  delegateMaxVoucherAmount: string;
}

export function toGuardChain(result: DelegationResult): GuardChainState | null {
  if (!result.ok) return null;
  const v = result.value;
  return {
    payer: v.payer,
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

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

interface RawRead {
  chainId: number;
  delegation: `0x${string}`;
  caps: `0x${string}`;
}

export function createChainReader(options: ChainReaderOptions): ChainReader {
  const table = options.deployments ?? builtInDeployments();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cache = new Map<string, { at: number; value: DelegationState }>();
  const inFlight = new Map<string, Promise<DelegationResult>>();

  async function readOnce(network: string, payerIn: string, delegateIn: string): Promise<DelegationResult> {
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
    const minRpc = DEV_ENVIRONMENTS.includes(options.environment) ? 1 : 2;
    if (rpcs.length < minRpc || new Set(rpcs).size !== rpcs.length) return unconfirmed("not enough RPCs");
    if (rpcs.some((u) => isPlaceholder(u) || !isAllowedRpcUrl(u))) return unconfirmed("RPC not usable");

    const to = getAddress(escrow.address);
    const delegationData = encodeFunctionData({ abi: ESCROW_READ_ABI, functionName: "delegationOf", args: [payer, delegate] });
    const capsData = encodeFunctionData({ abi: ESCROW_READ_ABI, functionName: "effectiveCapsOf", args: [payer, delegate] });
    const rpcOpts = { allowed: rpcs, timeoutMs };

    const settled = await Promise.allSettled(
      rpcs.map(async (url): Promise<RawRead> => {
        const [id, delegation, caps] = await Promise.all([
          ethChainId(url, rpcOpts),
          ethCall(url, { to, data: delegationData }, rpcOpts),
          ethCall(url, { to, data: capsData }, rpcOpts),
        ]);
        return { chainId: id, delegation, caps };
      }),
    );

    const reads: RawRead[] = [];
    for (const [i, s] of settled.entries()) {
      if (s.status === "rejected") {
        return unconfirmed(`rpc[${i}] ${s.reason instanceof Error ? s.reason.message : "failed"}`);
      }
      reads.push(s.value);
    }
    const first = reads[0]!;
    for (const r of reads) {
      if (r.chainId !== chainId) return unconfirmed("an RPC is on another chain");
      if (r.delegation !== first.delegation || r.caps !== first.caps) return unconfirmed("RPCs disagree");
    }

    const decoded = decode(first);
    if (!decoded) return unconfirmed("malformed escrow answer");
    const { d, caps } = decoded;
    return {
      ok: true,
      value: {
        payer,
        delegate,
        active: d.validUntil !== 0n && !d.revoked,
        validUntil: d.validUntil.toString(),
        maxVoucherAmount: caps[0].toString(),
        maxPerWindow: caps[1].toString(),
        delegateMaxVoucherAmount: min(caps[2], d.maxVoucherAmount).toString(),
        delegateMaxPerWindow: min(caps[3], d.maxPerWindow).toString(),
      },
    };
  }

  return {
    async readDelegation(network, payer, delegate, opts = {}) {
      const key = JSON.stringify([options.profile, network, String(payer).toLowerCase(), String(delegate).toLowerCase()]);
      if (!opts.fresh) {
        const hit = cache.get(key);
        if (hit && now() - hit.at < CACHE_TTL_MS && now() >= hit.at) return { ok: true, value: hit.value };
        const pending = inFlight.get(key);
        if (pending) return pending;
      }
      const started = now();
      const p = readOnce(network, payer, delegate)
        .catch(() => unconfirmed("read failed"))
        .then((res) => {
          if (res.ok) {
            cache.delete(key);
            cache.set(key, { at: started, value: res.value });
            if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
          } else {
            cache.delete(key);
          }
          return res;
        })
        .finally(() => {
          if (inFlight.get(key) === p) inFlight.delete(key);
        });
      inFlight.set(key, p);
      return p;
    },
    clear() {
      cache.clear();
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
} | null {
  if (raw.delegation.length !== 2 + DELEGATION_BYTES * 2 || raw.caps.length !== 2 + CAPS_BYTES * 2) return null;
  try {
    const d = decodeFunctionResult({ abi: ESCROW_READ_ABI, functionName: "delegationOf", data: raw.delegation });
    const caps = decodeFunctionResult({ abi: ESCROW_READ_ABI, functionName: "effectiveCapsOf", data: raw.caps });
    const dAgain = encodeFunctionResult({ abi: ESCROW_READ_ABI, functionName: "delegationOf", result: d });
    const capsAgain = encodeFunctionResult({ abi: ESCROW_READ_ABI, functionName: "effectiveCapsOf", result: caps });
    if (dAgain.toLowerCase() !== raw.delegation || capsAgain.toLowerCase() !== raw.caps) return null;
    return { d, caps };
  } catch {
    return null;
  }
}
