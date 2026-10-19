/**
 * A minimal origin-pinned POST for the chain reads.
 *
 * Task 2.4 owns the proxy's general origin-pinned fetch. This is a small local stand-in with the
 * same rules, to be folded into that one when the branches meet:
 * - the URL must be exactly one of the allowed URLs (the RPCs of the selected deployment entry);
 * - https, or plain http to a loopback host only (the dev and anvil entries);
 * - redirects are refused, never followed;
 * - every request has a timeout;
 * - the body is read with a byte cap, and anything larger is a failure.
 */

/** Why a pinned request failed. The message never carries the URL or the body. */
export class PinnedFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinnedFetchError";
  }
}

export interface PinnedPostOptions {
  /** The only URLs this call may reach, compared exactly. */
  allowed: readonly string[];
  timeoutMs: number;
  maxBytes: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** https anywhere, or http to a loopback host; no credentials, query or fragment. */
export function isAllowedRpcUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** POSTs a JSON body to a pinned URL and returns the response text. */
export async function pinnedPost(url: string, body: string, opts: PinnedPostOptions): Promise<string> {
  if (!opts.allowed.includes(url)) throw new PinnedFetchError("url not allowed");
  if (!isAllowedRpcUrl(url)) throw new PinnedFetchError("url scheme or host not allowed");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new PinnedFetchError(controller.signal.aborted ? "timeout" : "unreachable");
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => undefined);
      throw new PinnedFetchError("redirect refused");
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new PinnedFetchError(`http ${res.status}`);
    }
    const declared = res.headers.get("content-length");
    if (declared !== null && Number(declared) > opts.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new PinnedFetchError("response too large");
    }
    return await readCapped(res, opts.maxBytes, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PinnedFetchError("response too large");
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof PinnedFetchError) throw err;
    throw new PinnedFetchError(signal.aborted ? "timeout" : "read failed");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PinnedFetchError("response is not utf-8");
  }
}
