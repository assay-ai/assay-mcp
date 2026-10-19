/**
 * A minimal JSON-RPC client for read-only chain calls: `eth_chainId`, `eth_blockNumber` and
 * `eth_call` only.
 * It never sends a transaction and holds no key. Every request goes through `pinnedPost`.
 */
import { pinnedPost } from "./pinned-fetch.js";

/** A JSON-RPC answer larger than this is treated as a failure. */
export const MAX_RESPONSE_BYTES = 16 * 1024;
/** Per-request timeout, unless the caller sets one. */
export const DEFAULT_TIMEOUT_MS = 5000;

/** Why an RPC call failed. The message never carries the URL, an address or the body. */
export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcOptions {
  /** The RPC URLs of the selected deployment entry; `url` must be one of them. */
  allowed: readonly string[];
  timeoutMs?: number;
}

const HEX = /^0x(?:[0-9a-f]{2})*$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

let nextId = 1;

async function call(url: string, method: string, params: unknown[], opts: RpcOptions): Promise<unknown> {
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  let text: string;
  try {
    text = await pinnedPost(url, body, {
      allowed: opts.allowed,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });
  } catch (err) {
    throw new RpcError(`${method}: ${err instanceof Error ? err.message : "failed"}`);
  }
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    throw new RpcError(`${method}: not JSON`);
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) throw new RpcError(`${method}: not an object`);
  const m = msg as Record<string, unknown>;
  if (m.jsonrpc !== "2.0" || m.id !== id) throw new RpcError(`${method}: bad envelope`);
  if (Object.hasOwn(m, "error")) throw new RpcError(`${method}: rpc error`);
  if (!Object.hasOwn(m, "result")) throw new RpcError(`${method}: no result`);
  return m.result;
}

/** `eth_chainId`, as a decimal number. */
export async function ethChainId(url: string, opts: RpcOptions): Promise<number> {
  const result = await call(url, "eth_chainId", [], opts);
  if (typeof result !== "string" || !QUANTITY.test(result) || result.length > 18) {
    throw new RpcError("eth_chainId: bad result");
  }
  return Number.parseInt(result, 16);
}

/** `eth_blockNumber`, as a bigint. */
export async function ethBlockNumber(url: string, opts: RpcOptions): Promise<bigint> {
  const result = await call(url, "eth_blockNumber", [], opts);
  if (typeof result !== "string" || !QUANTITY.test(result) || result.length > 18) {
    throw new RpcError("eth_blockNumber: bad result");
  }
  return BigInt(result);
}

/**
 * `eth_call` at a pinned block number; returns the raw return data as lower-case hex. Every read
 * of one agreement round uses the same block on every RPC, so both answer the same state.
 */
export async function ethCall(
  url: string,
  tx: { to: string; data: string },
  block: bigint,
  opts: RpcOptions,
): Promise<`0x${string}`> {
  if (!ADDRESS.test(tx.to) || !HEX.test(tx.data) || block < 0n) throw new RpcError("eth_call: bad request");
  const result = await call(url, "eth_call", [{ to: tx.to, data: tx.data }, `0x${block.toString(16)}`], opts);
  if (typeof result !== "string" || !HEX.test(result)) throw new RpcError("eth_call: bad result");
  return result.toLowerCase() as `0x${string}`;
}
