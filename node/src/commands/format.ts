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
