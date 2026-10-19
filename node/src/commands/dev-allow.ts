/**
 * `assay-mcp dev allow <origin>` (spec §7.3 dev mode, T13): adds an origin to
 * `{dir}/dev-origins.json` (0600). Terminal only, never non-interactively, after a
 * confirmation. Dev mode also needs the origin in `ASSAY_MCP_DEV_ORIGINS`; neither alone is
 * enough, and only an origin of a built-in dev entry can select a deployment.
 */
import { builtInDeployments, isPlaceholder } from "../deployments.js";
import { EXIT_OK } from "../exit-codes.js";
import { withLock } from "../profile/lock.js";
import { DEV_SELECTABLE } from "../profile/deployments.js";
import { addDevOrigin, DEV_ORIGINS_ENV, normaliseOrigin, readDevOriginsForWrite } from "../profile/dev-origins.js";
import { requireTty } from "../tty.js";
import { parseFlags, UsageError } from "./context.js";
import { DECLINED_TEXT, defaultProfileDeps, reportFailure, type ProfileDeps } from "./profile-context.js";

/** `dev-origins.json` is shared by every profile, so it has its own lock name (like `installs`). */
export const DEV_ORIGINS_LOCK_NAME = "dev-origins";

/** Origins of the built-in dev entries (the only ones dev mode can select). */
export function builtInDevOrigins(): string[] {
  const table = builtInDeployments();
  const out: string[] = [];
  for (const env of DEV_SELECTABLE) {
    const mcp = table[env].mcp;
    if (isPlaceholder(mcp)) continue;
    const o = normaliseOrigin(new URL(mcp).origin);
    if (o !== null && !out.includes(o)) out.push(o);
  }
  return out;
}

export async function devAllow(args: readonly string[], deps: ProfileDeps): Promise<number> {
  requireTty("dev allow", deps.isTTY);
  const { positionals } = parseFlags(args, {}, 1);
  const origin = normaliseOrigin(positionals[0]!);
  if (origin === null) throw new UsageError("expected an http(s) origin, e.g. http://localhost:3200");
  const known = builtInDevOrigins();
  if (!known.includes(origin)) throw new UsageError(`${origin} is not the origin of a built-in dev deployment (${known.join(", ") || "none"})`);
  // A file that exists but cannot be read is refused here, never replaced.
  if (readDevOriginsForWrite(deps.dir).includes(origin)) {
    deps.print(`${origin} is already allowed for dev mode.\n`);
    return EXIT_OK;
  }
  const yes = await deps.confirm(
    `Allow dev mode for ${origin}? While ${DEV_ORIGINS_ENV} also names it, assay-mcp talks to that development deployment instead of Assay. Never use dev mode with real funds.`,
  );
  if (!yes) {
    deps.print(`${DECLINED_TEXT}\n`);
    return EXIT_OK;
  }
  await withLock({ dir: deps.dir, name: DEV_ORIGINS_LOCK_NAME }, (lock) => {
    lock.assertHeld();
    addDevOrigin(deps.dir, origin);
  }, deps.lockOptions);
  deps.print(`Dev mode allowed for ${origin}. It is on only while ${DEV_ORIGINS_ENV} also lists it.\n`);
  return EXIT_OK;
}

export async function runDevAllow(args: readonly string[], deps: ProfileDeps): Promise<number> {
  try {
    return await devAllow(args, deps);
  } catch (err) {
    return reportFailure("dev allow", err, deps);
  }
}

/** `assay-mcp dev allow <origin>`. */
export function run(args: readonly string[]): Promise<number> {
  return runDevAllow(args, defaultProfileDeps());
}
