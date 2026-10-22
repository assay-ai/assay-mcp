import { silentLogger, type Logger } from "../log/logger.js";
import { PinnedFetchError, type PinnedInit } from "../net/fetch.js";
import { dateHeaderOffset } from "../signer/clock.js";
import { VERSION } from "../version.js";
import {
  classify,
  errorResponse,
  METHOD_NOT_FOUND,
  MESSAGES,
  sameId,
  SERVER_ERROR,
  TIMEOUT,
  UNREACHABLE,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from "./protocol.js";

/**
 * Signed-in forwarding over Streamable HTTP (spec §7.6 "Signed-in mode", MI-13, R-MCP-15).
 *
 * - One POST per message to the pinned MCP URL with the §7.6 headers (`pinnedFetch` adds the
 *   bearer, `User-Agent` and `redirect: 'error'`, and refuses any other origin).
 * - JSON answers and SSE answers (one message per event) are parsed, bounded in size and
 *   time; 202 writes nothing. Only the response whose id equals the forwarded request's id is
 *   returned; any other response is dropped. Server notifications go to the host.
 * - Server-to-client requests are answered `-32601` to the server and never reach the host.
 * - `Mcp-Session-Id` is echoed when the server sends one. No GET stream is opened.
 * - A network failure becomes `-32003`, a timeout `-32002`; nothing here throws.
 */

/** §7.6: 120 s per forwarded request, body included. */
export const REQUEST_TIMEOUT_MS = 120_000;
/** The largest answer body read from the remote. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Forwarded requests in flight at once; more wait in a queue (fix round 1, I2). */
export const MAX_CONCURRENT = 4;
/** Requests that may wait for a slot; one more gets `-32002` at once (re-review R1-M3). */
export const MAX_QUEUE = 32;
/** How long a request may wait in that queue before it gets `-32002`. */
export const QUEUE_WAIT_MS = 30_000;
/** Bytes of answer bodies held at once across every exchange. */
export const MAX_INFLIGHT_BYTES = 32 * 1024 * 1024;
/** Server-to-client requests answered per exchange; more are ignored. */
const MAX_SERVER_REQUESTS = 8;
const SESSION_ID_RE = /^[\x21-\x7e]{1,256}$/;

export type FetchLike = (url: string, init: PinnedInit) => Promise<Response>;

export type Outcome =
  | { kind: "response"; response: JsonRpcResponse }
  | { kind: "accepted" }
  | { kind: "unauthorized" }
  | { kind: "error"; code: number; message: string };

export interface ForwarderOptions {
  /** The canonical MCP URL (`ResolvedDeployment.url`). */
  readonly url: string;
  /** `pinnedFetch` bound to the resolved deployment. */
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxConcurrent?: number;
  readonly queueWaitMs?: number;
  readonly maxQueue?: number;
  readonly maxInflightBytes?: number;
  readonly log?: Logger;
}

export interface Exchange {
  /** The exact body to POST (the host's own bytes when nothing had to change). */
  readonly body: string;
  /** The request id to pair the answer with; `null` for a notification. */
  readonly id: JsonRpcId | null;
  readonly bearer: string;
  /** The `MCP-Protocol-Version` header. */
  readonly version: string;
  /** Server notifications that arrive before the answer. */
  readonly onNotification?: (n: JsonRpcNotification) => void;
}

class TooLarge extends Error {}

/** Bytes charged against the process-wide budget by one exchange. */
class Charge {
  private held = 0;
  constructor(private readonly pool: { used: number; max: number }) {}
  add(n: number): void {
    if (this.pool.used + n > this.pool.max) throw new TooLarge();
    this.pool.used += n;
    this.held += n;
  }
  release(): void {
    this.pool.used -= this.held;
    this.held = 0;
  }
}

/** A counting semaphore with a bounded wait. */
class Slots {
  private busy = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}
  async acquire(waitMs: number): Promise<boolean> {
    if (this.busy < this.max) {
      this.busy++;
      return true;
    }
    if (this.waiting.length >= this.maxQueue) return false;
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        this.busy++;
        resolve(true);
      };
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(grant);
        if (i !== -1) this.waiting.splice(i, 1);
        resolve(false);
      }, waitMs);
      this.waiting.push(grant);
    });
  }
  release(): void {
    this.busy--;
    this.waiting.shift()?.();
  }
}

export class Forwarder {
  private sessionId: string | null = null;
  /** Server clock minus local clock (seconds) from the last answer's `Date` header (§7.7 `issuedAt`). */
  private offsetSeconds = 0;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly log: Logger;
  private readonly slots: Slots;
  private readonly pool: { used: number; max: number };

  constructor(private readonly options: ForwarderOptions) {
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.slots = new Slots(options.maxConcurrent ?? MAX_CONCURRENT, options.maxQueue ?? MAX_QUEUE);
    this.pool = { used: 0, max: options.maxInflightBytes ?? MAX_INFLIGHT_BYTES };
    this.log = (options.log ?? silentLogger).child("forward");
  }

  /** The last `Date` offset seen; unclamped (the signer's `issuedAt` clamps it to ±120 s). */
  dateOffset(): number {
    return this.offsetSeconds;
  }

  /** Forgets the session id (a new sign-in starts a new remote session). */
  reset(): void {
    this.sessionId = null;
  }

  /** The 2025-era remote handshake: `initialize`, then `notifications/initialized`. */
  async initialize(bearer: string, version: string): Promise<Outcome> {
    const id = "assay-mcp-initialize";
    const init = await this.send({
      id,
      bearer,
      version,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "assay-mcp", version: VERSION } },
      }),
    });
    if (init.kind !== "response") return init.kind === "accepted" ? { kind: "error", code: SERVER_ERROR, message: "Assay did not answer the handshake." } : init;
    if ("error" in init.response) return { kind: "error", code: SERVER_ERROR, message: "Assay refused the handshake." };
    const done = await this.send({ id: null, bearer, version, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    return done.kind === "unauthorized" || done.kind === "error" ? done : init;
  }

  /** One exchange. Never throws. Requests wait for one of the concurrent slots. */
  async send(exchange: Exchange): Promise<Outcome> {
    if (exchange.id === null) return this.exchange(exchange);
    if (!(await this.slots.acquire(this.options.queueWaitMs ?? QUEUE_WAIT_MS))) {
      this.log.warn("too many calls in flight; one was not sent");
      return { kind: "error", code: TIMEOUT, message: "Assay is busy with other calls from this app. Try again." };
    }
    try {
      return await this.exchange(exchange);
    } finally {
      this.slots.release();
    }
  }

  private async exchange(exchange: Exchange): Promise<Outcome> {
    const charge = new Charge(this.pool);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const started = Date.now();
    try {
      const res = await this.post(exchange.body, exchange.bearer, exchange.version, controller.signal);
      const outcome = await this.read(res, exchange, controller, charge);
      this.log.debug("exchange", { status: res.status, ms: Date.now() - started, outcome: outcome.kind });
      return outcome;
    } catch (err) {
      if (timedOut) return { kind: "error", code: TIMEOUT, message: MESSAGES.timeout };
      if (err instanceof TooLarge) return { kind: "error", code: SERVER_ERROR, message: "Assay's answer was too large." };
      const reason = reasonOf(err);
      this.log.warn("Assay unreachable", { reason, ms: Date.now() - started });
      return { kind: "error", code: UNREACHABLE, message: MESSAGES.unreachable(reason) };
    } finally {
      clearTimeout(timer);
      controller.abort();
      charge.release();
    }
  }

  private post(body: string, bearer: string, version: string, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": version,
    };
    if (this.sessionId !== null) headers["mcp-session-id"] = this.sessionId;
    return this.options.fetch(this.options.url, { method: "POST", headers, body, bearer, signal, log: this.log });
  }

  private async read(res: Response, exchange: Exchange, controller: AbortController, charge: Charge): Promise<Outcome> {
    if (res.status === 401) {
      await cancel(res);
      return { kind: "unauthorized" };
    }
    const date = res.headers.get("date");
    if (date !== null) this.offsetSeconds = dateHeaderOffset(date, Date.now() / 1000);
    const session = res.headers.get("mcp-session-id");
    if (session !== null && SESSION_ID_RE.test(session)) this.sessionId = session;

    if (exchange.id === null) {
      // A notification: the answer is 202 with no body; anything else is only logged.
      await cancel(res);
      if (res.status !== 202 && (res.status < 200 || res.status > 299)) this.log.warn("notification refused", { status: res.status });
      return { kind: "accepted" };
    }
    if (res.status === 202) {
      await cancel(res);
      return { kind: "error", code: SERVER_ERROR, message: "Assay sent no answer." };
    }

    const pair = new Pairing(exchange, (n) => this.answerServerRequest(n, exchange));
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    let refusalCode: string | null = null;
    let refusal: unknown;
    if (res.ok && type.startsWith("text/event-stream")) {
      await this.readSse(res, pair, controller, charge);
    } else if (type.startsWith("application/json")) {
      const text = await readBounded(res, this.maxBytes, charge);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        pair.take(parsed);
        if (!res.ok) {
          refusalCode = refusalCodeOf(parsed);
          refusal = parsed;
        }
      }
    } else {
      await cancel(res);
    }
    if (pair.response) return { kind: "response", response: pair.response };
    if (!res.ok) return { kind: "response", response: errorResponse(exchange.id, SERVER_ERROR, refusalMessage(res.status, refusalCode, refusal)) };
    return { kind: "error", code: SERVER_ERROR, message: "Assay's answer had no result for this request." };
  }

  private async readSse(res: Response, pair: Pairing, controller: AbortController, charge: Charge): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let scanFrom = 0;
    let total = 0;
    let data: string[] = [];
    let event = "";
    const dispatch = () => {
      if (data.length > 0 && (event === "" || event === "message")) {
        try {
          pair.take(JSON.parse(data.join("\n")));
        } catch {
          // not JSON: dropped
        }
      }
      data = [];
      event = "";
    };
    try {
      while (!pair.response) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBytes) throw new TooLarge();
        charge.add(value.byteLength);
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        // Only the newly appended text is searched (an unterminated line is not rescanned).
        while (!pair.response && (nl = buffer.indexOf("\n", scanFrom)) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          scanFrom = 0;
          if (line === "") dispatch();
          else if (line.startsWith(":")) continue;
          else {
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "data") data.push(value);
            else if (field === "event") event = value;
          }
        }
        scanFrom = buffer.length;
      }
      if (!pair.response) dispatch();
    } finally {
      // The answer is in (or the stream ended): stop reading; the server closes its side.
      controller.abort();
      reader.releaseLock();
    }
  }

  private answerServerRequest(id: JsonRpcId, exchange: Exchange): void {
    const body = JSON.stringify(errorResponse(id, METHOD_NOT_FOUND, "Method not found"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    void this.post(body, exchange.bearer, exchange.version, controller.signal)
      .then((res) => cancel(res))
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  }
}

/** Pairs a remote answer with the forwarded request by JSON-RPC id. */
const REFUSAL_REASONS: Readonly<Record<string, string>> = {
  AUTH_AGENT_SUSPENDED: "this agent is suspended",
  AUTH_ORGANIZATION_SUSPENDED: "this organization is suspended",
  ACCOUNT_BLOCKED: "this account is blocked",
};

/**
 * The backend's reason code from a refused request's JSON body (`code`, or `error.code`), only
 * when it has the shape of a code: nothing else of the body is ever shown.
 */
export function refusalCodeOf(body: unknown): string | null {
  const find = (v: unknown): string | null => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const code = (v as Record<string, unknown>).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : null;
  };
  const top = find(body);
  if (top !== null) return top;
  return typeof body === "object" && body !== null ? find((body as Record<string, unknown>).error) : null;
}

/** The backend's refusal of an agent key that lacks a scope the route needs (HTTP 403). */
export const SCOPE_MISSING_CODE = "AUTH_SCOPE_MISSING";
/** The scope that lets a key pay; its absence makes the key free-only. */
export const PAYMENTS_SCOPE = "payments";
const SCOPE_RE = /^[a-z][a-z0-9_-]{0,31}(?::[a-z][a-z0-9_-]{0,31})?$/;

/**
 * `context.requiredScope` of a refusal body (under `error`, or at the top), only when it has the
 * shape of a scope (`payments`, `tools:call`): nothing else of the body is ever shown.
 */
export function requiredScopeOf(body: unknown): string | null {
  const scopeIn = (v: unknown): string | null => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const context = (v as Record<string, unknown>).context;
    if (typeof context !== "object" || context === null || Array.isArray(context)) return null;
    const scope = (context as Record<string, unknown>).requiredScope;
    return typeof scope === "string" && SCOPE_RE.test(scope) ? scope : null;
  };
  const nested = typeof body === "object" && body !== null ? scopeIn((body as Record<string, unknown>).error) : null;
  return nested ?? scopeIn(body);
}

/**
 * A `tools/call` result refused with `_meta["assay/error"]` `AUTH_SCOPE_MISSING` (e.g. a free-only
 * key on a paid tool, refused `payments` with or without a voucher): the scope it names, read from
 * `assay/error.requiredScope` (where a tool refusal carries it) or `assay/error.details`, only when
 * it has the shape of a scope. `undefined` when the result is not such a refusal.
 */
export function toolScopeMissingOf(result: unknown): { scope: string | null } | undefined {
  const asObject = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const meta = asObject(asObject(result)?._meta);
  const error = asObject(meta?.["assay/error"]);
  if (error === null || error.code !== SCOPE_MISSING_CODE) return undefined;
  const named = (v: unknown) => (typeof v === "string" && SCOPE_RE.test(v) ? v : null);
  return { scope: named(error.requiredScope) ?? named(asObject(error.details)?.requiredScope) ?? requiredScopeOf(error) };
}

/** The text for `AUTH_SCOPE_MISSING`: a key without `payments` cannot pay; any other names the scope. */
export function scopeMissingText(scope: string | null): string {
  if (scope === PAYMENTS_SCOPE) return "This key cannot pay. Create a key with paid calls on.";
  return scope === null ? "This key is missing a permission this needs." : `This key is missing the ${scope} permission.`;
}

/** "Assay refused the request (HTTP 403)", plus the reason code and, for a known one, its meaning. */
export function refusalMessage(status: number, code: string | null, body?: unknown): string {
  if (code === SCOPE_MISSING_CODE) return scopeMissingText(requiredScopeOf(body));
  if (code === null) return `Assay refused the request (HTTP ${status}).`;
  const reason = REFUSAL_REASONS[code];
  return reason !== undefined ? `Assay refused the request (HTTP ${status}): ${reason} (${code}).` : `Assay refused the request (HTTP ${status}, ${code}).`;
}

class Pairing {
  response: JsonRpcResponse | null = null;
  private serverRequests = 0;

  constructor(
    private readonly exchange: Exchange,
    private readonly onServerRequest: (id: JsonRpcId) => void,
  ) {}

  take(parsed: unknown): void {
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (this.response) return;
      const c = classify(item);
      if (c.kind === "response") {
        if (sameId(c.message.id, this.exchange.id)) this.response = c.message;
      } else if (c.kind === "request") {
        if (this.serverRequests++ < MAX_SERVER_REQUESTS) this.onServerRequest(c.message.id);
      } else if (c.kind === "notification") {
        this.exchange.onNotification?.(c.message);
      }
    }
  }
}

async function cancel(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

async function readBounded(res: Response, max: number, charge: Charge): Promise<string> {
  if (!res.body) return "";
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await cancel(res);
    throw new TooLarge();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      try {
        if (total > max) throw new TooLarge();
        charge.add(value.byteLength);
      } catch (err) {
        await reader.cancel().catch(() => {});
        throw err;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A short, safe reason for `-32003`: an error code (`ECONNREFUSED`) or a fixed phrase. */
export function reasonOf(err: unknown): string {
  if (err instanceof PinnedFetchError) return "blocked: not an Assay address";
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e instanceof Error; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return "network error";
}
