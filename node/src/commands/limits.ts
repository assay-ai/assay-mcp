/**
 * `assay-mcp limits [--profile <name>]` shows the local caps (G7, G8);
 * `assay-mcp limits set --per-call <usd> --per-day <usd> [--confirm-above <usd>|off]
 * [--providers <0x…,…>|off] [--profile <name>]` changes them, only on a TTY (spec §7.3) and
 * under the profile lock. No server response, web page, project config or flag of `serve`
 * can change them.
 */
import { getAddress, isAddress } from "viem";
import { EXIT_OK } from "../exit-codes.js";
import { withLock } from "../profile/lock.js";
import { readLimits, USD_RE, usdToUnits, writeLimits, type Limits } from "../profile/profile.js";
import { requireTty } from "../tty.js";
import { parseFlags, UsageError } from "./context.js";
import { usd } from "./format.js";
import { checkProfileName, defaultProfileDeps, profileRef, reportFailure, type ProfileDeps } from "./profile-context.js";

export function limitsLine(l: Omit<Limits, "version">): string {
  const providers = l.providers === null ? "any" : l.providers.join(", ");
  return `${usd(l.perCall)} a call · ${usd(l.perDay)} per 24 h · confirm above: ${l.confirmAbove === null ? "off" : usd(l.confirmAbove)} · providers: ${providers}`;
}

function dollars(flag: string, value: string): string {
  const v = value.trim().replace(/^\$/, "");
  if (!USD_RE.test(v)) throw new UsageError(`--${flag} must be a dollar amount such as 0.50`);
  return v;
}

function providerList(value: string): string[] | null {
  if (value.trim() === "off") return null;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0 || items.length > 100) throw new UsageError("--providers takes 1 to 100 addresses (0x…), comma separated, or off");
  const out: string[] = [];
  for (const item of items) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(item) || !isAddress(item, { strict: false })) throw new UsageError(`--providers: "${item}" is not an address (0x…)`);
    const a = getAddress(item);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

export async function limits(args: readonly string[], deps: ProfileDeps): Promise<number> {
  if (args[0] !== "set") {
    const { values } = parseFlags(args, { profile: { type: "string" } }, 0);
    const profile = checkProfileName(values.profile as string | undefined);
    deps.print(`Local caps  ${limitsLine(readLimits(profileRef(deps, profile)))}\n`);
    return EXIT_OK;
  }
  // Terminal only: checked before anything else is read or written.
  requireTty("limits set", deps.isTTY);
  const { values } = parseFlags(
    args.slice(1),
    {
      "per-call": { type: "string" },
      "per-day": { type: "string" },
      "confirm-above": { type: "string" },
      providers: { type: "string" },
      profile: { type: "string" },
    },
    0,
  );
  const profile = checkProfileName(values.profile as string | undefined);
  if (values["per-call"] === undefined || values["per-day"] === undefined) throw new UsageError("limits set needs --per-call and --per-day");
  const perCall = dollars("per-call", values["per-call"] as string);
  const perDay = dollars("per-day", values["per-day"] as string);
  if (usdToUnits(perCall, 6) > usdToUnits(perDay, 6)) throw new UsageError("--per-call cannot be more than --per-day");
  const confirmRaw = values["confirm-above"] as string | undefined;
  const providersRaw = values.providers as string | undefined;
  const confirmAbove = confirmRaw === undefined ? undefined : confirmRaw.trim() === "off" ? null : dollars("confirm-above", confirmRaw);
  const providers = providersRaw === undefined ? undefined : providerList(providersRaw);

  const ref = profileRef(deps, profile);
  const next = await withLock(
    ref,
    (lock) => {
      const current = readLimits(ref);
      return writeLimits(ref, lock, {
        perCall,
        perDay,
        confirmAbove: confirmAbove === undefined ? current.confirmAbove : confirmAbove,
        providers: providers === undefined ? current.providers : providers,
      });
    },
    deps.lockOptions,
  );
  deps.print(`Local caps for profile "${profile}" are now: ${limitsLine(next)}\n`);
  return EXIT_OK;
}

export async function runLimits(args: readonly string[], deps: ProfileDeps): Promise<number> {
  try {
    return await limits(args, deps);
  } catch (err) {
    return reportFailure(args[0] === "set" ? "limits set" : "limits", err, deps);
  }
}

/** `assay-mcp limits`. */
export function run(args: readonly string[]): Promise<number> {
  return runLimits(args, defaultProfileDeps());
}
