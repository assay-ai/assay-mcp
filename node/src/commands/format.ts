/** Display helpers for the profile commands: dollars and dates, exact (no floating point). */
import { usdToUnits } from "../profile/profile.js";

/** Asset base units as dollars: `$5`, `$0.50`, `$1.20`, `$0.000001` (two decimals at least when not whole). */
export function unitsToUsd(units: bigint | string, decimals: number): string {
  const value = typeof units === "bigint" ? units : BigInt(units);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let fraction = decimals > 0 ? (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  if (fraction !== "" && fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${negative ? "-" : ""}$${whole}${fraction ? `.${fraction}` : ""}`;
}

/** A `limits.json` dollar string for display: `"0.50"` → `$0.50`, `"5"` → `$5`. */
export function usd(dollars: string): string {
  return unitsToUsd(usdToUnits(dollars, 6), 6);
}

/** Unix seconds as a UTC calendar date, `2026-11-18`. */
export function utcDate(seconds: number | bigint | string): string {
  const ms = Number(BigInt(seconds) * 1000n);
  if (!Number.isFinite(ms) || ms > 8.64e15) return "never";
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Names, keys and messages come from project configs that may be hostile: control characters
 * (C0, DEL, C1), line and paragraph separators and bidi controls are shown as `\uXXXX`, so
 * terminal escape sequences cannot rewrite or hide a finding.
 */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
