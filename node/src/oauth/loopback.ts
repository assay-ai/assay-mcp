import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The loopback redirect of the built-in client (spec §7.14, RFC 8252 §7.3).
 *
 * - Binds `127.0.0.1` only, on an ephemeral port; another port when the first is busy.
 * - Answers only `GET /callback` whose `state` equals the expected one (compared in constant
 *   time) and whose `Host` is this listener. Anything else, including an error response with a
 *   wrong or missing `state`, gets a static 400/404 page and the flow goes on, so a web page
 *   that guesses the port cannot end or steer the sign-in.
 * - The first callback with the right `state` ends it: success (`code`) or an error response
 *   (`error`). The server then closes, as it does after `timeoutMs` (5 minutes) or an abort.
 * - Every page is static: `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, a CSP that
 *   loads nothing, and no request value (code, state, error) is ever written into it.
 */

export const CALLBACK_PATH = "/callback";
export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_TIMEOUT_MS = 5 * 60_000;
/** Ports tried in turn; 0 asks the OS for an ephemeral port. */
const DEFAULT_PORTS: readonly number[] = [0, 0, 0];

/** What the callback carried, once its `state` matched. Values are never logged. */
export type CallbackResult =
  | { readonly kind: "code"; readonly code: string; readonly iss: string | null }
  | { readonly kind: "error"; readonly error: string; readonly iss: string | null };

export type LoopbackFailure = "timeout" | "aborted" | "bind";

export class LoopbackError extends Error {
  override readonly name = "LoopbackError";
  constructor(readonly reason: LoopbackFailure) {
    super(
      reason === "timeout"
        ? "The sign-in was not finished within 5 minutes."
        : reason === "aborted"
          ? "The sign-in was cancelled."
          : "Could not open a local port for the sign-in.",
    );
  }
}

export interface LoopbackOptions {
  /** The `state` sent in the authorization request. */
  readonly state: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Ports to try in order (tests); default three ephemeral attempts. */
  readonly ports?: readonly number[];
}

export interface Loopback {
  readonly port: number;
  /** `http://127.0.0.1:{port}/callback`. */
  readonly redirectUri: string;
  /** Settles once: the first callback with the right `state`, or a `LoopbackError`. */
  readonly result: Promise<CallbackResult>;
  /** Closes the listener (idempotent); a pending `result` rejects with `aborted`. */
  close(): void;
}

const PAGE_STYLE = "body{font:16px system-ui,sans-serif;margin:3em auto;max-width:32em;padding:0 1em}";
function page(title: string, text: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>${PAGE_STYLE}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`
  );
}
export const PAGES = Object.freeze({
  done: page("Assay is connected", "You can close this window and go back to your app."),
  failed: page("Sign-in not completed", "You can close this window and try again from your app."),
  invalid: page("Not a valid sign-in", "This link does not belong to a sign-in in progress."),
  notFound: page("Not found", "Nothing here."),
});

const HEADERS = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  connection: "close",
});

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, HEADERS).end(html);
}

/** Constant-time equality of two strings of any length (compares SHA-256 digests). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/** A query parameter that appears exactly once; `null` when missing or repeated. */
function single(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  return all.length === 1 ? all[0]! : null;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as { port: number }).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host: LOOPBACK_HOST, exclusive: true });
  });
}

export async function startLoopback(options: LoopbackOptions): Promise<Loopback> {
  const { state } = options;
  if (typeof state !== "string" || state.length < 32) throw new TypeError("loopback: a strong state is required");
  if (options.signal?.aborted) throw new LoopbackError("aborted");

  let settle!: { resolve: (r: CallbackResult) => void; reject: (e: LoopbackError) => void };
  const result = new Promise<CallbackResult>((resolve, reject) => (settle = { resolve, reject }));
  // A caller that stops listening must not produce an unhandled rejection.
  result.catch(() => {});
  let finished = false;
  let port = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (finished) return send(res, 404, PAGES.notFound);
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
    } catch {
      return send(res, 404, PAGES.notFound);
    }
    // DNS rebinding: a page on another name that resolves here sends its own Host.
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || req.headers.host !== `${LOOPBACK_HOST}:${port}`) {
      return send(res, 404, PAGES.notFound);
    }
    const got = single(url.searchParams, "state");
    if (got === null || !safeEqual(got, state)) return send(res, 400, PAGES.invalid);

    const iss = single(url.searchParams, "iss");
    const code = single(url.searchParams, "code");
    const error = single(url.searchParams, "error");
    if ((code === null) === (error === null) || (code !== null && code === "") || (error !== null && error === "")) {
      // The right state with a malformed answer: the flow ends, refused.
      finish({ kind: "error", error: "invalid_response", iss });
      return send(res, 400, PAGES.failed);
    }
    finish(code !== null ? { kind: "code", code, iss } : { kind: "error", error: error!, iss });
    send(res, 200, code !== null ? PAGES.done : PAGES.failed);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 0;

  const ports = options.ports ?? DEFAULT_PORTS;
  let bound = false;
  for (const candidate of ports) {
    try {
      port = await listen(server, candidate);
      bound = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw new LoopbackError("bind");
    }
  }
  if (!bound) throw new LoopbackError("bind");
  // The listener stays ref'd while the sign-in waits, so a terminal `login` (or any caller
  // without other handles) is kept alive until the callback, the timeout or an abort; the
  // timeout timer itself is unref'd. `shutdown()` closes the listener.

  const timer = setTimeout(() => fail("timeout"), options.timeoutMs ?? LOOPBACK_TIMEOUT_MS);
  timer.unref();
  const onAbort = () => fail("aborted");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  function shutdown(): void {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    server.close();
    // Let the answer to the callback go out (`Connection: close`) before dropping the
    // connections that are still open (a browser's idle preconnects).
    setTimeout(() => server.closeAllConnections(), 1_000).unref();
  }
  function finish(r: CallbackResult): void {
    if (finished) return;
    finished = true;
    shutdown();
    settle.resolve(r);
  }
  function fail(reason: LoopbackFailure): void {
    if (finished) return;
    finished = true;
    shutdown();
    settle.reject(new LoopbackError(reason));
  }

  return {
    port,
    redirectUri: `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`,
    result,
    close: () => fail("aborted"),
  };
}
