import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { ensurePrivateSubdir, profileFile, safeJoin } from "./paths.js";

/**
 * The profile lock (spec §8.4, `vectors/lock-protocol.json`). One protocol for every
 * implementation and every process that shares a profile:
 *
 * - Acquire: `mkdir {dir}/profiles/{profile}.lock.d`. Only one `mkdir` can succeed.
 * - The holder writes `owner.json {pid, startedAt, token}` inside and touches it every 5 s.
 * - A lock whose `owner.json` mtime (or, before `owner.json` exists, the directory's mtime)
 *   is older than 30 s is stale. A waiter removes it by renaming the directory to a unique
 *   sibling name (atomic: only one waiter can move it) and deleting that.
 * - Waiters retry every 100 ms; after `timeoutMs` (30 s) they give up with `LOCK_TIMEOUT`
 *   and never run `fn`.
 * - Release removes the lock only while `owner.json` still names this holder: a lock that
 *   was reclaimed and taken by another process is never removed.
 *
 * `token` identifies one acquisition; `pid` and `startedAt` (the acquisition time) tell a
 * person which process holds it. The lock holds no secrets.
 */

export const LOCK_DIR_SUFFIX = ".lock.d";
export const OWNER_FILE = "owner.json";
export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 30_000;
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
  /** Wall clock in ms, for staleness and touches. Tests pass a fake clock. */
  now?: () => number;
  /** Heartbeat interval; default 5 s. */
  heartbeatMs?: number;
}

/** What `fn` receives while it holds the lock. */
export interface LockHandle {
  readonly profile: ProfileRef;
  readonly owner: LockOwner;
  /** Aborted when the heartbeat finds that the lock is no longer this holder's. */
  readonly signal: AbortSignal;
  /** Throws `LOCK_LOST` unless `owner.json` on disk still names this holder. Call before committing a write. */
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

interface Observation {
  owner: LockOwner | null;
  ownerMtimeMs: number | null;
  stale: boolean;
  dev: number;
  ino: number;
}

function observe(dir: string, now: number): Observation | null {
  const dirStat = lstatOrNull(dir);
  if (dirStat === null) return null;
  if (!dirStat.isDirectory()) throw new LockError("LOCK_INVALID", `${dir} is not a directory; refusing to use it as a lock`);
  if (process.platform !== "win32" && typeof process.getuid === "function" && dirStat.uid !== process.getuid()) {
    throw new LockError("LOCK_INVALID", `${dir} belongs to another user; refusing to use it as a lock`);
  }
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

function uniqueSibling(dir: string, tag: string): string {
  return `${dir}.${tag}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/**
 * Moves the lock directory away and deletes it, but only if it still is the lock that was
 * observed (`expected`). If the rename caught a different lock (one taken between the
 * observation and the rename), it is put back when the lock path is still free.
 */
function removeIfStill(dir: string, expected: (moved: string) => boolean, tag: string): boolean {
  const moved = uniqueSibling(dir, tag);
  try {
    renameSync(dir, moved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false; // someone else moved it first
    throw err;
  }
  if (expected(moved)) {
    rmSync(moved, { recursive: true, force: true });
    return true;
  }
  // Not the lock we meant to remove: put it back if nobody took the path meanwhile.
  try {
    if (lstatOrNull(dir) !== null) throw new Error("taken");
    renameSync(moved, dir);
  } catch {
    // The path was taken again; the displaced holder sees LOCK_LOST on its next check.
    rmSync(moved, { recursive: true, force: true });
  }
  return false;
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
    // ENOENT: the directory was moved away under us (it can only be judged stale if the
    // clock jumped); simply wait and try again.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    removeIfStill(dir, (moved) => readOwner(moved) === null || sameOwner(readOwner(moved), owner), "failed");
    throw err;
  }
  return owner;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  const deadline = Date.now() + timeoutMs;
  let owner: LockOwner | null;
  for (;;) {
    owner = tryAcquire(dir, now());
    if (owner) break;
    const seen = observe(dir, now());
    if (seen?.stale) {
      // Re-check after the rename: remove it only if it is still the stale lock we saw.
      removeIfStill(
        dir,
        (moved) => {
          const again = observe(moved, now());
          if (again === null || again.dev !== seen.dev || again.ino !== seen.ino) return false;
          // Same directory. With an owner, it must be the same owner and still untouched for 30 s.
          if (seen.owner === null) return again.owner === null && again.ownerMtimeMs === seen.ownerMtimeMs;
          return sameOwner(again.owner, seen.owner) && again.stale;
        },
        "stale",
      );
      continue;
    }
    if (seen === null) continue; // released between mkdir and stat
    if (Date.now() + RETRY_MS > deadline) {
      throw new LockError("LOCK_TIMEOUT", "Another assay-mcp process is holding the profile lock; try again in a moment.");
    }
    await sleep(RETRY_MS);
  }

  const acquired = owner;
  const controller = new AbortController();
  const entry = { dir, owner: acquired };
  held.add(entry);
  installExitHook();

  const isHeld = () => sameOwner(readOwner(dir), acquired);
  const timer = setInterval(() => {
    try {
      if (!isHeld()) {
        controller.abort(new LockError("LOCK_LOST", "The profile lock was taken over by another process."));
        clearInterval(timer);
        return;
      }
      const t = now() / 1000;
      utimesSync(join(dir, OWNER_FILE), t, t);
    } catch {
      // A failed touch is retried on the next tick; staleness needs 30 s of failures.
    }
  }, heartbeatMs);
  timer.unref();

  const handle: LockHandle = {
    profile,
    owner: acquired,
    signal: controller.signal,
    assertHeld() {
      if (controller.signal.aborted || !isHeld()) {
        throw new LockError("LOCK_LOST", "The profile lock was taken over by another process.");
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
