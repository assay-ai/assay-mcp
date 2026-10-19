import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  chmodSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, posix, sep, win32 } from "node:path";

/**
 * The profile directory `{dir}` (spec §7.4) and safe file access inside it.
 *
 * - macOS `~/Library/Application Support/assay-mcp/`, Linux `$XDG_CONFIG_HOME/assay-mcp/`
 *   (`~/.config` when unset), Windows `%APPDATA%\assay-mcp\`.
 * - On POSIX the directory and its subdirectories are 0700 and files 0600.
 * - No path inside `{dir}` is followed through a symbolic link: `{dir}` itself, each
 *   directory below it and each file are checked with `lstat`, and files are opened with
 *   `O_NOFOLLOW`.
 */

export const APP_DIR_NAME = "assay-mcp";
const IS_POSIX = process.platform !== "win32";
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class ProfilePathError extends Error {
  override readonly name = "ProfilePathError";
}

export interface DirInputs {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

/** `{dir}` for the given platform. Pure; {@link configDir} fills in the running process. */
export function configDirFor({ platform, env, home }: DirInputs): string {
  if (platform === "win32") {
    const appData = env.APPDATA && win32.isAbsolute(env.APPDATA) ? env.APPDATA : win32.join(home, "AppData", "Roaming");
    return win32.join(appData, APP_DIR_NAME);
  }
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", APP_DIR_NAME);
  // XDG: a relative value is invalid and must be ignored.
  const xdg = env.XDG_CONFIG_HOME && posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : posix.join(home, ".config");
  return posix.join(xdg, APP_DIR_NAME);
}

/** `{dir}` for this process. `ASSAY_MCP_CONFIG_DIR` is deliberately not supported. */
export function configDir(): string {
  return configDirFor({ platform: process.platform, env: process.env, home: homedir() });
}

/** Profile names: lowercase letters, digits and `-`, up to 32 characters. They become file names. */
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME.test(name);
}

export type ProfileFileKind = "profile" | "limits" | "paid-urls" | "state" | "lock";

const SUFFIX: Record<ProfileFileKind, string> = {
  profile: ".json",
  limits: ".limits.json",
  "paid-urls": ".paid-urls.json",
  state: ".state.json",
  lock: ".lock.d",
};

/** The path of one profile file, relative to `{dir}`: `profiles/{profile}{suffix}`. */
export function profileFile(profile: string, kind: ProfileFileKind): string {
  if (!isValidProfileName(profile)) throw new ProfilePathError(`invalid profile name (use a-z, 0-9 and -, up to 32 characters)`);
  return join("profiles", `${profile}${SUFFIX[kind]}`);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function checkOwnDir(path: string, st: Stats): void {
  if (st.isSymbolicLink()) throw new ProfilePathError(`${path} is a symbolic link; refusing to use it`);
  if (!st.isDirectory()) throw new ProfilePathError(`${path} is not a directory`);
  if (IS_POSIX && typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new ProfilePathError(`${path} belongs to another user`);
  }
}

/** Creates `dir` (0700) if needed, or checks it: a real directory owned by this user, tightened to 0700. */
export function ensurePrivateDir(dir: string): void {
  let st = lstatOrNull(dir);
  if (st === null) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = lstatSync(dir);
  }
  checkOwnDir(dir, st);
  if (IS_POSIX && (st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/**
 * `dir` joined with the relative path `rel`, refusing absolute paths, `..`, and any existing
 * component (from `dir` itself down) that is a symbolic link.
 */
export function safeJoin(dir: string, rel: string): string {
  if (rel === "" || isAbsolute(rel) || win32.isAbsolute(rel)) throw new ProfilePathError("expected a relative path inside the profile directory");
  const parts = normalize(rel).split(/[\\/]+/);
  if (parts.some((p) => p === ".." || p === "." || p === "")) throw new ProfilePathError("the path leaves the profile directory");
  let current = dir;
  const root = lstatOrNull(current);
  if (root?.isSymbolicLink()) throw new ProfilePathError(`${dir} is a symbolic link; refusing to use it`);
  for (const part of parts) {
    current = `${current}${sep}${part}`;
    const st = lstatOrNull(current);
    if (st === null) break;
    if (st.isSymbolicLink()) throw new ProfilePathError(`${current} is a symbolic link; refusing to follow it`);
  }
  return join(dir, ...parts);
}

/** Creates (0700) or checks a directory below `{dir}`, never through a symlink. */
export function ensurePrivateSubdir(dir: string, rel: string): string {
  ensurePrivateDir(dir);
  const parts = normalize(rel).split(/[\\/]+/);
  let built = "";
  for (const part of parts) {
    built = built ? join(built, part) : part;
    ensurePrivateDir(safeJoin(dir, built));
  }
  return safeJoin(dir, rel);
}

/** Reads a file inside `{dir}`; `null` when it does not exist. Refuses symlinks and non-files. */
export function readPrivateFile(dir: string, rel: string): string | null {
  const path = safeJoin(dir, rel);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new ProfilePathError(`${path} is a symbolic link; refusing to follow it`);
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new ProfilePathError(`${path} is not a regular file`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes a file inside `{dir}` atomically with mode 0600: a fresh temporary file (created
 * exclusively, never through a symlink) renamed over the target. A symlink at the target
 * or on the way to it is refused. Parent directories are created 0700.
 */
export function writePrivateFile(dir: string, rel: string, data: string): void {
  const parts = normalize(rel).split(/[\\/]+/);
  if (parts.length > 1) ensurePrivateSubdir(dir, parts.slice(0, -1).join(sep));
  else ensurePrivateDir(dir);
  const path = safeJoin(dir, rel);
  const existing = lstatOrNull(path);
  if (existing && !existing.isFile()) throw new ProfilePathError(`${path} is not a regular file`);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    if (IS_POSIX) fchmodSync(fd, 0o600);
    writeSync(fd, data);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
