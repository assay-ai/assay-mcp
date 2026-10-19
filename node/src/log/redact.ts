/**
 * The redaction backstop (spec §7.13). Call sites never pass secrets to the logger; this
 * filter catches the ones that slip through anyway, on every line before it is written.
 */

/** Access, refresh, authorization-code and API-key tokens. */
export const TOKEN_PATTERN = /assay_(at|rt|ac|sk_live)_[A-Za-z0-9_-]+/g;
/** A 32-byte hex value: a private key, a digest, a hash. */
export const HEX32_PATTERN = /0x[0-9a-fA-F]{64}/g;
/** A 65-byte hex value: an ECDSA signature. */
export const HEX65_PATTERN = /0x[0-9a-fA-F]{130}/g;

/**
 * Any `0x` run of 64 or more hex digits, so a longer value (two keys back to back, a
 * signature) is never cut into a redacted head and a readable tail. It covers both
 * {@link HEX32_PATTERN} and {@link HEX65_PATTERN}.
 */
const LONG_HEX = /0x[0-9a-fA-F]{64,}/g;
/** A bare run of 64 or more hex digits (a key or hash without its `0x`). */
const BARE_LONG_HEX = /(?<![0-9A-Za-z])[0-9a-fA-F]{64,}(?![0-9A-Za-z])/g;
/** A bearer credential, whatever its format. */
const BEARER = /\b(Bearer)\s+[^\s"',;]+/gi;

export const REDACTED = "[redacted]";

/** Replaces every secret-shaped substring of `text` with `[redacted]`. */
export function redact(text: string): string {
  return text
    .replace(TOKEN_PATTERN, REDACTED)
    .replace(LONG_HEX, REDACTED)
    .replace(HEX65_PATTERN, REDACTED)
    .replace(HEX32_PATTERN, REDACTED)
    .replace(BARE_LONG_HEX, REDACTED)
    .replace(BEARER, `$1 ${REDACTED}`);
}
