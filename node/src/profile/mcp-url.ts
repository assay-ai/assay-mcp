/**
 * MCP URL parsing and the canonical form, ported from the server's
 * `src/modules/toolset/domain/mcp-url.ts` (`parseMcpUrl`, `parseMcpAbsoluteUrl`,
 * `canonicalUrl`). `--url` is canonicalised exactly as the server does it, so the proxy and
 * the server agree on the cache key and the paid-URL allow list. Keep the two in step.
 */

export type McpPath =
  | { readonly kind: "ROOT" }
  | { readonly kind: "MY_TOOLSET"; readonly slug: string; readonly version: number | null }
  | { readonly kind: "CATEGORY"; readonly category: string }
  | { readonly kind: "HANDLE"; readonly handle: string }
  | { readonly kind: "PUBLIC_TOOLSET"; readonly handle: string; readonly slug: string; readonly version: number | null }
  | { readonly kind: "UNLISTED_TOOLSET"; readonly token: string; readonly version: number | null };

export type DiscoveryMode = "auto" | "full" | "search";
const DISCOVERY_MODES: readonly DiscoveryMode[] = ["auto", "full", "search"];

export interface ToolSelector {
  readonly name: string;
  readonly major: number | null;
}

export interface ViewFilter {
  readonly tools: readonly ToolSelector[] | null;
  readonly categories: readonly string[] | null;
  readonly free: boolean;
  readonly discovery: DiscoveryMode | null;
}

export interface ParsedMcpUrl {
  readonly path: McpPath;
  readonly filter: ViewFilter;
}

export const MAX_MCP_URL_LENGTH = 2_048;
export const MAX_TOOLS_IN_FILTER = 50;

const SLUG_RE = /^[a-z0-9-]{2,64}$/;
const HANDLE_RE = /^[a-z][a-z0-9-]{2,23}$/;
const CATEGORY_RE = /^[a-z][a-z0-9-]{1,63}$/;
const TOKEN_RE = /^[a-z0-9_-]{22,64}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,47}$/;
const VERSION_RE = /^[1-9][0-9]{0,5}$/;

/** `path?query` (still percent-encoded) → parsed, or `null` when it is not an accepted form. */
export function parseMcpUrl(pathAndQuery: string): ParsedMcpUrl | null {
  if (pathAndQuery.length > MAX_MCP_URL_LENGTH) return null;
  const queryAt = pathAndQuery.indexOf("?");
  const rawPath = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? "" : pathAndQuery.slice(queryAt + 1);
  const path = parsePath(rawPath);
  if (!path) return null;
  const filter = parseQuery(rawQuery);
  if (!filter) return null;
  return { path, filter: withoutDefaultDiscovery(filter, defaultDiscoveryFor(filter, staticDiscoveryDefault(path))) };
}

/** A full URL → parsed, when it is on `base`'s origin and carries no credentials. */
export function parseMcpAbsoluteUrl(url: string, base: string): ParsedMcpUrl | null {
  if (url.length > MAX_MCP_URL_LENGTH) return null;
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(url);
    origin = new URL(base);
  } catch {
    return null;
  }
  if (parsed.origin !== origin.origin) return null;
  if (parsed.username || parsed.password) return null;
  // `URL` resolves `.` and `..` itself; re-read the raw path so a dot segment is refused.
  const afterOrigin = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  const withoutFragment = afterOrigin.split("#")[0] ?? "";
  return parseMcpUrl(withoutFragment === "" ? "/" : withoutFragment);
}

export function canonicalPath(path: McpPath): string {
  switch (path.kind) {
    case "ROOT":
      return "/";
    case "MY_TOOLSET":
      return `/my/${path.slug}${versionSuffix(path.version)}`;
    case "CATEGORY":
      return `/c/${path.category}`;
    case "HANDLE":
      return `/@${path.handle}`;
    case "PUBLIC_TOOLSET":
      return `/@${path.handle}/${path.slug}${versionSuffix(path.version)}`;
    case "UNLISTED_TOOLSET":
      return `/u/${path.token}${versionSuffix(path.version)}`;
  }
}

export function canonicalQuery(filter: ViewFilter): string {
  const parts: string[] = [];
  if (filter.tools) parts.push(`tools=${filter.tools.map(selectorText).join(",")}`);
  if (filter.categories) parts.push(`category=${filter.categories.join(",")}`);
  if (filter.free) parts.push("free=1");
  if (filter.discovery) parts.push(`discovery=${filter.discovery}`);
  return parts.join("&");
}

/** `base` + canonical path + canonical query. */
export function canonicalUrl(base: string, parsed: ParsedMcpUrl): string {
  const query = canonicalQuery(parsed.filter);
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}${canonicalPath(parsed.path)}${query ? `?${query}` : ""}`;
}

function staticDiscoveryDefault(path: McpPath): DiscoveryMode | null {
  switch (path.kind) {
    case "ROOT":
      return "search";
    case "CATEGORY":
    case "HANDLE":
      return "auto";
    default:
      return null;
  }
}

function defaultDiscoveryFor(filter: Pick<ViewFilter, "tools">, pathDefault: DiscoveryMode | null): DiscoveryMode | null {
  return filter.tools && pathDefault === "search" ? "auto" : pathDefault;
}

function withoutDefaultDiscovery(filter: ViewFilter, defaultMode: DiscoveryMode | null): ViewFilter {
  return filter.discovery && filter.discovery === defaultMode ? { ...filter, discovery: null } : filter;
}

function parsePath(raw: string): McpPath | null {
  if (!raw.startsWith("/")) return null;
  const decoded = raw.replace(/%40/gi, "@");
  if (decoded.includes("%")) return null;
  const lower = decoded.toLowerCase();
  if (lower === "/") return { kind: "ROOT" };
  const trimmed = lower.endsWith("/") ? lower.slice(0, -1) : lower;
  const segments = trimmed.slice(1).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const [first = "", ...rest] = segments;

  if (first.startsWith("@")) {
    const handle = first.slice(1);
    if (!HANDLE_RE.test(handle)) return null;
    if (rest.length === 0) return { kind: "HANDLE", handle };
    if (rest.length !== 1) return null;
    const pinned = splitVersion(rest[0] ?? "");
    if (!pinned || !SLUG_RE.test(pinned.name)) return null;
    return { kind: "PUBLIC_TOOLSET", handle, slug: pinned.name, version: pinned.version };
  }

  if (rest.length !== 1) return null;
  const second = rest[0] ?? "";
  switch (first) {
    case "my": {
      const pinned = splitVersion(second);
      if (!pinned || !SLUG_RE.test(pinned.name)) return null;
      return { kind: "MY_TOOLSET", slug: pinned.name, version: pinned.version };
    }
    case "c":
      return CATEGORY_RE.test(second) ? { kind: "CATEGORY", category: second } : null;
    case "u": {
      const pinned = splitVersion(second);
      if (!pinned || !TOKEN_RE.test(pinned.name)) return null;
      return { kind: "UNLISTED_TOOLSET", token: pinned.name, version: pinned.version };
    }
    default:
      return null;
  }
}

function parseQuery(raw: string): ViewFilter | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const toolTexts = listParam(params, "tools");
  let tools: ToolSelector[] | null = null;
  if (toolTexts) {
    const selectors = new Map<string, ToolSelector>();
    for (const text of toolTexts) {
      const selector = parseSelector(text);
      if (!selector) return null;
      selectors.set(selectorText(selector), selector);
    }
    if (selectors.size > MAX_TOOLS_IN_FILTER) return null;
    tools = [...selectors.values()].sort((a, b) => compare(selectorText(a), selectorText(b)));
  }
  const categoryTexts = listParam(params, "category");
  let categories: string[] | null = null;
  if (categoryTexts) {
    if (categoryTexts.some((c) => !CATEGORY_RE.test(c))) return null;
    categories = [...new Set(categoryTexts)].sort(compare);
  }
  const freeValues = params.getAll("free").map((v) => v.trim());
  if (freeValues.some((v) => v !== "0" && v !== "1")) return null;
  const free = freeValues.length > 0 && freeValues[freeValues.length - 1] === "1";
  const discoveryValues = params.getAll("discovery");
  let discovery: DiscoveryMode | null = null;
  if (discoveryValues.length > 0) {
    const value = (discoveryValues[discoveryValues.length - 1] ?? "").trim().toLowerCase();
    if (!(DISCOVERY_MODES as readonly string[]).includes(value)) return null;
    discovery = value as DiscoveryMode;
  }
  return { tools, categories, free, discovery };
}

function listParam(params: URLSearchParams, key: string): string[] | null {
  const values = params
    .getAll(key)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v !== "");
  return values.length > 0 ? values : null;
}

function parseSelector(text: string): ToolSelector | null {
  const pinned = splitVersion(text);
  if (!pinned || !TOOL_NAME_RE.test(pinned.name)) return null;
  return { name: pinned.name, major: pinned.version };
}

function splitVersion(text: string): { name: string; version: number | null } | null {
  const at = text.lastIndexOf("@");
  if (at === -1) return { name: text, version: null };
  const version = text.slice(at + 1);
  if (!VERSION_RE.test(version)) return null;
  return { name: text.slice(0, at), version: Number(version) };
}

function selectorText(s: ToolSelector): string {
  return s.major === null ? s.name : `${s.name}@${s.major}`;
}

function versionSuffix(version: number | null): string {
  return version === null ? "" : `@${version}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
