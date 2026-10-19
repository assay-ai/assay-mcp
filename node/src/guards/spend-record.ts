import { withLock, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { updateState, usdToUnits, type SpendEntry } from "../profile/profile.js";
import { SPEND_WINDOW_SECONDS } from "./guards.js";
import type { LocalLimits } from "./types.js";

/**
 * The G7 spend record (spec §7.8 G7, §8.4, R-MU-7): the only state voucher signing keeps.
 * In one hold of the profile lock: entries older than 24 h are pruned, the 24 h sum plus
 * this amount is checked against `perDay`, and `{at, amount}` is appended to `state.json`
 * before the lock is released. Money is `bigint` base units throughout. No nonce or `seq`.
 */

/** An entry dated further ahead than this (a clock error) is re-dated to now when recorded. */
export const FUTURE_SLACK_SECONDS = 300;

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
  /** The profile's limits (`limits.json`); `perDay` is converted exactly, rounded down. Required. */
  limits: Pick<LocalLimits, "perDay">;
  /** The asset's decimals from the built-in network entry. */
  decimals: number;
}

export interface RecordResult {
  /** The 24 h total in base units, this payment included. */
  total: bigint;
}

/**
 * Entries still inside the 24 h window at `nowSeconds` (every entry with `at > now - 86400`
 * counts, as in the G7 guard). Entries dated more than 5 min ahead are re-dated to now.
 */
export function pruneSpend(entries: readonly SpendEntry[], nowSeconds: number): SpendEntry[] {
  return entries
    .filter((e) => e.at > nowSeconds - SPEND_WINDOW_SECONDS)
    .map((e) => (e.at > nowSeconds + FUTURE_SLACK_SECONDS ? { at: nowSeconds, amount: e.amount } : e));
}

export function sumSpend(entries: readonly SpendEntry[]): bigint {
  return entries.reduce((sum, e) => sum + BigInt(e.amount), 0n);
}

/** Records one signed voucher of `amount` base units, refusing it when the 24 h cap would be passed. */
export async function recordUnderLock(profile: ProfileRef, amount: bigint, options: RecordOptions): Promise<RecordResult> {
  if (typeof amount !== "bigint" || amount <= 0n) throw new RangeError("amount must be a positive bigint");
  if (!options || !options.limits) throw new TypeError("the limits are required");
  const perDay = usdToUnits(options.limits.perDay, options.decimals);
  const now = options.now ?? Date.now;
  return withLock(
    profile,
    (lock) => {
      let total = 0n;
      updateState(profile, lock, (state) => {
        const nowSeconds = Math.floor(now() / 1000);
        const kept = pruneSpend(state.signed, nowSeconds);
        const spent = sumSpend(kept);
        if (spent + amount > perDay) throw new SpendLimitError(spent, amount, perDay);
        total = spent + amount;
        return { ...state, signed: [...kept, { at: nowSeconds, amount: amount.toString() }] };
      });
      return { total };
    },
    options,
  );
}
