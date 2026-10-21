import { fork } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usdToAtomic } from "../src/guards/guards.js";
import { pruneSpend, recordUnderLock, SpendLimitError, sumSpend } from "../src/guards/spend-record.js";
import { ProfilePathError } from "../src/profile/paths.js";
import { bundleFixture } from "./helpers/bundle.js";
import { withLock, type ProfileRef } from "../src/profile/lock.js";
import {
  addPaidUrl,
  canonicalPaidUrl,
  createProfile,
  DEFAULT_LIMITS,
  paidUrlKey,
  ProfileStateError,
  readLimits,
  readPaidUrls,
  readProfile,
  readProfileFor,
  readState,
  removePaidUrl,
  updateProfile,
  updateState,
  usdToUnits,
  writeLimits,
} from "../src/profile/profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const SIX = { decimals: 6 };
const record = (amount: bigint, perDay: string, now?: () => number) =>
  recordUnderLock(profile, amount, { limits: { perDay }, ...SIX, ...(now ? { now } : {}) });

let base: string;
let profile: ProfileRef;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "assay-mcp-profile-"));
  profile = { dir: join(base, "cfg"), name: "default" };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const profilesDir = () => join(profile.dir, "profiles");
const newProfile = {
  environment: "production" as const,
  credentialId: "cred_0123456789",
  agentLabel: "Claude Code on a laptop",
  createdAt: "2026-10-19T00:00:00.000Z",
};

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

describe("profile files", () => {
  it("defaults are 0.50/5/off/any", async () => {
    expect(readLimits(profile)).toEqual({ version: 1, perCall: "0.50", perDay: "5", confirmAbove: null, providers: null });
    await withLock(profile, (lock) => createProfile(profile, lock, newProfile));
    const onDisk = JSON.parse(readFileSync(join(profilesDir(), "default.limits.json"), "utf8"));
    expect(onDisk).toEqual(DEFAULT_LIMITS);
    expect(onDisk).toEqual({ version: 1, perCall: "0.50", perDay: "5", confirmAbove: null, providers: null });
    expect(readPaidUrls(profile)).toEqual(["/"]);
  });

  it("no file contains a host or secret", async () => {
    await withLock(profile, (lock) => {
      createProfile(profile, lock, { ...newProfile, delegateAddress: `0x${"1".repeat(40)}`, network: "eip155:46630" });
      updateProfile(profile, lock, (p) => ({ ...p, payer: `0x${"2".repeat(40)}` }));
      addPaidUrl(profile, lock, "/c/weather?free=1");
      addPaidUrl(profile, lock, "/my/kit");
      writeLimits(profile, lock, { perCall: "1", perDay: "10", confirmAbove: "0.25", providers: ["prov_1"] });
      updateState(profile, lock, (s) => ({ ...s, lastBrowserOpen: 1_760_000_000 }));
    });
    await record(250_000n, "5");
    const files = allFiles(profile.dir);
    expect(files.map((f) => f.slice(profilesDir().length + 1)).sort()).toEqual([
      "default.json",
      "default.limits.json",
      "default.paid-urls.json",
      "default.state.json",
    ]);
    const host = /[a-z][a-z0-9+.-]*:\/\/|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(ai|com|net|org|io|dev|app|xyz|local|localhost)\b|localhost|\b\d{1,3}(\.\d{1,3}){3}\b/i;
    const secret = /assay_(at|rt|ac|sk_live)_|0x[0-9a-fA-F]{64}|bearer\s|private|refresh|access_token|-----BEGIN/i;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(host);
      expect(text, f).not.toMatch(secret);
      if (process.platform !== "win32") expect(statSync(f).mode & 0o777, f).toBe(0o600);
    }
    if (process.platform !== "win32") {
      expect(statSync(profile.dir).mode & 0o777).toBe(0o700);
      expect(statSync(profilesDir()).mode & 0o777).toBe(0o700);
    }
  });

  it("stores paid URLs as canonical paths only and refuses hosts", async () => {
    expect(canonicalPaidUrl("/")).toBe("/");
    expect(canonicalPaidUrl("https://mcp.goassay.ai/")).toBeNull();
    expect(canonicalPaidUrl("//evil.example/")).toBeNull();
    expect(canonicalPaidUrl("/oauth/x")).toBeNull();
    await withLock(profile, (lock) => {
      createProfile(profile, lock, newProfile);
      expect(addPaidUrl(profile, lock, "/c/weather")).toEqual(["/", "/c/weather"]);
      expect(addPaidUrl(profile, lock, "/c/weather")).toEqual(["/", "/c/weather"]);
      expect(removePaidUrl(profile, lock, "/")).toEqual(["/c/weather"]);
      expect(() => addPaidUrl(profile, lock, "https://evil.example/")).toThrow(ProfileStateError);
    });
    writeFileSync(join(profilesDir(), "default.paid-urls.json"), JSON.stringify({ version: 1, urls: ["https://evil.example/"] }));
    expect(() => readPaidUrls(profile)).toThrow(ProfileStateError);
  });

  it("keeps limits and paid URLs when the profile is created again", async () => {
    await withLock(profile, (lock) => {
      createProfile(profile, lock, newProfile);
      writeLimits(profile, lock, { perCall: "2", perDay: "20", confirmAbove: null, providers: null });
      removePaidUrl(profile, lock, "/");
      createProfile(profile, lock, { ...newProfile, credentialId: "cred_new" });
    });
    expect(readLimits(profile).perCall).toBe("2");
    expect(readPaidUrls(profile)).toEqual([]);
    expect(readProfile(profile)?.credentialId).toBe("cred_new");
    expect(readProfile(profile)?.payer).toBeNull();
  });

  it("refuses files that are not private (0600)", async () => {
    if (process.platform === "win32") return;
    await withLock(profile, (lock) => createProfile(profile, lock, newProfile));
    await record(1n, "5");
    for (const f of ["default.limits.json", "default.state.json"]) {
      chmodSync(join(profilesDir(), f), 0o644);
    }
    expect(() => readLimits(profile)).toThrow(ProfilePathError);
    expect(() => readState(profile)).toThrow(ProfilePathError);
    await expect(record(1n, "5")).rejects.toThrow(ProfilePathError);
  });

  it("keeps a profile in its environment", async () => {
    await withLock(profile, (lock) => createProfile(profile, lock, newProfile));
    expect(readProfileFor(profile, "production")?.environment).toBe("production");
    expect(() => readProfileFor(profile, "e2e")).toThrow(ProfileStateError);
    await withLock(profile, (lock) => {
      expect(() => createProfile(profile, lock, { ...newProfile, environment: "e2e" })).toThrow(ProfileStateError);
    });
    expect(readProfile(profile)?.environment).toBe("production");
  });

  it("paidUrlKey keeps the query and checks the origin", () => {
    const mcp = "https://mcp.goassay.ai";
    expect(paidUrlKey({ mcp, url: "https://mcp.goassay.ai/" })).toBe("/");
    expect(paidUrlKey({ mcp, url: "https://mcp.goassay.ai/c/weather?free=1" })).toBe("/c/weather?free=1");
    expect(paidUrlKey({ mcp, url: "https://mcp.goassay.ai/c/weather" })).toBe("/c/weather");
    expect(() => paidUrlKey({ mcp, url: "https://evil.example/c/weather" })).toThrow(ProfileStateError);
    expect(() => paidUrlKey({ mcp, url: "https://mcp.goassay.ai.evil.example/" })).toThrow(ProfileStateError);
  });

  it("writes only under the lock of the same profile", async () => {
    const other: ProfileRef = { dir: profile.dir, name: "other" };
    await withLock(other, async (lock) => {
      expect(() => createProfile(profile, lock, newProfile)).toThrow(ProfileStateError);
    });
    let stale: Parameters<typeof writeLimits>[1] | undefined;
    await withLock(profile, (lock) => {
      stale = lock;
    });
    expect(() => writeLimits(profile, stale!, { perCall: "1", perDay: "1", confirmAbove: null, providers: null })).toThrowError(
      expect.objectContaining({ code: "LOCK_LOST" }),
    );
  });

  it("validates what it reads and writes", async () => {
    await withLock(profile, (lock) => {
      createProfile(profile, lock, newProfile);
      expect(() => writeLimits(profile, lock, { perCall: "-1", perDay: "5", confirmAbove: null, providers: null })).toThrow(ProfileStateError);
      expect(() => updateProfile(profile, lock, (p) => ({ ...p, payer: "0xnope" }))).toThrow(ProfileStateError);
      expect(() => updateProfile(profile, lock, (p) => ({ ...p, environment: "e2e" }))).toThrow(ProfileStateError);
    });
    writeFileSync(join(profilesDir(), "default.state.json"), "{not json", { mode: 0o600 });
    expect(() => readState(profile)).toThrow(ProfileStateError);
  });
});

describe("usdToUnits", () => {
  it.each([
    ["0.50", 6, 500_000n],
    ["5", 6, 5_000_000n],
    ["5.00", 6, 5_000_000n],
    ["0.000001", 6, 1n],
    ["999999999.999999", 6, 999_999_999_999_999n],
    ["0", 6, 0n],
    ["0.509", 2, 50n], // rounded down: a cap is never loosened
    ["1.999999", 0, 1n],
    ["0.1", 18, 100_000_000_000_000_000n],
    // Values a double cannot scale exactly (a float converter gets these wrong).
    ["0.29", 2, 29n],
    ["1.13", 2, 113n],
    ["0.000003", 6, 3n],
    ["900719925.4741", 7, 9_007_199_254_741_000n],
  ] as const)("%s at %i decimals → %s", (usd, decimals, units) => {
    expect(usdToUnits(usd, decimals)).toBe(units);
  });
  it("agrees with the guards' exact converter wherever that one is defined", () => {
    for (const usd of ["0.50", "5", "0.000001", "123.456789", "999999999.999999"]) {
      expect(usdToUnits(usd, 6)).toBe(usdToAtomic(usd, 6));
    }
  });
  it("refuses anything that is not a limits.json dollar amount", () => {
    for (const bad of ["", "-1", "1e3", "0.1234567", ".5", "01", "1,5", " 1", "NaN", "Infinity"]) {
      expect(() => usdToUnits(bad, 6), bad).toThrow(ProfileStateError);
    }
  });
});

describe("spend record (G7)", () => {
  it("appends {at, amount} under the lock and prunes entries older than 24 h", async () => {
    let now = Date.parse("2026-10-19T12:00:00.000Z");
    const nowS = now / 1000;
    await record(100n, "5", () => now);
    now += 86_400_000 - 1_000;
    expect((await record(200n, "5", () => now)).total).toBe(300n);
    now += 2_000; // the first entry is now older than 24 h
    expect((await record(50n, "5", () => now)).total).toBe(250n);
    expect(readState(profile).signed).toEqual([
      { at: nowS + 86_399, amount: "200" },
      { at: nowS + 86_401, amount: "50" },
    ]);
  });

  it("refuses over perDay without recording", async () => {
    await record(4_500_000n, "5");
    await expect(record(600_000n, "5")).rejects.toBeInstanceOf(SpendLimitError);
    expect(readState(profile).signed).toHaveLength(1);
    expect((await record(500_000n, "5")).total).toBe(5_000_000n);
  });

  it("applies a perDay lowered on disk after the caller read its limits", async () => {
    await record(100n, "5");
    await withLock(profile, (lock) => writeLimits(profile, lock, { perCall: "0.50", perDay: "0.0001", confirmAbove: null, providers: null }));
    await expect(record(1n, "5")).rejects.toBeInstanceOf(SpendLimitError); // 100 + 1 > 100 base units
    expect(readState(profile).signed).toHaveLength(1);
  });

  it("fails closed when limits.json is invalid or has loose permissions", async () => {
    await record(1n, "5");
    const file = join(profilesDir(), "default.limits.json");
    writeFileSync(file, "{", { mode: 0o600 });
    await expect(record(1n, "5")).rejects.toThrow(ProfileStateError);
    writeFileSync(file, JSON.stringify({ ...DEFAULT_LIMITS }), { mode: 0o600 });
    chmodSync(file, 0o644);
    if (process.platform !== "win32") await expect(record(1n, "5")).rejects.toThrow();
    expect(readState(profile).signed).toHaveLength(1);
  });

  it("requires the limits", async () => {
    await expect(recordUnderLock(profile, 1n, undefined as never)).rejects.toThrow(TypeError);
    await expect(recordUnderLock(profile, 1n, { decimals: 6 } as never)).rejects.toThrow(TypeError);
  });

  it("stays exact above 2^53", async () => {
    const big = 2n ** 53n + 1n; // 9007199254740993: not representable as a double
    // $900719925.4741 at 7 decimals = 9007199254741000 base units = big + 7.
    const r = (amount: bigint) => recordUnderLock(profile, amount, { limits: { perDay: "900719925.4741" }, decimals: 7 });
    expect((await r(big)).total).toBe(big);
    expect((await r(7n)).total).toBe(9_007_199_254_741_000n);
    await expect(r(1n)).rejects.toBeInstanceOf(SpendLimitError);
    expect(readState(profile).signed.map((e) => e.amount)).toEqual(["9007199254740993", "7"]);
  });

  it("refuses a non-positive amount and fails closed on a corrupt state file", async () => {
    await expect(record(0n, "5")).rejects.toThrow(RangeError);
    await record(1n, "5");
    writeFileSync(join(profilesDir(), "default.state.json"), JSON.stringify({ version: 1, signed: [{ at: "x", amount: "1" }], lastBrowserOpen: null }), {
      mode: 0o600,
    });
    await expect(record(1n, "5")).rejects.toThrow(ProfileStateError);
  });

  it("prune and sum, with future entries re-dated to now", () => {
    const now = 1_760_000_000;
    const entries = [
      { at: now - 86_400, amount: "7" }, // exactly 24 h old: pruned
      { at: now - 86_399, amount: "3" },
      { at: now + 3_600, amount: "4" }, // a clock error: counted, re-dated to now
      { at: now + 60, amount: "5" }, // within the 5 min slack: kept as is
    ];
    const kept = pruneSpend(entries, now);
    expect(kept).toEqual([
      { at: now - 86_399, amount: "3" },
      { at: now, amount: "4" },
      { at: now + 60, amount: "5" },
    ]);
    expect(sumSpend(kept)).toBe(12n);
  });

  it("concurrent records in one process sum exactly", async () => {
    await Promise.all(Array.from({ length: 10 }, () => record(10n, "5")));
    expect(sumSpend(readState(profile).signed)).toBe(100n);
  });
});

describe("spend record across processes", () => {
  let child: { dir: string; file: string };
  let limitsChild: { dir: string; file: string };
  beforeAll(async () => {
    child = await bundleFixture(join(here, "fixtures/spend-child.ts"));
    limitsChild = await bundleFixture(join(here, "fixtures/limits-child.ts"));
  });
  afterAll(() => {
    rmSync(child.dir, { recursive: true, force: true });
    rmSync(limitsChild.dir, { recursive: true, force: true });
  });

  it("a perDay lowered by another process between the guard check and the record is refused", async () => {
    await record(100n, "5"); // the guard saw perDay 5 and let the call start
    const outcome = await new Promise<string>((resolve, reject) => {
      const c = fork(limitsChild.file, [profile.dir, profile.name, "0.0001"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let result: string | null = null;
      c.on("message", (m) => (result = String(m)));
      c.on("exit", () => (result === null ? reject(new Error("no result")) : resolve(result)));
    });
    expect(outcome).toBe("lowered");
    await expect(record(1n, "5")).rejects.toBeInstanceOf(SpendLimitError);
    expect(sumSpend(readState(profile).signed)).toBe(100n);
  }, 60_000);

  it("10 processes against perDay: exactly the cap is recorded", async () => {
    // Each records 100 base units; perDay is 450 base units ($0.00045 at 6 decimals).
    const outcomes = await Promise.all(
      Array.from(
        { length: 10 },
        () =>
          new Promise<string>((resolve, reject) => {
            const c = fork(child.file, [profile.dir, profile.name, "100", "0.00045"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
            let result: string | null = null;
            c.on("message", (m) => (result = String(m)));
            c.on("exit", () => (result === null ? reject(new Error("no result")) : resolve(result)));
          }),
      ),
    );
    expect(outcomes.filter((o) => o === "recorded")).toHaveLength(4);
    expect(outcomes.filter((o) => o === "refused")).toHaveLength(6);
    expect(sumSpend(readState(profile).signed)).toBe(400n);
  }, 60_000);
});
