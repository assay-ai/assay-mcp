/**
 * `assay-mcp settings [--profile <name>]` shows the profile's opt-ins;
 * `assay-mcp settings set --allow-env-proxy on|off [--profile <name>]` changes them (ruling
 * 2.4-N1, spec §11 T13).
 *
 * `allowEnvProxy` lets `serve` send Assay traffic through an HTTP proxy named in its
 * environment (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY`, ...), which it otherwise refuses because a
 * project config can set that environment. Turning it on is terminal only and asks the user
 * to type the profile name; it writes `profiles/{profile}.settings.json` as a 0600 file under the lock.
 * Turning it off needs the terminal too, but no confirmation.
 */
import { EXIT_OK } from "../exit-codes.js";
import { withLock } from "../profile/lock.js";
import { profileFile } from "../profile/paths.js";
import { readSettings, writeSettings } from "../profile/settings.js";
import { requireTty } from "../tty.js";
import { parseFlags, UsageError } from "./context.js";
import { checkProfileName, DECLINED_TEXT, defaultProfileDeps, profileRef, reportFailure, typedConfirm, type ProfileDeps } from "./profile-context.js";

export async function settings(args: readonly string[], deps: ProfileDeps): Promise<number> {
  if (args[0] !== "set") {
    const { values } = parseFlags(args, { profile: { type: "string" } }, 0);
    const profile = checkProfileName(values.profile as string | undefined);
    const s = readSettings(profileRef(deps, profile));
    deps.print(`Env proxy   ${s.allowEnvProxy ? "allowed (HTTPS_PROXY and the like are used)" : "refused (default)"}\n`);
    return EXIT_OK;
  }
  requireTty("settings set", deps.isTTY);
  const { values } = parseFlags(args.slice(1), { "allow-env-proxy": { type: "string" }, profile: { type: "string" } }, 0);
  const profile = checkProfileName(values.profile as string | undefined);
  const raw = values["allow-env-proxy"];
  if (raw !== "on" && raw !== "off") throw new UsageError("settings set needs --allow-env-proxy on|off");
  const allow = raw === "on";
  const ref = profileRef(deps, profile);
  if (allow) {
    const yes = await typedConfirm(
      deps,
      `Let assay-mcp (profile "${profile}") send Assay traffic, including your sign-in, through an HTTP proxy named in its environment? Only confirm if you set up that proxy yourself: a project config can set these variables too.`,
      profile,
    );
    if (!yes) {
      deps.print(`${DECLINED_TEXT}\n`);
      return EXIT_OK;
    }
  }
  await withLock(ref, (lock) => writeSettings(ref, lock, { allowEnvProxy: allow }), deps.lockOptions);
  deps.print(
    allow
      ? `An env proxy is now allowed for profile "${profile}" (${profileFile(profile, "settings")}). Run \`assay-mcp settings set --allow-env-proxy off\` to undo.\n`
      : `An env proxy is refused again for profile "${profile}".\n`,
  );
  return EXIT_OK;
}

export async function runSettings(args: readonly string[], deps: ProfileDeps): Promise<number> {
  try {
    return await settings(args, deps);
  } catch (err) {
    return reportFailure(args[0] === "set" ? "settings set" : "settings", err, deps);
  }
}

/** `assay-mcp settings`. */
export function run(args: readonly string[]): Promise<number> {
  return runSettings(args, defaultProfileDeps());
}
