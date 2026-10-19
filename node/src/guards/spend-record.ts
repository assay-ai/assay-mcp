import { withLock, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { updateState, type SpendEntry } from "../profile/profile.js";

/**
 * The G7 spend record (spec §7.8 G7, §8.4, R-MU-7): the only state voucher signing keeps.
 * Under the profile lock, entries older than 24 h are pruned, the 24 h sum is checked
 * against `perDay` (when given), and `{at, amount}` is appended to `state.json` before the
 * lock is released. No nonce or `seq` is kept.
 */

export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export class SpendLimitError extends Error {
  override readonly name = "SpendLimitError";
  constructor(
    readonly spent: bigint,
    readonly amount: bigint,
    readonly perDay: bigint,
  ) {
    super("This payment would go over the daily limit set for this computer.");
  }
}

export interface RecordOptions extends LockOptions {
  /** The rolling 24 h cap in asset base units; when set, a payment over it is refused and not recorded. */
  perDay?: bigint;
}

export interface RecordResult {
  /** The 24 h total in base units, this payment included. */
  total: bigint;
}

/** Entries still inside the 24 h window at `nowMs`. Entries dated in the future are kept (they still count). */
export function pruneSpend(entries: readonly SpendEntry[], nowMs: number): SpendEntry[] {
  return entries.filter((e) => Date.parse(e.at) > nowMs - SPEND_WINDOW_MS);
}

export function sumSpend(entries: readonly SpendEntry[]): bigint {
  return entries.reduce((sum, e) => sum + BigInt(e.amount), 0n);
}

/** Records one signed voucher of `amount` base units. */
export async function recordUnderLock(profile: ProfileRef, amount: bigint, options: RecordOptions = {}): Promise<RecordResult> {
  if (typeof amount !== "bigint" || amount <= 0n) throw new RangeError("amount must be a positive bigint");
  const now = options.now ?? Date.now;
  return withLock(
    profile,
    (lock) => {
      let total = 0n;
      updateState(profile, lock, (state) => {
        const nowMs = now();
        const kept = pruneSpend(state.signed, nowMs);
        const spent = sumSpend(kept);
        if (options.perDay !== undefined && spent + amount > options.perDay) {
          throw new SpendLimitError(spent, amount, options.perDay);
        }
        total = spent + amount;
        return { ...state, signed: [...kept, { at: new Date(nowMs).toISOString(), amount: amount.toString() }] };
      });
      return { total };
    },
    options,
  );
}
