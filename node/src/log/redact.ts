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
const SECRET_KEYS = "code|code_verifier|request|rid|state|token|access_token|refresh_token|id_token|key|api_key|client_secret";
/** Also matches at the very start of the text, so a form body `code_verifier=…&…` is covered. */
const QUERY_SECRET = new RegExp(`((?:^|[?&#;])(?:${SECRET_KEYS})=)[^&#\\s"']+`, "gi");
/** A secret key inside JSON text: `"code_verifier":"…"`, also with escaped quotes. Key must be quoted, so prose survives. */
const JSON_SECRET = new RegExp(`(\\\\?["'](?:${SECRET_KEYS})\\\\?["']\\s*:\\s*\\\\?["'])[^"'\\\\]*`, "gi");
/** A bare `Basic <base64>` credential. Needs a digit, `+`, `/`, `=` or a lower-to-upper step, so "Basic Configuration" survives. */
const BASIC = /\b(Basic)\s+(?=[A-Za-z0-9+/_-]*(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/_-]{8,}={0,2}/g;

export const REDACTED = "[redacted]";

/** Replaces every secret-shaped substring of `text` with `[redacted]`. */
export function redact(text: string): string {
  return text
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
