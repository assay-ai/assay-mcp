// A child process for the cross-process G7 test: records one voucher, prints the outcome.
// argv: <dir> <profile> <amount> <perDayUsd>
import { recordUnderLock, SpendLimitError } from "../../src/guards/spend-record.js";

const [dir, name, amount, perDay] = process.argv.slice(2) as [string, string, string, string];
recordUnderLock({ dir, name }, BigInt(amount), { limits: { perDay }, decimals: 6, timeoutMs: 60_000 }).then(
  () => process.send?.("recorded", () => process.exit(0)),
  (err: unknown) => process.send?.(err instanceof SpendLimitError ? "refused" : `error ${String(err)}`, () => process.exit(0)),
);
