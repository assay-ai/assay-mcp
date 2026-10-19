/**
 * MCP protocol versions and JSON-RPC shapes for the proxy (spec §7.6).
 *
 * The supported versions equal what the backend's `McpHttpBridge`
 * (`src/modules/mcp/services/mcp-http-bridge.ts`) accepts:
 * - the modern era, `2026-07-28` (`SUPPORTED_MODERN_PROTOCOL_VERSIONS` of `@modelcontextprotocol/server`
 *   2.3.1, served by `createMcpHandler`);
 * - the 2025 era, served by its stateless `WebStandardStreamableHTTPServerTransport`:
 *   `2025-11-25`, `2025-06-18`, `2025-03-26` (`SUPPORTED_PROTOCOL_VERSIONS` of
 *   `@modelcontextprotocol/core` 2.3.1, without the 2024 entries).
 * Newest first.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** The first modern-era revision: requests carry their version in `_meta`, with no `initialize`. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
/** The newest 2025-era version: what the proxy speaks to the remote when the host named none it can use there. */
export const NEWEST_LEGACY_VERSION = "2025-11-25";
/** The `_meta` key of the modern per-request envelope claim. */
export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

export function isSupportedVersion(v: unknown): v is ProtocolVersion {
  return typeof v === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v);
}

/** §7.6 step 1: the host's version if supported, else the newest supported. */
export function negotiateVersion(requested: unknown): ProtocolVersion {
  return isSupportedVersion(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}

export function isModernVersion(v: string): boolean {
  return v >= MODERN_PROTOCOL_VERSION;
}

// ---- error codes (spec §7.6, §7.15) ---------------------------------------------------

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;
/** Generic server-side failure. */
export const SERVER_ERROR = -32000;
/** Lock wait > 30 s. */
export const LOCK_BUSY = -32001;
/** No answer within 120 s. */
export const TIMEOUT = -32002;
/** The remote could not be reached. */
export const UNREACHABLE = -32003;

export const MESSAGES = {
  lockBusy: "Assay sign-in in progress in another window.",
  timeout: "Assay did not answer in time.",
  unreachable: (reason: string) => `Can't reach Assay (${reason}).`,
} as const;

// ---- JSON-RPC ---------------------------------------------------------------------------

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId | null; result: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: JsonRpcError };
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type Classified =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "response"; message: JsonRpcResponse }
  | { kind: "invalid"; id: JsonRpcId | null };

const MAX_ID_LENGTH = 512;
const MAX_METHOD_LENGTH = 256;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isValidId(v: unknown): v is JsonRpcId {
  return (typeof v === "string" && v.length <= MAX_ID_LENGTH) || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Sorts one parsed message into request, notification or response, keeping only the
 * JSON-RPC fields (a hostile message's extra members are dropped).
 */
export function classify(v: unknown): Classified {
  if (!isObject(v) || v.jsonrpc !== "2.0") return { kind: "invalid", id: isObject(v) && isValidId(v.id) ? v.id : null };
  const params = v.params;
  if (params !== undefined && !isObject(params)) return { kind: "invalid", id: isValidId(v.id) ? v.id : null };
  if (typeof v.method === "string") {
    if (v.method.length === 0 || v.method.length > MAX_METHOD_LENGTH) return { kind: "invalid", id: isValidId(v.id) ? v.id : null };
    const base = { jsonrpc: "2.0" as const, method: v.method, ...(params !== undefined ? { params } : {}) };
    if (v.id === undefined) return { kind: "notification", message: base };
    if (!isValidId(v.id)) return { kind: "invalid", id: null };
    return { kind: "request", message: { ...base, id: v.id } };
  }
  if (v.method !== undefined) return { kind: "invalid", id: isValidId(v.id) ? v.id : null };
  const id = v.id === null ? null : isValidId(v.id) ? v.id : undefined;
  if (id === undefined) return { kind: "invalid", id: null };
  if ("result" in v && !("error" in v) && isObject(v.result)) return { kind: "response", message: { jsonrpc: "2.0", id, result: v.result } };
  if ("error" in v && !("result" in v) && isObject(v.error)) {
    const e = v.error;
    if (typeof e.code !== "number" || !Number.isInteger(e.code) || typeof e.message !== "string") return { kind: "invalid", id };
    const error: JsonRpcError = { code: e.code, message: e.message, ...("data" in e ? { data: e.data } : {}) };
    return { kind: "response", message: { jsonrpc: "2.0", id, error } };
  }
  return { kind: "invalid", id };
}

export function errorResponse(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function resultResponse(id: JsonRpcId, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** The same JSON-RPC id (type and value). */
export function sameId(a: JsonRpcId | null, b: JsonRpcId | null): boolean {
  return a === b;
}

/** A Map key for an id that keeps `1` and `"1"` apart. */
export function idKey(id: JsonRpcId): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

/** The modern envelope claim of a request, when it names a supported version. */
export function envelopeVersion(message: { params?: Record<string, unknown> }): ProtocolVersion | null {
  const meta = message.params?._meta;
  if (!isObject(meta)) return null;
  const v = meta[PROTOCOL_VERSION_META_KEY];
  return isSupportedVersion(v) ? v : null;
}
