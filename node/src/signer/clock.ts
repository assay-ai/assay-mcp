/** The largest correction the HTTP `Date` header may apply to the local clock (T20). */
export const MAX_CLOCK_CORRECTION_SECONDS = 120;

/**
 * The server's clock minus the local one, in seconds, from an HTTP `Date` header. A missing or
 * unparsable header gives 0 (no correction). The result is not clamped here: `issuedAt` clamps.
 */
export function dateHeaderOffset(dateHeader: string | null | undefined, localNowSeconds: number): number {
  if (!dateHeader) return 0;
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs) || !Number.isFinite(localNowSeconds)) return 0;
  return Math.floor(serverMs / 1000) - Math.floor(localNowSeconds);
}

/**
 * A voucher's `issuedAt` (§7.7): local time corrected by the `Date` offset, with the offset
 * clamped to ±120 s, so `issuedAt` is never later than local time + 120 s nor earlier than local
 * time − 120 s, whatever a server (or a network attacker) puts in the header.
 */
export function issuedAt(localNowSeconds: number, dateHeaderOffsetSeconds: number): number {
  if (!Number.isFinite(localNowSeconds) || localNowSeconds < 0) {
    throw new Error("the local clock is not a usable time");
  }
  const offset = Number.isFinite(dateHeaderOffsetSeconds) ? dateHeaderOffsetSeconds : 0;
  const clamped = Math.max(-MAX_CLOCK_CORRECTION_SECONDS, Math.min(MAX_CLOCK_CORRECTION_SECONDS, offset));
  const local = Math.floor(localNowSeconds);
  return Math.min(local + Math.trunc(clamped), local + MAX_CLOCK_CORRECTION_SECONDS);
}
