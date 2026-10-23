import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accountFor,
  classifyKeyringError,
  ENTRY_OPTIONS,
  Keychain,
  KEYCHAIN_SERVICE,
  KeychainError,
  keyringBackendFrom,
  realKeychainSmokeTest,
  LOCKED_KEYCHAIN_MESSAGE,
  NO_KEYCHAIN_MESSAGE,
  probeKeychain,
  keychainProbeTimedOut,
  PROBE_TIMEOUT_MS,
  reportKeychainError,
  SECRET_KINDS,
  type NapiAsyncEntryCtor,
} from "../src/profile/keychain.js";
import { withLock, type LockHandle, type ProfileRef } from "../src/profile/lock.js";
import { bundleFixture } from "./helpers/bundle.js";
import { MemoryKeyring } from "./helpers/memory-keyring.js";

const here = dirname(fileURLToPath(import.meta.url));
const scope = { profile: "default", environment: "production" as const };
// Secret-shaped test values (not real secrets).
const values = {
  access_token: `assay_at_${"a".repeat(32)}`,
  refresh_token: `assay_rt_${"b".repeat(32)}`,
  delegate_key: `0x${"c".repeat(64)}`,
};

let base: string;
let profile: ProfileRef;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "assay-mcp-keychain-"));
  profile = { dir: join(base, "cfg"), name: "default" };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const locked = <T>(fn: (lock: LockHandle) => Promise<T>) => withLock(profile, fn);

describe("keychain", () => {
  it("round-trip", async () => {
    const backend = new MemoryKeyring();
    const kc = new Keychain(backend, scope);
    for (const kind of SECRET_KINDS) expect(await kc.get(kind)).toBeNull();
    await locked(async (lock) => {
      for (const kind of SECRET_KINDS) await kc.set(lock, kind, values[kind]);
    });
    for (const kind of SECRET_KINDS) expect(await kc.get(kind)).toBe(values[kind]);
    expect([...backend.entries.keys()].sort()).toEqual(
      ["default@production/access_token", "default@production/delegate_key", "default@production/refresh_token"].map(
        (a) => `${KEYCHAIN_SERVICE}\u0000${a}`,
      ),
    );
    // Another process (a new Keychain on the same store) sees the same secrets: nothing is cached.
    const other = new Keychain(backend, scope);
    await locked((lock) => other.set(lock, "access_token", `assay_at_${"d".repeat(32)}`));
    expect(await kc.get("access_token")).toBe(`assay_at_${"d".repeat(32)}`);
    await locked((lock) => kc.clear(lock));
    for (const kind of SECRET_KINDS) expect(await kc.get(kind)).toBeNull();
  });

  it("uses service ai.assay.mcp and accounts {profile}@{environment}/{kind}", () => {
    expect(KEYCHAIN_SERVICE).toBe("ai.assay.mcp");
    expect(accountFor({ profile: "work", environment: "e2e" }, "refresh_token")).toBe("work@e2e/refresh_token");
    expect(() => accountFor({ profile: "../x", environment: "e2e" }, "refresh_token")).toThrow();
    expect(() => accountFor({ profile: "a", environment: "evil" as never }, "refresh_token")).toThrow();
    expect(() => accountFor(scope, "password" as never)).toThrow();
  });

  it("keeps profiles and environments apart", async () => {
    const backend = new MemoryKeyring();
    await locked((lock) => new Keychain(backend, scope).set(lock, "refresh_token", values.refresh_token));
    expect(await new Keychain(backend, { profile: "default", environment: "e2e" }).get("refresh_token")).toBeNull();
    expect(await new Keychain(backend, { profile: "other", environment: "production" }).get("refresh_token")).toBeNull();
  });

  it("refuses to store an empty secret", async () => {
    await locked(async (lock) => {
      await expect(new Keychain(new MemoryKeyring(), scope).set(lock, "access_token", "")).rejects.toThrow(TypeError);
    });
  });

  it("writes only under a held, fresh lock of the same profile", async () => {
    const backend = new MemoryKeyring();
    const kc = new Keychain(backend, scope);
    let stale: LockHandle | undefined;
    await locked(async (lock) => {
      stale = lock;
    });
    await expect(kc.set(stale!, "refresh_token", values.refresh_token)).rejects.toMatchObject({ code: "LOCK_LOST" });
    await expect(kc.delete(stale!, "refresh_token")).rejects.toMatchObject({ code: "LOCK_LOST" });
    await withLock({ dir: profile.dir, name: "other" }, async (lock) => {
      await expect(kc.set(lock, "refresh_token", values.refresh_token)).rejects.toThrow(TypeError);
    });
    // A holder that stalled for 15 s or more (no heartbeat ran) may not store.
    let t = Date.now();
    await withLock(
      profile,
      async (lock) => {
        t += 15_000;
        await expect(kc.set(lock, "refresh_token", values.refresh_token)).rejects.toMatchObject({ code: "LOCK_LOST" });
      },
      { now: () => t },
    );
    expect(backend.entries.size).toBe(0);
  });

  it("drops a refresh answer that arrives after the lock was lost", async () => {
    const backend = new MemoryKeyring();
    const kc = new Keychain(backend, scope);
    await locked((lock) =>
      kc.storeTokens(lock, { refreshToken: values.refresh_token, accessToken: { token: values.access_token, expiresAt: 100 } }),
    );
    let t = Date.now();
    await withLock(
      profile,
      async (lock) => {
        lock.assertHeld(); // just before the (simulated) network refresh
        t += 31_000; // the request stalled (laptop sleep)
        const rotated = { refreshToken: `assay_rt_${"e".repeat(32)}`, accessToken: { token: `assay_at_${"e".repeat(32)}`, expiresAt: 200 } };
        await expect(kc.storeTokens(lock, rotated)).rejects.toMatchObject({ code: "LOCK_LOST" });
      },
      { now: () => t },
    );
    expect(await kc.get("refresh_token")).toBe(values.refresh_token);
    expect(await kc.getAccessToken()).toEqual({ token: values.access_token, expiresAt: 100 });
  });

  it("deletes tokens on invalid_grant only if the sent refresh token is still stored", async () => {
    const kc = new Keychain(new MemoryKeyring(), scope);
    await locked(async (lock) => {
      await kc.storeTokens(lock, { refreshToken: values.refresh_token, accessToken: { token: values.access_token, expiresAt: 1 } });
      expect(await kc.deleteTokensIfRefreshIs(lock, `assay_rt_${"0".repeat(32)}`)).toBe(false);
      expect(await kc.get("refresh_token")).toBe(values.refresh_token);
      expect(await kc.deleteTokensIfRefreshIs(lock, values.refresh_token)).toBe(true);
    });
    expect(await kc.get("refresh_token")).toBeNull();
    expect(await kc.getAccessToken()).toBeNull();
  });

  it("passes the Secret-Service-only option on every operation (no kernel keyring fallback)", async () => {
    const seen: unknown[] = [];
    class FakeEntry {
      constructor(_s: string, _a: string, options?: unknown) {
        seen.push(options);
      }
      async getPassword() {
        return null;
      }
      async setPassword() {}
      async deletePassword() {
        return false;
      }
    }
    const backend = keyringBackendFrom(FakeEntry as unknown as NapiAsyncEntryCtor);
    await probeKeychain(backend);
    await backend.set("s", "a", "v");
    await backend.get("s", "a");
    await backend.delete("s", "a");
    expect(seen).toHaveLength(4);
    for (const o of seen) expect(o).toEqual({ linux: { store: "secret-service" } });
    expect(ENTRY_OPTIONS).toEqual({ linux: { store: "secret-service" } });
  });

  it("no keychain → exit 1 with the exact text", async () => {
    const backend = new MemoryKeyring();
    backend.failWith = new Error("Couldn't access platform secure storage: no Secret Service");
    const err = await probeKeychain(backend).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeychainError);
    const lines: string[] = [];
    expect(reportKeychainError(err as KeychainError, (l) => lines.push(l))).toBe(1);
    expect(lines).toEqual(["No OS keychain is available. Use the Assay SDK with an API key and a KMS key instead.\n"]);
    expect(NO_KEYCHAIN_MESSAGE).toBe("No OS keychain is available. Use the Assay SDK with an API key and a KMS key instead.");
  });

  it("a locked store → exit 1 with the unlock text", async () => {
    const backend = new MemoryKeyring();
    backend.failWith = new Error("Platform secure storage failure: User interaction is not allowed.");
    const err = await probeKeychain(backend).catch((e: unknown) => e);
    expect((err as KeychainError).message).toBe(LOCKED_KEYCHAIN_MESSAGE);
    expect((err as KeychainError).exitCode).toBe(1);
    expect(LOCKED_KEYCHAIN_MESSAGE).toBe("Unlock your keychain, then try again.");
    expect(classifyKeyringError(new Error("SS Error: object locked"))).toBe("locked");
    expect(classifyKeyringError(new Error("errSecInteractionNotAllowed -25308"))).toBe("locked");
    expect(classifyKeyringError(new Error("No such interface"))).toBe("unavailable");
  });

  it("a keychain that never answers (an unlock prompt nobody sees) → the unlock text", async () => {
    const backend = new MemoryKeyring();
    backend.get = () => new Promise<string | null>(() => {});
    const err = await probeKeychain(backend, 20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeychainError);
    expect((err as KeychainError).message).toBe(LOCKED_KEYCHAIN_MESSAGE);
    expect(keychainProbeTimedOut()).toBe(true);
  });

  it("never puts a secret or the platform error into its errors", async () => {
    const backend = new MemoryKeyring();
    const kc = new Keychain(backend, scope);
    backend.failWith = new Error(`platform failure ${values.refresh_token}`);
    await locked(async (lock) => {
      for (const op of [() => kc.set(lock, "refresh_token", values.refresh_token), () => kc.get("refresh_token"), () => kc.delete(lock, "refresh_token")]) {
        const e = await op().then(
          () => expect.unreachable(),
          (x: unknown) => x,
        );
        expect(e).toBeInstanceOf(KeychainError);
        expect(String((e as Error).message)).not.toContain("assay_rt_");
        expect((e as Error).cause).toBeUndefined();
        expect(JSON.stringify(e)).not.toContain("assay_rt_");
      }
    });
  });
});

/*
 * Real OS keychain, gated so the default run never touches it. CI runs these on macOS,
 * Windows and Linux (Secret Service under dbus + gnome-keyring), and on a Linux runner with
 * no Secret Service. Locally: ASSAY_MCP_REAL_KEYCHAIN=1 npm test -w node -- keychain
 *
 * - ASSAY_MCP_REAL_KEYCHAIN=1: round-trip through @napi-rs/keyring, and the startup probe passes.
 * - ASSAY_MCP_EXPECT_KEYCHAIN=unavailable|locked: the startup probe exits 1 with the exact text.
 */
const realKeychain = process.env.ASSAY_MCP_REAL_KEYCHAIN === "1";
const expectFailure = process.env.ASSAY_MCP_EXPECT_KEYCHAIN;

describe.runIf(realKeychain || expectFailure !== undefined)("real OS keychain (gated)", () => {
  let probe: { dir: string; file: string };
  beforeAll(async () => {
    probe = await bundleFixture(join(here, "fixtures/keychain-probe.ts"));
  });
  afterAll(() => rmSync(probe.dir, { recursive: true, force: true }));

  function runProbe(): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const child = fork(probe.file, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let stderr = "";
      child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("exit", (code) => resolve({ code, stderr }));
    });
  }

  it.runIf(realKeychain)("round-trips through @napi-rs/keyring", async () => {
    const account = `smoke-${randomBytes(4).toString("hex")}@e2e/access_token`;
    expect(await realKeychainSmokeTest(account, randomBytes(16).toString("hex"))).toBe(true);
    expect(await runProbe()).toEqual({ code: 0, stderr: "" });
  });

  // Task 2.17: each secret the proxy keeps, at its real shape and length (an access and a
  // refresh token, a delegate private key), round-trips on every OS store, under the smoke-test
  // service only. A store that truncated or re-encoded a value would fail here.
  it.runIf(realKeychain)("every secret kind round-trips at its real shape (smoke-test service)", async () => {
    const shaped: Record<(typeof SECRET_KINDS)[number], string> = {
      access_token: `assay_at_${randomBytes(32).toString("base64url")}`,
      refresh_token: `assay_rt_${randomBytes(32).toString("base64url")}`,
      delegate_key: `0x${randomBytes(32).toString("hex")}`,
    };
    const run = randomBytes(4).toString("hex");
    for (const kind of SECRET_KINDS) {
      expect(await realKeychainSmokeTest(`smoke-${run}@e2e/${kind}`, shaped[kind]), kind).toBe(true);
    }
  });

  it.runIf(expectFailure === "unavailable")("no keychain → exit 1 with the exact text (real probe)", async () => {
    expect(await runProbe()).toEqual({ code: 1, stderr: `${NO_KEYCHAIN_MESSAGE}\n` });
  });

  // macOS asks to unlock the keychain; on a runner nobody answers, so the probe's timeout ends it.
  it.runIf(expectFailure === "locked")(
    "locked keychain → exit 1 with the unlock text (real probe)",
    async () => {
      expect(await runProbe()).toEqual({ code: 1, stderr: `${LOCKED_KEYCHAIN_MESSAGE}\n` });
    },
    PROBE_TIMEOUT_MS + 15_000,
  );
});
