import { createHash } from "node:crypto";

/** Spec 8.3.1: one rule for every client, kept as data so one client can get its own values later. */
export interface NameRule {
  budget: number;
  overhead: number;
}

export const DEFAULT_RULE: NameRule = { budget: 64, overhead: 7 };

/** Longest tool name an unsigned-in or unmeasured URL is assumed to expose (toolsets spec NFR-7). */
export const SIGNED_OUT_L = 48;
/** The tool the proxy exposes before sign-in; always counted. */
export const SIGN_IN_TOOL = "assay_sign_in";
export const SEARCH_META_TOOLS = ["search_tools", "get_tool", "call_tool"] as const;
/** Without `--name` the proxy budgets for a name of this many characters. */
export const NO_NAME_BUDGET = 16;
/** `agent_connect_urls.server_name` is varchar(56). */
export const MAX_NAME_LENGTH = 56;
export const SIGN_IN_HINT = "Sign in first (`assay-mcp login`) to allow a longer name.";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const ALIAS_HASH_LENGTH = 6;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export type UrlKind = "ROOT" | "MY_TOOLSET" | "CATEGORY" | "HANDLE" | "PUBLIC_TOOLSET" | "UNLISTED_TOOLSET";

/** `_` is excluded so a name never blurs the `__` separator. */
export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name) && name.length <= MAX_NAME_LENGTH;
}

/** The longest name that fits a URL whose longest tool is `longestTool` characters (may be 0 or less: none fits). */
export function maxNameLength(longestTool: number, rule: NameRule = DEFAULT_RULE): number {
  return rule.budget - rule.overhead - longestTool;
}

export function fits(name: string, longestTool: number, rule: NameRule = DEFAULT_RULE): boolean {
  return isValidName(name) && rule.overhead + name.length + longestTool <= rule.budget;
}

export type ToolView =
  | { mode: "search"; pinned: readonly string[] }
  | { mode: "full"; tools: readonly string[] }
  | { mode: "signedOut" };

/** L(u): the longest tool name the URL's view can expose. `assay_sign_in` is always counted. */
export function longestTool(view: ToolView): number {
  if (view.mode === "signedOut") return SIGNED_OUT_L;
  const names =
    view.mode === "search" ? [...SEARCH_META_TOOLS, ...view.pinned] : [...view.tools];
  return Math.max(SIGN_IN_TOOL.length, ...names.map((n) => n.length));
}

/** Drop trailing dash-separated words of `name` until it fits; `assay` if nothing else does; null if nothing fits. */
export function suggest(name: string, L: number, rule: NameRule = DEFAULT_RULE): string | null {
  const words = name.split("-").filter(Boolean);
  while (words.length > 0) {
    const candidate = words.join("-");
    if (fits(candidate, L, rule)) return candidate;
    words.pop();
  }
  return fits("assay", L, rule) ? "assay" : null;
}

/** `assay` for the root; `assay-{slug}` otherwise, dropping trailing words, then `assay`. */
export function defaultName(
  urlKind: UrlKind,
  slugWords: readonly string[],
  L: number = SIGNED_OUT_L,
  rule: NameRule = DEFAULT_RULE,
): string {
  if (urlKind === "ROOT") return "assay";
  const words = slugWords.map((w) => w.toLowerCase()).filter((w) => /^[a-z0-9]+$/.test(w));
  while (words.length > 0) {
    const candidate = `assay-${words.join("-")}`;
    if (fits(candidate, L, rule)) return candidate;
    words.pop();
  }
  return "assay";
}

/** The first of `base`, `base-2`, `base-3`, ... not in `taken` and within the budget (the base is trimmed, never the suffix). */
export function unique(
  base: string,
  taken: readonly (string | null)[],
  L: number = SIGNED_OUT_L,
  rule: NameRule = DEFAULT_RULE,
): string {
  const used = new Set(taken.filter((t): t is string => Boolean(t)));
  if (!used.has(base)) return base;
  const room = Math.min(maxNameLength(L, rule), MAX_NAME_LENGTH);
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const head = base.slice(0, Math.max(0, room - suffix.length)).replace(/-+$/, "");
    if (head === "") break;
    const candidate = `${head}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`no free server name for "${base}" within the budget`);
}

/** The refusal for a typed name that does not fit (spec 8.3.1). Never truncates silently. */
export function refusal(name: string, L: number, rule: NameRule = DEFAULT_RULE): string {
  const max = maxNameLength(L, rule);
  const head = `\`${name}\` is too long for this server: its longest tool is ${L} characters, so the name can be at most ${max}.`;
  const suggestion = suggest(name, L, rule);
  return suggestion === null ? head : `${head} Try \`${suggestion}\`.`;
}

function base32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The name a client shows for `tool` on `server`: unchanged when it fits, else the first
 * `budget - overhead - len(server) - 7` characters, `_`, and 6 base32 characters of sha256(tool).
 */
export function aliasTool(server: string, tool: string, rule: NameRule = DEFAULT_RULE): string {
  if (rule.overhead + server.length + tool.length <= rule.budget) return tool;
  const keep = Math.max(0, rule.budget - rule.overhead - server.length - (ALIAS_HASH_LENGTH + 1));
  const digest = createHash("sha256").update(tool, "utf8").digest();
  return `${tool.slice(0, keep)}_${base32Lower(digest).slice(0, ALIAS_HASH_LENGTH)}`;
}
