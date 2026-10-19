// A child process for the cross-process N2 test: lowers perDay in limits.json, like `limits set`.
// argv: <dir> <profile> <perDayUsd>
import { withLock } from "../../src/profile/lock.js";
import { writeLimits } from "../../src/profile/profile.js";

const [dir, name, perDay] = process.argv.slice(2) as [string, string, string];
withLock({ dir, name }, (lock) => writeLimits({ dir, name }, lock, { perCall: "0.50", perDay, confirmAbove: null, providers: null }), { timeoutMs: 60_000 }).then(
  () => process.send?.("lowered", () => process.exit(0)),
  (err: unknown) => process.send?.(`error ${String(err)}`, () => process.exit(0)),
);
