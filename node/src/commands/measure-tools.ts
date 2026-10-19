/**
 * L(u) for `add` (spec §8.3.1 "Measured from: tools/list on u with the profile's token"): a
 * minimal MCP exchange on the URL (initialize, notifications/initialized, tools/list with its
 * pages), through `pinnedFetch` (built-in origins only, `redirect: 'error'`, bearer only to
 * the MCP origin). Any failure gives `null`, and `add` keeps the signed-out L = 48, the safe
 * side. Nothing is logged but method and status.
 */
import { longestTool } from "../clients/server-name.js";
import { pinnedFetch } from "../net/fetch.js";
import { requestSignal } from "../oauth/endpoints.js";
import type { ResolvedDeployment } from "../profile/deployments.js";
import { VERSION } from "../version.js";

export const PROBE_PROTOCOL_VERSION = "2025-11-25";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 50;
export const PROBE_TIMEOUT_MS = 15_000;

async function readBody(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The JSON-RPC response with `id` in a JSON or SSE answer, or null. */
export function pickResponse(contentType: string, text: string, id: number): Record<string, unknown> | null {
  const candidates: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data === "") continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        // not JSON: skipped
      }
    }
  } else {
    try {
      const parsed: unknown = JSON.parse(text);
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      return null;
    }
  }
  for (const c of candidates) {
    if (typeof c === "object" && c !== null && !Array.isArray(c) && (c as { id?: unknown }).id === id) return c as Record<string, unknown>;
  }
  return null;
}

/** The tool names `tools/list` returns on `url`, or null on any failure. */
export async function listToolNames(
  deployment: ResolvedDeployment,
  url: string,
  bearer: string,
  options: { timeoutMs?: number } = {},
): Promise<string[] | null> {
  const signal = requestSignal(options.timeoutMs ?? PROBE_TIMEOUT_MS);
  let sessionId: string | null = null;
  let nextId = 1;
  const post = async (message: Record<string, unknown>): Promise<Response> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROBE_PROTOCOL_VERSION,
    };
    if (sessionId !== null) headers["mcp-session-id"] = sessionId;
    return pinnedFetch(deployment, url, { method: "POST", headers, body: JSON.stringify(message), bearer, signal });
  };
  const request = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    const id = nextId++;
    const res = await post({ jsonrpc: "2.0", id, method, params });
    const sid = res.headers.get("mcp-session-id");
    if (sid !== null && /^[\x21-\x7e]{1,256}$/.test(sid)) sessionId = sid;
    const text = await readBody(res);
    if (res.status !== 200 || text === null) return null;
    const answer = pickResponse(res.headers.get("content-type") ?? "", text, id);
    const result = answer?.result;
    return typeof result === "object" && result !== null && !Array.isArray(result) ? (result as Record<string, unknown>) : null;
  };

  try {
    const init = await request("initialize", {
      protocolVersion: PROBE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "assay-mcp", version: VERSION },
    });
    if (init === null) return null;
    const ack = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await ack.body?.cancel().catch(() => {});
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await request("tools/list", cursor === undefined ? {} : { cursor });
      if (result === null || !Array.isArray(result.tools)) return null;
      for (const t of result.tools as unknown[]) {
        const name = (t as { name?: unknown } | null)?.name;
        if (typeof name === "string" && name !== "") names.push(name);
      }
      if (typeof result.nextCursor !== "string" || result.nextCursor === "") return names;
      cursor = result.nextCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/** L(u) from the tools the URL lists (`assay_sign_in` always counted), or null. */
export async function measureLongestTool(
  deployment: ResolvedDeployment,
  url: string,
  bearer: string,
  options: { timeoutMs?: number } = {},
): Promise<number | null> {
  const names = await listToolNames(deployment, url, bearer, options);
  return names === null ? null : longestTool({ mode: "full", tools: names });
}
