import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, normalize, posix, sep, win32 } from "node:path";

/**
 * The profile directory `{dir}` (spec §7.4) and safe file access inside it.
 *
 * - `{dir}` is derived from the OS account's home directory (`os.userInfo().homedir`:
 *   `getpwuid` on POSIX, the profile directory on Windows), never from `$HOME`,
 *   `XDG_CONFIG_HOME` or `%APPDATA%`. A project `.mcp.json` can set any env var for the
 *   server it starts; if env could move `{dir}`, a repository could supply its own
 *   `dev-origins.json`, limits and paid-URL list.
 *   macOS `~/Library/Application Support/assay-mcp/`, Linux `~/.config/assay-mcp/`,
 *   Windows `<home>\AppData\Roaming\assay-mcp\`.
 * - On POSIX the directory and its subdirectories are 0700 and files 0600. A file is read
 *   only when it is a regular file, 0600 and owned by this user, and every directory from
 *   `{dir}` down to it is 0700 and owned by this user (a git checkout yields 0644/0755, so
 *   committed copies are refused). Reads never tighten modes.
 * - Nothing inside `{dir}` is followed through a symbolic link: `{dir}`, each directory below
 *   it and each file are checked with `lstat`, and opened with `O_NOFOLLOW`.
 * - Windows: there are no POSIX modes or owners to check, so only the symlink and
 *   regular-file checks apply (plus an ino/dev re-check after open, since `O_NOFOLLOW` does
 *   not exist there). The per-user ACL on the profile directory is the remaining protection.
 */

export const APP_DIR_NAME = "assay-mcp";
const IS_POSIX = process.platform !== "win32";
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

export class ProfilePathError extends Error {
  override readonly name = "ProfilePathError";
}

export interface DirInputs {
  platform: NodeJS.Platform;
  /** The OS account's home directory (not `$HOME`). */
  home: string;
}

/** `{dir}` for the given platform. Pure; {@link configDir} fills in the running process. No env var is read. */
export function configDirFor({ platform, home }: DirInputs): string {
  if (platform === "win32") return win32.join(home, "AppData", "Roaming", APP_DIR_NAME);
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", APP_DIR_NAME);
  return posix.join(home, ".config", APP_DIR_NAME);
}

/** `{dir}` for this process, from the OS account's home directory only. */
export function configDir(): string {
  return configDirFor({ platform: process.platform, home: userInfo().homedir });
}

function currentUid(): number | null {
  return IS_POSIX && typeof process.getuid === "function" ? process.getuid() : null;
}

/** Profile names: lowercase letters, digits and `-`, up to 32 characters. They become file names. */
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME.test(name);
}

export type ProfileFileKind = "profile" | "limits" | "paid-urls" | "state" | "settings" | "signin" | "lock";

const SUFFIX: Record<ProfileFileKind, string> = {
  profile: ".json",
  limits: ".limits.json",
  "paid-urls": ".paid-urls.json",
  state: ".state.json",
  settings: ".settings.json",
  signin: ".signin.json",
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
  const uid = currentUid();
  if (uid !== null && st.uid !== uid) throw new ProfilePathError(`${path} belongs to another user`);
}

/**
 * Creates `dir` (0700) if needed, or checks it: a real directory owned by this user. On POSIX
 * it is opened with `O_NOFOLLOW|O_DIRECTORY` and tightened to 0700 through the descriptor, so
 * a symlink swapped in after the check is never followed. Used on the write path only.
 */
export function ensurePrivateDir(dir: string): void {
  const st = lstatOrNull(dir);
  if (st === null) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else checkOwnDir(dir, st);
  if (!IS_POSIX) {
    checkOwnDir(dir, lstatSync(dir));
    return;
  }
  let fd: number;
  try {
    fd = openSync(dir, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") throw new ProfilePathError(`${dir} is a symbolic link or not a directory`);
    throw err;
  }
  try {
    const fst = fstatSync(fd);
    checkOwnDir(dir, fst);
    if ((fst.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

/** Checks, without changing anything, that `path` is a 0700 directory owned by this user (POSIX). */
function checkPrivateDirForRead(path: string): void {
  const st = lstatSync(path);
  checkOwnDir(path, st);
  if (IS_POSIX && (st.mode & 0o777) !== 0o700) throw new ProfilePathError(`${path} is not private (expected mode 0700)`);
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

/**
 * Reads a file inside `{dir}`; `null` when it (or a directory on the way) does not exist.
 * Refuses symlinks and non-files and, on POSIX, a file that is not 0600 and owned by this
 * user or a directory from `{dir}` down that is not 0700 and owned by this user.
 */
export function readPrivateFile(dir: string, rel: string): string | null {
  const path = safeJoin(dir, rel);
  const dirs = [dir];
  for (let d = dirname(path); d.length > dir.length; d = dirname(d)) dirs.splice(1, 0, d);
  for (const d of dirs) {
    if (lstatOrNull(d) === null) return null;
    checkPrivateDirForRead(d);
  }
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
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ProfilePathError(`${path} is not a regular file`);
    const uid = currentUid();
    if (uid !== null && st.uid !== uid) throw new ProfilePathError(`${path} belongs to another user`);
    if (IS_POSIX && (st.mode & 0o777) !== 0o600) throw new ProfilePathError(`${path} is not private (expected mode 0600)`);
    if (!IS_POSIX) {
      // No O_NOFOLLOW on Windows: the path must still name the file that was opened.
      const again = lstatSync(path);
      if (again.isSymbolicLink() || again.ino !== st.ino || again.dev !== st.dev) {
        throw new ProfilePathError(`${path} changed while it was being read`);
      }
    }
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
  // Make the rename itself durable (a lost directory entry would drop e.g. a spend record).
  if (IS_POSIX) {
    const dfd = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  }
}

/**
 * Deletes a regular file inside `{dir}`; a symlink on the way or at the path is refused
 * ({@link safeJoin}). Returns false when there was nothing to delete.
 */
export function deletePrivateFile(dir: string, rel: string): boolean {
  const path = safeJoin(dir, rel);
  const st = lstatOrNull(path);
  if (st === null) return false;
  if (!st.isFile()) throw new ProfilePathError(`${path} is not a regular file`);
  unlinkSync(path);
  return true;
}
