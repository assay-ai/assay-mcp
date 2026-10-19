import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensurePrivateSubdir, profileFile, safeJoin } from "./paths.js";

/**
 * The profile lock (spec §8.4, `vectors/lock-protocol.json`). One protocol for every
 * implementation and every process that shares a profile:
 *
 * - Acquire: `mkdir {dir}/profiles/{profile}.lock.d`. Only one `mkdir` can succeed.
 * - The holder writes `owner.json {pid, startedAt, token}` inside and touches it every 5 s.
 * - A lock whose `owner.json` mtime (or, before `owner.json` exists, the directory's mtime)
 *   is older than 30 s is stale.
 * - Reclaiming a stale lock is serialised by a second directory, `{profile}.lock.d.reclaim`
 *   (`mkdir` again; stale after 30 s, then removed with a plain `rmdir`). Under it the
 *   reclaimer observes the lock again, renames it to a unique sibling, checks that the moved
 *   directory is the one it observed (same directory, same owner, still stale) and deletes
 *   it. If the rename caught another lock, it is put back when the path is free, and left in
 *   place (never deleted) otherwise. Moved siblings older than 30 s are swept.
 * - Waiters retry every 100 ms; after `timeoutMs` (30 s) they give up with `LOCK_TIMEOUT`
 *   and never run `fn`.
 * - Release removes the lock only while `owner.json` still names this holder.
 *
 * Self-fencing. A holder can stall (laptop sleep, a debugger, a blocked event loop) and
 * not know that its lock went stale and was taken. So a holder counts its lock as held only
 * while its last successful touch (wall clock) is less than half the stale threshold old
 * (15 s) *and* `owner.json` still holds its token. `assertHeld()` checks both and throws
 * `LOCK_LOST`; the heartbeat aborts `signal` on the same conditions.
 *
 * Rules for every operation under the lock (refresh, login, key generation, binding, the
 * G7 record):
 * - Re-read the keychain and the profile files after taking the lock.
 * - Call `assertHeld()` (and check `signal`) immediately before each commit point: every
 *   keychain or file write, and every network request that rotates state on the server (an
 *   OAuth refresh).
 * - When a refresh answer arrives after the lock was lost, drop it: do not store the rotated
 *   tokens and do not use them. The next run reads the keychain fresh. This keeps a stall of
 *   30 s or more from producing two stored token generations (the server's 30 s grace and
 *   stale-reuse rules, spec §6.3.11, are the backstop).
 * - Store a new token pair before using the new access token.
 * - On `invalid_grant`, delete the tokens only if the keychain still holds the refresh token
 *   that was sent (`Keychain.deleteTokensIfRefreshIs`).
 *
 * `token` identifies one acquisition; `pid` and `startedAt` (the acquisition time) tell a
 * person which process holds it. The lock holds no secrets.
 */

export const LOCK_DIR_SUFFIX = ".lock.d";
export const RECLAIM_SUFFIX = ".reclaim";
export const OWNER_FILE = "owner.json";
export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 30_000;
/** A holder whose last touch is older than this no longer counts its lock as held. */
export const FRESH_MS = STALE_MS / 2;
export const RETRY_MS = 100;
export const DEFAULT_TIMEOUT_MS = 30_000;

export type LockErrorCode = "LOCK_TIMEOUT" | "LOCK_LOST" | "LOCK_INVALID";

export class LockError extends Error {
  override readonly name = "LockError";
  constructor(
    readonly code: LockErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const LOST_MESSAGE = "The profile lock was lost (another process took it, or this one stalled); nothing was stored.";

/** A machine profile: `{dir}` and the profile name. */
export interface ProfileRef {
  readonly dir: string;
  readonly name: string;
}

export interface LockOwner {
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

export interface LockOptions {
  /** How long to wait for the lock. Default 30 s. */
  timeoutMs?: number;
  /** Wall clock in ms, for staleness, touches and freshness. Tests pass a fake clock. */
  now?: () => number;
  /** Heartbeat interval; default 5 s. */
  heartbeatMs?: number;
}

/** What `fn` receives while it holds the lock. */
export interface LockHandle {
  readonly profile: ProfileRef;
  readonly owner: LockOwner;
  /** Aborted when the heartbeat finds that the lock is no longer this holder's, or no longer fresh. */
  readonly signal: AbortSignal;
  /**
   * Throws `LOCK_LOST` unless the lock is still this holder's and fresh (last touch < 15 s
   * ago). Call immediately before every commit point.
   */
  assertHeld(): void;
}

function lockPath(profile: ProfileRef): string {
  return safeJoin(profile.dir, profileFile(profile.name, "lock"));
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Reads `owner.json`; `null` when it is missing or not a valid owner record. */
export function readOwner(lockDir: string): LockOwner | null {
  let text: string;
  try {
    const fd = openSync(join(lockDir, OWNER_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (typeof v.pid === "number" && typeof v.startedAt === "string" && typeof v.token === "string") {
      return { pid: v.pid, startedAt: v.startedAt, token: v.token };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Whether a lock is stale (pure; shared with the vectors). `ownerMtimeMs` is the mtime of
 * `owner.json`, or `null` when it is missing, in which case the directory's mtime counts.
 */
export function isStale(input: { nowMs: number; ownerMtimeMs: number | null; dirMtimeMs: number }): boolean {
  const reference = input.ownerMtimeMs ?? input.dirMtimeMs;
  return input.nowMs - reference > STALE_MS;
}

/** Whether a holder still counts its lock as held, from its last successful touch (pure). */
export function isFresh(input: { nowMs: number; lastTouchMs: number }): boolean {
  return input.nowMs - input.lastTouchMs < FRESH_MS;
}

interface Observation {
  owner: LockOwner | null;
  ownerMtimeMs: number | null;
  stale: boolean;
  dev: number;
  ino: number;
}

function ownDir(path: string, st: Stats): void {
  if (!st.isDirectory()) throw new LockError("LOCK_INVALID", `${path} is not a directory; refusing to use it as a lock`);
  if (process.platform !== "win32" && typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new LockError("LOCK_INVALID", `${path} belongs to another user; refusing to use it as a lock`);
  }
}

function observe(dir: string, now: number): Observation | null {
  const dirStat = lstatOrNull(dir);
  if (dirStat === null) return null;
  ownDir(dir, dirStat);
  const ownerStat = lstatOrNull(join(dir, OWNER_FILE));
  const ownerMtimeMs = ownerStat && ownerStat.isFile() ? ownerStat.mtimeMs : null;
  return {
    owner: readOwner(dir),
    ownerMtimeMs,
    stale: isStale({ nowMs: now, ownerMtimeMs, dirMtimeMs: dirStat.mtimeMs }),
    dev: dirStat.dev,
    ino: dirStat.ino,
  };
}

function sameOwner(a: LockOwner | null, b: LockOwner | null): boolean {
  return a !== null && b !== null && a.token === b.token && a.pid === b.pid && a.startedAt === b.startedAt;
}

const MOVED_TAGS = ["stale", "released", "failed"] as const;
type MovedTag = (typeof MOVED_TAGS)[number];

function uniqueSibling(dir: string, tag: MovedTag): string {
  return `${dir}.${tag}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/**
 * Moves the lock directory away and deletes it, but only if it still is the lock that was
 * meant (`expected`). If the rename caught a different lock, it is put back when the lock
 * path is still free; otherwise it is left where it is (never deleted) for the sweep.
 */
function removeIfStill(dir: string, expected: (moved: string) => boolean, tag: MovedTag): boolean {
  const moved = uniqueSibling(dir, tag);
  try {
    renameSync(dir, moved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; // already gone
    throw err;
  }
  if (expected(moved)) {
    rmSync(moved, { recursive: true, force: true });
    return true;
  }
  if (lstatOrNull(dir) === null) {
    try {
      renameSync(moved, dir);
    } catch {
      // Left in place: its holder sees LOCK_LOST on its next check; the sweep removes it later.
    }
  }
  return false;
}

/** Deletes moved-away lock directories of this profile that are older than 30 s. */
function sweepMoved(dir: string, nowMs: number): void {
  const parent = dirname(dir);
  const prefix = `${basename(dir)}.`;
  const re = new RegExp(`^(${MOVED_TAGS.join("|")})-\\d+-[0-9a-f]{12}$`);
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !re.test(name.slice(prefix.length))) continue;
    const path = join(parent, name);
    const st = lstatOrNull(path);
    if (st && st.isDirectory() && nowMs - st.mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
  }
}

function writeOwner(dir: string, owner: LockOwner, nowMs: number): void {
  const target = join(dir, OWNER_FILE);
  const tmp = join(dir, `${OWNER_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeSync(fd, JSON.stringify(owner));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  const t = nowMs / 1000;
  utimesSync(target, t, t);
}

const held = new Set<{ dir: string; owner: LockOwner }>();
let exitHookInstalled = false;

/** On a normal exit, release what this process still holds (a kill is covered by the 30 s rule). */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const h of held) releaseLock(h.dir, h.owner);
  });
}

function releaseLock(dir: string, owner: LockOwner): void {
  try {
    if (!sameOwner(readOwner(dir), owner)) return;
    removeIfStill(dir, (moved) => sameOwner(readOwner(moved), owner), "released");
  } catch {
    // Release is best effort: a lock left behind becomes stale after 30 s.
  }
}

function tryAcquire(dir: string, now: number): LockOwner | null {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
  const owner: LockOwner = { pid: process.pid, startedAt: new Date(now).toISOString(), token: randomBytes(16).toString("hex") };
  try {
    writeOwner(dir, owner, now);
  } catch (err) {
    // ENOENT: the directory was moved away under us; wait and try again.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    removeIfStill(dir, (moved) => readOwner(moved) === null || sameOwner(readOwner(moved), owner), "failed");
    throw err;
  }
  return owner;
}

/**
 * Removes the lock at `dir` if it is (still) stale, under the reclaim mutex. Returns true
 * when it removed it, false otherwise (including when another process holds the mutex).
 */
function reclaimStale(dir: string, now: () => number): boolean {
  const mutex = `${dir}${RECLAIM_SUFFIX}`;
  try {
    mkdirSync(mutex, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const st = lstatOrNull(mutex);
    if (st === null) return false;
    ownDir(mutex, st);
    // A reclaimer that died holding the mutex: plain rmdir (it is always empty).
    if (now() - st.mtimeMs > STALE_MS) {
      try {
        rmdirSync(mutex);
      } catch {
        // someone else removed or took it
      }
    }
    return false;
  }
  let removed = false;
  try {
    const seen = observe(dir, now());
    if (seen?.stale) {
      removed = removeIfStill(
        dir,
        (moved) => {
          const again = observe(moved, now());
          if (again === null || again.dev !== seen.dev || again.ino !== seen.ino) return false;
          if (seen.owner === null) return again.owner === null && again.ownerMtimeMs === seen.ownerMtimeMs;
          return sameOwner(again.owner, seen.owner) && again.stale;
        },
        "stale",
      );
    }
    sweepMoved(dir, now());
  } finally {
    try {
      rmdirSync(mutex);
    } catch {
      // gone already; a leftover becomes stale after 30 s
    }
  }
  return removed;
}

/** File-system errors that mean "busy right now" (Windows antivirus or indexer, a racing rename). */
function isTransient(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY" || code === "EEXIST";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Takes the lock, waiting up to `timeoutMs`; throws `LOCK_TIMEOUT` (or `LOCK_INVALID`). */
async function acquire(dir: string, now: () => number, timeoutMs: number): Promise<LockOwner> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const owner = tryAcquire(dir, now());
      if (owner) return owner;
      const seen = observe(dir, now());
      if (seen === null) continue; // released between mkdir and stat
      if (seen.stale && reclaimStale(dir, now)) continue; // try to take it at once
    } catch (err) {
      if (err instanceof LockError) throw err;
      if (!isTransient(err)) throw new LockError("LOCK_INVALID", "The profile lock could not be used.");
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new LockError("LOCK_TIMEOUT", "Another assay-mcp process is holding the profile lock; try again in a moment.");
    }
    // The last attempt happens at the deadline itself.
    await sleep(Math.min(RETRY_MS, left));
  }
}

/**
 * Runs `fn` while holding the profile lock. Waits up to `timeoutMs`; on timeout throws
 * `LockError("LOCK_TIMEOUT")` without running `fn`.
 */
export async function withLock<T>(profile: ProfileRef, fn: (lock: LockHandle) => Promise<T> | T, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  ensurePrivateSubdir(profile.dir, "profiles");
  const dir = lockPath(profile);

  const acquired = await acquire(dir, now, timeoutMs);
  const controller = new AbortController();
  const entry = { dir, owner: acquired };
  held.add(entry);
  installExitHook();

  let lastTouchMs = now();
  const lost = () => new LockError("LOCK_LOST", LOST_MESSAGE);
  const stillHeld = () => isFresh({ nowMs: now(), lastTouchMs }) && sameOwner(readOwner(dir), acquired);
  const timer = setInterval(() => {
    try {
      if (!stillHeld()) {
        controller.abort(lost());
        clearInterval(timer);
        return;
      }
      const t = now();
      utimesSync(join(dir, OWNER_FILE), t / 1000, t / 1000);
      lastTouchMs = t;
    } catch {
      // A failed touch is retried on the next tick; after 15 s without one the lock counts as lost.
    }
  }, heartbeatMs);
  timer.unref();

  const handle: LockHandle = {
    profile,
    owner: acquired,
    signal: controller.signal,
    assertHeld() {
      if (controller.signal.aborted) throw lost();
      if (!stillHeld()) {
        controller.abort(lost());
        throw lost();
      }
    },
  };

  try {
    return await fn(handle);
  } finally {
    clearInterval(timer);
    held.delete(entry);
    releaseLock(dir, acquired);
  }
}
