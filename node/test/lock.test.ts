import { fork, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  HEARTBEAT_MS,
  isStale,
  LockError,
  OWNER_FILE,
  readOwner,
  RETRY_MS,
  STALE_MS,
  withLock,
  type ProfileRef,
} from "../src/profile/lock.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../../vectors/lock-protocol.json"), "utf8")) as {
  heartbeatMs: number;
  staleMs: number;
  retryMs: number;
  timeoutMs: number;
  timeoutError: string;
  staleCases: { name: string; nowMs: number; ownerMtimeMs: number | null; dirMtimeMs: number; stale: boolean }[];
};

let bundleDir: string;
let childScript: string;
beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "assay-mcp-lock-bundle-"));
  childScript = join(bundleDir, "lock-child.mjs");
  await build({
    entryPoints: [join(here, "fixtures/lock-child.ts")],
    outfile: childScript,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
  });
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

let base: string;
let profile: ProfileRef;
const children: ChildProcess[] = [];
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "assay-mcp-lock-"));
  profile = { dir: join(base, "cfg"), name: "default" };
});
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
});

const lockDir = () => join(profile.dir, "profiles", "default.lock.d");

function spawnChild(args: string[]): ChildProcess {
  const child = fork(childScript, [profile.dir, profile.name, ...args], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  return child;
}

function waitMessage(child: ChildProcess, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on("message", (m) => m === message && resolve());
    child.on("exit", (code) => reject(new Error(`child exited (${code}) before "${message}"`)));
  });
}

function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.on("exit", (code) => resolve(code));
  });
}

describe("lock protocol vectors", () => {
  it("uses the protocol constants", () => {
    expect(HEARTBEAT_MS).toBe(vectors.heartbeatMs);
    expect(STALE_MS).toBe(vectors.staleMs);
    expect(RETRY_MS).toBe(vectors.retryMs);
    expect(DEFAULT_TIMEOUT_MS).toBe(vectors.timeoutMs);
  });
  it.each(vectors.staleCases)("$name", (c) => {
    expect(isStale({ nowMs: c.nowMs, ownerMtimeMs: c.ownerMtimeMs, dirMtimeMs: c.dirMtimeMs })).toBe(c.stale);
  });
});

describe("withLock in one process", () => {
  it("writes owner.json, keeps it private, and removes the lock on release", async () => {
    await withLock(profile, (lock) => {
      const owner = readOwner(lockDir());
      expect(owner).toEqual(lock.owner);
      expect(owner?.pid).toBe(process.pid);
      expect(owner?.token).toMatch(/^[0-9a-f]{32}$/);
      if (process.platform !== "win32") {
        expect(statSync(lockDir()).mode & 0o777).toBe(0o700);
        expect(statSync(join(lockDir(), OWNER_FILE)).mode & 0o777).toBe(0o600);
      }
      lock.assertHeld();
    });
    expect(existsSync(lockDir())).toBe(false);
    expect(readdirSync(join(profile.dir, "profiles"))).toEqual([]);
  });

  it("releases on a throwing fn", async () => {
    await expect(withLock(profile, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(existsSync(lockDir())).toBe(false);
  });

  it("serialises callers in the same process", async () => {
    const order: string[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        withLock(profile, async () => {
          order.push(`in${n}`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`out${n}`);
        }),
      ),
    );
    for (let i = 0; i < order.length; i += 2) expect(order[i + 1]).toBe(order[i]!.replace("in", "out"));
  });

  it("never removes someone else's lock on release, and reports LOCK_LOST", async () => {
    await withLock(profile, (lock) => {
      writeFileSync(join(lockDir(), OWNER_FILE), JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00.000Z", token: "f".repeat(32) }));
      expect(() => lock.assertHeld()).toThrowError(expect.objectContaining({ code: "LOCK_LOST" }));
    });
    expect(readOwner(lockDir())?.token).toBe("f".repeat(32));
  });

  it("touches owner.json on every heartbeat", async () => {
    let t = Date.parse("2030-01-01T00:00:00Z");
    await withLock(
      profile,
      async () => {
        const first = lstatSync(join(lockDir(), OWNER_FILE)).mtimeMs;
        t += 60_000;
        await new Promise((r) => setTimeout(r, 120));
        expect(lstatSync(join(lockDir(), OWNER_FILE)).mtimeMs).toBeGreaterThanOrEqual(first + 59_000);
      },
      { now: () => t, heartbeatMs: 25 },
    );
  });

  it("aborts the signal when the lock is taken over", async () => {
    await withLock(
      profile,
      async (lock) => {
        writeFileSync(join(lockDir(), OWNER_FILE), JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00.000Z", token: "e".repeat(32) }));
        await new Promise((r) => setTimeout(r, 100));
        expect(lock.signal.aborted).toBe(true);
      },
      { heartbeatMs: 20 },
    );
  });

  it("refuses a lock path that is not a directory", async () => {
    mkdirSync(join(profile.dir, "profiles"), { recursive: true, mode: 0o700 });
    writeFileSync(lockDir(), "x");
    await expect(withLock(profile, () => 1, { timeoutMs: 200 })).rejects.toMatchObject({ code: "LOCK_INVALID" });
  });

  it("reclaims a lock directory left without owner.json once it is 30 s old", async () => {
    mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
    const fn = vi.fn(() => "ran");
    await expect(withLock(profile, fn, { timeoutMs: 250 })).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(fn).not.toHaveBeenCalled();
    const old = (Date.now() - STALE_MS - 1_000) / 1000;
    utimesSync(lockDir(), old, old);
    await expect(withLock(profile, fn, { timeoutMs: 1_000 })).resolves.toBe("ran");
  });
});

describe("withLock across processes", () => {
  it("two holders never overlap (100 iterations)", async () => {
    const log = join(base, "log.txt");
    writeFileSync(log, "");
    const a = spawnChild(["contend", "50", log]);
    const b = spawnChild(["contend", "50", log]);
    const codes = await Promise.all([waitExit(a), waitExit(b)]);
    expect(codes).toEqual([0, 0]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.filter((l) => l.startsWith("OVERLAP"))).toEqual([]);
    expect(lines.filter((l) => l.startsWith("enter"))).toHaveLength(100);
    // Strict alternation: every enter is followed by the exit of the same holder.
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i + 1]).toBe(lines[i]!.replace("enter", "exit"));
    }
    expect(existsSync(lockDir())).toBe(false);
  }, 60_000);

  it("several waiters racing to reclaim one stale lock never overlap", async () => {
    mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
    const ownerPath = join(lockDir(), OWNER_FILE);
    writeFileSync(ownerPath, JSON.stringify({ pid: 999999, startedAt: "2026-01-01T00:00:00.000Z", token: "a".repeat(32) }));
    const old = (Date.now() - STALE_MS - 5_000) / 1000;
    utimesSync(ownerPath, old, old);
    const log = join(base, "log.txt");
    writeFileSync(log, "");
    const racers = [1, 2, 3, 4].map(() => spawnChild(["contend", "10", log]));
    expect(await Promise.all(racers.map(waitExit))).toEqual([0, 0, 0, 0]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.filter((l) => l.startsWith("OVERLAP"))).toEqual([]);
    expect(lines.filter((l) => l.startsWith("enter"))).toHaveLength(40);
    expect(readdirSync(join(profile.dir, "profiles"))).toEqual([]);
  }, 60_000);

  it("killed holder reclaimed after 30 s (fake clock + mtime)", async () => {
    const holder = spawnChild(["hold"]);
    await waitMessage(holder, "acquired");
    const owner = readOwner(lockDir());
    expect(owner?.pid).toBe(holder.pid);
    holder.kill("SIGKILL");
    await waitExit(holder);

    const ownerPath = join(lockDir(), OWNER_FILE);
    const mtime = lstatSync(ownerPath).mtimeMs;
    const fn = vi.fn(() => "reclaimed");
    // 29.9 s after the last touch: still held.
    await expect(withLock(profile, fn, { timeoutMs: 250, now: () => mtime + STALE_MS - 100 })).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(fn).not.toHaveBeenCalled();
    expect(readOwner(lockDir())).toEqual(owner);
    // 30.001 s after the last touch: stale, reclaimed by rename-then-delete.
    await expect(withLock(profile, fn, { timeoutMs: 1_000, now: () => mtime + STALE_MS + 1 })).resolves.toBe("reclaimed");
    expect(fn).toHaveBeenCalledTimes(1);
    // Same with a real clock and an old mtime.
    mkdirSync(lockDir(), { mode: 0o700 });
    writeFileSync(ownerPath, JSON.stringify(owner));
    const old = (Date.now() - STALE_MS - 1_000) / 1000;
    utimesSync(ownerPath, old, old);
    await expect(withLock(profile, fn, { timeoutMs: 1_000 })).resolves.toBe("reclaimed");
    // Nothing left behind: no lock, no renamed stale directories.
    expect(readdirSync(join(profile.dir, "profiles"))).toEqual([]);
  }, 30_000);

  it("waiter timeout → LOCK_TIMEOUT and never runs fn", async () => {
    const holder = spawnChild(["hold"]);
    await waitMessage(holder, "acquired");
    const fn = vi.fn();
    const started = Date.now();
    const err = await withLock(profile, fn, { timeoutMs: 600 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockError);
    expect((err as LockError).code).toBe(vectors.timeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(fn).not.toHaveBeenCalled();
    // The live holder's lock is untouched; after it releases, the lock is free.
    expect(readOwner(lockDir())?.pid).toBe(holder.pid);
    holder.send("release");
    await waitMessage(holder, "released");
    await expect(withLock(profile, () => "free", { timeoutMs: 1_000 })).resolves.toBe("free");
  }, 30_000);
});
