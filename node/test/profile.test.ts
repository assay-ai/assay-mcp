import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneSpend, recordUnderLock, SpendLimitError, SPEND_WINDOW_MS, sumSpend } from "../src/guards/spend-record.js";
import { withLock, type ProfileRef } from "../src/profile/lock.js";
import {
  addPaidUrl,
  canonicalPaidUrl,
  createProfile,
  DEFAULT_LIMITS,
  ProfileStateError,
  readLimits,
  readPaidUrls,
  readProfile,
  readState,
  removePaidUrl,
  updateProfile,
  updateState,
  writeLimits,
} from "../src/profile/profile.js";

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
    expect(readLimits(profile)).toEqual({ version: 1, perCall: "0.50", perDay: "5.00", confirmAbove: null, providers: null });
    await withLock(profile, (lock) => createProfile(profile, lock, newProfile));
    const onDisk = JSON.parse(readFileSync(join(profilesDir(), "default.limits.json"), "utf8"));
    expect(onDisk).toEqual(DEFAULT_LIMITS);
    expect(onDisk).toEqual({ version: 1, perCall: "0.50", perDay: "5.00", confirmAbove: null, providers: null });
    expect(readPaidUrls(profile)).toEqual(["/"]);
  });

  it("no file contains a host or secret", async () => {
    await withLock(profile, (lock) => {
      createProfile(profile, lock, { ...newProfile, delegateAddress: `0x${"1".repeat(40)}`, network: "eip155:46630" });
      updateProfile(profile, lock, (p) => ({ ...p, payer: `0x${"2".repeat(40)}` }));
      addPaidUrl(profile, lock, "/c/weather?free=1");
      addPaidUrl(profile, lock, "/my/kit");
      writeLimits(profile, lock, { perCall: "1", perDay: "10", confirmAbove: "0.25", providers: ["prov_1"] });
      updateState(profile, lock, (s) => ({ ...s, lastBrowserOpen: "2026-10-19T00:00:00.000Z" }));
    });
    await recordUnderLock(profile, 250_000n);
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
    expect(canonicalPaidUrl("https://mcp.assay.ai/")).toBeNull();
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
    writeFileSync(join(profilesDir(), "default.state.json"), "{not json");
    expect(() => readState(profile)).toThrow(ProfileStateError);
  });
});

describe("spend record (G7)", () => {
  it("appends {at, amount} under the lock and prunes entries older than 24 h", async () => {
    let now = Date.parse("2026-10-19T12:00:00.000Z");
    await recordUnderLock(profile, 100n, { now: () => now });
    now += SPEND_WINDOW_MS - 1_000;
    expect((await recordUnderLock(profile, 200n, { now: () => now })).total).toBe(300n);
    now += 2_000; // the first entry is now older than 24 h
    expect((await recordUnderLock(profile, 50n, { now: () => now })).total).toBe(250n);
    expect(readState(profile).signed).toEqual([
      { at: "2026-10-20T11:59:59.000Z", amount: "200" },
      { at: "2026-10-20T12:00:01.000Z", amount: "50" },
    ]);
  });

  it("refuses over perDay without recording", async () => {
    await recordUnderLock(profile, 4_500_000n, { perDay: 5_000_000n });
    await expect(recordUnderLock(profile, 600_000n, { perDay: 5_000_000n })).rejects.toBeInstanceOf(SpendLimitError);
    expect(readState(profile).signed).toHaveLength(1);
    expect((await recordUnderLock(profile, 500_000n, { perDay: 5_000_000n })).total).toBe(5_000_000n);
  });

  it("refuses a non-positive amount and fails closed on a corrupt state file", async () => {
    await expect(recordUnderLock(profile, 0n)).rejects.toThrow(RangeError);
    await recordUnderLock(profile, 1n);
    writeFileSync(join(profilesDir(), "default.state.json"), JSON.stringify({ version: 1, signed: [{ at: "x", amount: "1" }], lastBrowserOpen: null }));
    await expect(recordUnderLock(profile, 1n)).rejects.toThrow(ProfileStateError);
  });

  it("prune and sum", () => {
    const now = Date.parse("2026-10-19T12:00:00.000Z");
    const entries = [
      { at: "2026-10-18T11:59:59.000Z", amount: "7" },
      { at: "2026-10-18T12:00:01.000Z", amount: "3" },
      { at: "2026-10-19T13:00:00.000Z", amount: "4" },
    ];
    expect(sumSpend(pruneSpend(entries, now))).toBe(7n);
  });

  it("concurrent records in one process sum exactly", async () => {
    await Promise.all(Array.from({ length: 10 }, () => recordUnderLock(profile, 10n)));
    expect(sumSpend(readState(profile).signed)).toBe(100n);
  });
});
