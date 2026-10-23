/**
 * The redaction backstop (spec §7.13). Call sites never pass secrets to the logger; this
 * filter catches the ones that slip through anyway, on every line before it is written.
 */

/** Access, refresh, authorization-code and API-key tokens. */
export const TOKEN_PATTERN = /assay_(at|rt|ac|sk_live)_[A-Za-z0-9_-]+/g;
/** A 32-byte hex value: a private key, a digest, a hash. Prefix matched in either case. */
export const HEX32_PATTERN = /0x[0-9a-fA-F]{64}/gi;
/** A 65-byte hex value: an ECDSA signature. Prefix matched in either case. */
export const HEX65_PATTERN = /0x[0-9a-fA-F]{130}/gi;

/**
 * Any `0x`/`0X` run of 64 or more hex digits, so a longer value is never cut into a redacted
 * head and a readable tail. It covers both {@link HEX32_PATTERN} and {@link HEX65_PATTERN}.
 */
const LONG_HEX = /0[xX][0-9a-fA-F]{64,}/g;
/**
 * A bare run of 64 or more hex digits anywhere, even glued to other letters (`pk4f3e…`).
 * No §7.13 "logged" item is 32 bytes of hex; a transaction hash, if ever needed, is logged
 * truncated.
 */
const BARE_LONG_HEX = /[0-9a-fA-F]{64,}/g;
/** `Authorization: <scheme> <value>` / `authorization=…` in any scheme (Bearer, Basic, …). */
const AUTH_HEADER = /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s"',;&]+/gi;
/** A bearer credential on its own, whatever its format. */
const BEARER = /\b(Bearer)\s+[^\s"',;&]+/gi;
/**
 * Secrets carried in a URL query or fragment without an `assay_` prefix: the consent request
 * id, OAuth codes, PKCE verifiers, `state`, and tokens.
 */
const SECRET_KEYS =
  "code|code_verifier|request|rid|state|token|access_token|access-token|refresh_token|refresh-token|id_token|key|api_key|api-key|apikey|client_secret";
/** Also matches at the very start of the text, so a form body `code_verifier=…&…` is covered. */
const QUERY_SECRET = new RegExp(`((?:^|[?&#;])(?:${SECRET_KEYS})=)[^&#\\s"']+`, "gi");
/**
 * The same inside a percent-encoded URL (`%3Fkey%3D…`, `%253Fkey%253D…`): the separators and the
 * `=` encoded once or more. The value runs over `%xx` escapes up to an encoded `&`, `#` or `?`.
 */
const QUERY_SECRET_ENCODED = new RegExp(
  String.raw`(%(?:25){0,8}(?:3F|26|23|3B)(?:${SECRET_KEYS})%(?:25){0,8}3D)(?:[^&#\s"'%]|%(?!(?:25){0,8}(?:26|23|3F))[0-9A-Fa-f]{2})+`,
  "gi",
);
/** A secret key inside JSON text: `"code_verifier":"…"`, also with escaped quotes. Key must be quoted, so prose survives. */
const JSON_SECRET = new RegExp(`(\\\\?["'](?:${SECRET_KEYS})\\\\?["']\\s*:\\s*\\\\?["'])[^"'\\\\]*`, "gi");
/** A bare `Basic <base64>` credential. Needs a digit, `+`, `/`, `=` or a lower-to-upper step, so "Basic Configuration" survives. */
const BASIC = /\b(Basic)\s+(?=[A-Za-z0-9+/_-]*(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/_-]{8,}={0,2}/g;

export const REDACTED = "[redacted]";

/**
 * One `/` of an MCP URL as text can carry it: raw, JSON-escaped (`\/`, `\\/`, `\u002F`) or
 * percent-encoded once or more (`%2F`, `%252F`, …). Every repeat is bounded, so a long run of
 * backslashes or `%25` costs linear time.
 */
const SLASH = String.raw`(?:\\{0,8}\/|\\{1,8}u002F|%(?:25){0,8}2F)`;
/** The `u` of `/u/`, raw or percent-encoded (`%75`, `%2575`, …). */
const LETTER_U = String.raw`(?:u|%(?:25){0,8}75)`;
/**
 * A link-only tool set's token in an MCP URL path (`/u/{token}`), in any mix of the forms
 * {@link SLASH} covers (`%2Fu/…`, `/u%2F…`, `\/u\/…`, `/u//…`). The token ends at the next
 * separator, raw or encoded (`/`, `?`, `#`, `@`, `%…`, `\…`).
 */
const MCP_LINK_TOKEN = new RegExp(String.raw`(${SLASH}${LETTER_U}${SLASH}{1,4})[^\\/?#@%\s"'&;,)]+`, "gi");

/**
 * An MCP URL with its secrets removed: the link-only token in the path (`/u/[redacted]`, kept
 * pinned as `/u/[redacted]@2`) and any key or token in the query. Safe on any text. Used by
 * {@link redact} (every log line, command error messages), by the CLI usage error (stderr,
 * which MCP hosts keep in their logs) and by the paid-calls-off text the agent's model reads.
 * The person's own terminal output of `add`, `list` and `allow-paid` keeps the full URL on
 * purpose: it is their link, and the printed `allow-paid` command must work when copied.
 */
export function redactMcpUrl(text: string): string {
  return text
    .replace(MCP_LINK_TOKEN, `$1${REDACTED}`)
    .replace(QUERY_SECRET, `$1${REDACTED}`)
    .replace(QUERY_SECRET_ENCODED, `$1${REDACTED}`);
}

/** Replaces every secret-shaped substring of `text` with `[redacted]`. */
export function redact(text: string): string {
  return redactMcpUrl(text)
    .replace(TOKEN_PATTERN, REDACTED)
    .replace(LONG_HEX, REDACTED)
    .replace(HEX65_PATTERN, REDACTED)
    .replace(HEX32_PATTERN, REDACTED)
    .replace(BARE_LONG_HEX, REDACTED)
    .replace(AUTH_HEADER, `$1$2${REDACTED}`)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(BASIC, `$1 ${REDACTED}`)
    .replace(JSON_SECRET, `$1${REDACTED}`)
    .replace(QUERY_SECRET, `$1${REDACTED}`);
}
