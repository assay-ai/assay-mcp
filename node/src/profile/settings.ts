/**
 * `profiles/{profile}.settings.json`: per-profile opt-ins that loosen a startup check
 * (ruling 2.4-N1, spec §11 T13). Today one: `allowEnvProxy`, which lets `serve` send Assay
 * traffic through an HTTP proxy named in its environment.
 *
 * The file is written only by `assay-mcp settings set` on a TTY, after a confirmation, as a
 * 0600 file in the 0700 profile directory, under the profile lock. Never through env, a flag
 * of `serve`, or a project config. `serve` reads it through `readSettings` below (one parser,
 * review R1-N2) and treats any refusal, including a loose, foreign or symlinked file, as
 * "nothing allowed".
 */
import type { LockHandle, ProfileRef } from "./lock.js";
import { profileFile, readPrivateFile, writePrivateFile } from "./paths.js";

export const SETTINGS_VERSION = 1;

export interface ProfileSettingsFile {
  version: number;
  allowEnvProxy: boolean;
}

export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

/**
 * The settings on disk. Missing reads as the defaults (nothing allowed); an unreadable or
 * malformed file throws, so `settings` shows the problem instead of hiding it.
 */
export function readSettings(profile: ProfileRef): ProfileSettingsFile {
  const text = readPrivateFile(profile.dir, profileFile(profile.name, "settings"));
  if (text === null) return { version: SETTINGS_VERSION, allowEnvProxy: false };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new SettingsError("settings file: not valid JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new SettingsError("settings file: invalid record");
  const r = v as Record<string, unknown>;
  if (r.version !== SETTINGS_VERSION || typeof r.allowEnvProxy !== "boolean") throw new SettingsError("settings file: invalid record");
  return { version: SETTINGS_VERSION, allowEnvProxy: r.allowEnvProxy };
}

/** Writes the settings (0600, atomic) while `lock` holds this profile's lock. */
export function writeSettings(profile: ProfileRef, lock: LockHandle, settings: Omit<ProfileSettingsFile, "version">): ProfileSettingsFile {
  if (lock.profile.dir !== profile.dir || lock.profile.name !== profile.name) throw new SettingsError("the lock held is for another profile");
  const next: ProfileSettingsFile = { version: SETTINGS_VERSION, allowEnvProxy: settings.allowEnvProxy === true };
  lock.assertHeld();
  writePrivateFile(profile.dir, profileFile(profile.name, "settings"), `${JSON.stringify(next)}\n`);
  return next;
}
