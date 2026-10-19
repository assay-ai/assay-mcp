import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accountFor,
  classifyKeyringError,
  Keychain,
  KEYCHAIN_SERVICE,
  KeychainError,
  loadOsKeyring,
  LOCKED_KEYCHAIN_MESSAGE,
  NO_KEYCHAIN_MESSAGE,
  probeKeychain,
  reportKeychainError,
  SECRET_KINDS,
} from "../src/profile/keychain.js";
import { MemoryKeyring } from "./helpers/memory-keyring.js";

const scope = { profile: "default", environment: "production" as const };
// Secret-shaped test values (not real secrets).
const values = {
  access_token: `assay_at_${"a".repeat(32)}`,
  refresh_token: `assay_rt_${"b".repeat(32)}`,
  delegate_key: `0x${"c".repeat(64)}`,
};

describe("keychain", () => {
  it("round-trip", () => {
    const backend = new MemoryKeyring();
    const kc = new Keychain(backend, scope);
    for (const kind of SECRET_KINDS) expect(kc.get(kind)).toBeNull();
    for (const kind of SECRET_KINDS) kc.set(kind, values[kind]);
    for (const kind of SECRET_KINDS) expect(kc.get(kind)).toBe(values[kind]);
    expect([...backend.entries.keys()].sort()).toEqual(
      ["default@production/access_token", "default@production/delegate_key", "default@production/refresh_token"].map(
        (a) => `${KEYCHAIN_SERVICE}\u0000${a}`,
      ),
    );
    // Another process (a new Keychain on the same store) sees the same secrets: nothing is cached.
    const other = new Keychain(backend, scope);
    other.set("access_token", `assay_at_${"d".repeat(32)}`);
    expect(kc.get("access_token")).toBe(`assay_at_${"d".repeat(32)}`);
    kc.clear();
    for (const kind of SECRET_KINDS) expect(kc.get(kind)).toBeNull();
  });

  it("uses service ai.assay.mcp and accounts {profile}@{environment}/{kind}", () => {
    expect(KEYCHAIN_SERVICE).toBe("ai.assay.mcp");
    expect(accountFor({ profile: "work", environment: "e2e" }, "refresh_token")).toBe("work@e2e/refresh_token");
    expect(() => accountFor({ profile: "../x", environment: "e2e" }, "refresh_token")).toThrow();
    expect(() => accountFor({ profile: "a", environment: "evil" as never }, "refresh_token")).toThrow();
    expect(() => accountFor(scope, "password" as never)).toThrow();
  });

  it("keeps profiles and environments apart", () => {
    const backend = new MemoryKeyring();
    new Keychain(backend, scope).set("refresh_token", values.refresh_token);
    expect(new Keychain(backend, { profile: "default", environment: "e2e" }).get("refresh_token")).toBeNull();
    expect(new Keychain(backend, { profile: "other", environment: "production" }).get("refresh_token")).toBeNull();
  });

  it("refuses to store an empty secret", () => {
    expect(() => new Keychain(new MemoryKeyring(), scope).set("access_token", "")).toThrow(TypeError);
  });

  it("no keychain → exit 1 with the exact text", () => {
    const backend = new MemoryKeyring();
    backend.failWith = new Error("Couldn't access platform secure storage: no Secret Service");
    let err: unknown;
    try {
      probeKeychain(backend);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KeychainError);
    const lines: string[] = [];
    expect(reportKeychainError(err as KeychainError, (l) => lines.push(l))).toBe(1);
    expect(lines).toEqual(["No OS keychain is available. Use the Assay SDK with an API key and a KMS key instead.\n"]);
    expect(NO_KEYCHAIN_MESSAGE).toBe("No OS keychain is available. Use the Assay SDK with an API key and a KMS key instead.");
  });

  it("a locked store → exit 1 with the unlock text", () => {
    const backend = new MemoryKeyring();
    backend.failWith = new Error("Platform secure storage failure: User interaction is not allowed.");
    expect(() => probeKeychain(backend)).toThrowError(LOCKED_KEYCHAIN_MESSAGE);
    expect(LOCKED_KEYCHAIN_MESSAGE).toBe("Unlock your keychain, then try again.");
    expect(classifyKeyringError(new Error("SS Error: object locked"))).toBe("locked");
    expect(classifyKeyringError(new Error("errSecInteractionNotAllowed -25308"))).toBe("locked");
    expect(classifyKeyringError(new Error("No such interface"))).toBe("unavailable");
    try {
      probeKeychain(backend);
    } catch (e) {
      expect((e as KeychainError).exitCode).toBe(1);
    }
  });

  it("never puts a secret or the platform error into its errors", () => {
    const backend = new MemoryKeyring();
    const kc = new Keychain(backend, scope);
    backend.failWith = new Error(`platform failure ${values.refresh_token}`);
    for (const op of [() => kc.set("refresh_token", values.refresh_token), () => kc.get("refresh_token"), () => kc.delete("refresh_token")]) {
      try {
        op();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(KeychainError);
        expect(String((e as Error).message)).not.toContain("assay_rt_");
        expect((e as Error).cause).toBeUndefined();
        expect(JSON.stringify(e)).not.toContain("assay_rt_");
      }
    }
  });
});

// Opt-in: touches the real OS keychain with a throw-away service name. Run with
// ASSAY_MCP_REAL_KEYCHAIN=1 npm test -w node -- keychain
describe.runIf(process.env.ASSAY_MCP_REAL_KEYCHAIN === "1")("real OS keychain (opt-in smoke test)", () => {
  it("round-trips through @napi-rs/keyring", async () => {
    const backend = await loadOsKeyring();
    probeKeychain(backend);
    const service = `${KEYCHAIN_SERVICE}.smoke-test`;
    const account = `smoke-${randomBytes(4).toString("hex")}@e2e/access_token`;
    const value = randomBytes(16).toString("hex");
    try {
      backend.set(service, account, value);
      expect(backend.get(service, account)).toBe(value);
    } finally {
      expect(backend.delete(service, account)).toBe(true);
    }
    expect(backend.get(service, account)).toBeNull();
  });
});
