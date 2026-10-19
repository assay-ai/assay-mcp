import { existsSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { MemoryKeyring } from "../../../node/test/helpers/memory-keyring.js";
import { realKeychainAttempts } from "./setup/no-os-keychain.js";

/**
 * `Signers.fromKeychain` through the proxy's keychain module, with the in-memory backend of the
 * proxy's own tests in place of the OS store. The temporary home (test setup) holds the profile
 * lock; the real profile and keychain are never touched.
 */

const memory = vi.hoisted(() => ({ ring: null as unknown as MemoryKeyring, opened: 0 }));

vi.mock("@assay-core/profile/keychain.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@assay-core/profile/keychain.js")>();
  return {
    ...real,
    openOsKeychain: async () => {
      memory.opened++;
      return { probe: async () => {}, forScope: (scope: import("@assay-core/profile/keychain.js").KeychainScope) => new real.Keychain(memory.ring, scope) };
    },
  };
});

const { Signers, SignerError } = await import("../src/signers.js");
const { resolveSigner } = await import("../src/signers.js");
const { KEYCHAIN_SERVICE } = await import("@assay-core/profile/keychain.js");
const { configDir } = await import("@assay-core/profile/paths.js");

describe("Signers.fromKeychain", () => {
  it("creates the profile's key once under the lock, then reuses it", async () => {
    memory.ring = new MemoryKeyring();
    const signer = Signers.fromKeychain({ profile: "ci" });
    expect(signer.address).toBeNull();
    const account = await resolveSigner(signer, "e2e");
    const stored = memory.ring.entries.get(`${KEYCHAIN_SERVICE}\u0000ci@e2e/delegate_key`);
    expect(stored).toMatch(/^0x[0-9a-f]{64}$/);
    expect(account.address).toBe(privateKeyToAccount(stored as `0x${string}`).address);
    expect(signer.address).toBe(account.address);
    // The write went under the profile lock in the (temporary) profile directory, and released it.
    expect(memory.ring.writeSignals).toHaveLength(1);
    expect(memory.ring.writeSignals[0]).toBeInstanceOf(AbortSignal);
    expect(existsSync(join(configDir(), "profiles", "ci.lock.d"))).toBe(false);

    const again = await resolveSigner(Signers.fromKeychain({ profile: "ci" }), "e2e");
    expect(again.address).toBe(account.address);
    expect(memory.ring.writeSignals).toHaveLength(1);
    expect(JSON.stringify(signer)).not.toContain(stored!.slice(2));
  });

  it("keys are per environment", async () => {
    memory.ring = new MemoryKeyring();
    const signer = Signers.fromKeychain({ profile: "ci" });
    const a = await resolveSigner(signer, "e2e");
    const b = await resolveSigner(signer, "production");
    expect(a.address).not.toBe(b.address);
  });

  it("refuses an invalid profile name and an unreadable stored key", async () => {
    expect(() => Signers.fromKeychain({ profile: "../x" })).toThrow(SignerError);
    memory.ring = new MemoryKeyring();
    memory.ring.entries.set(`${KEYCHAIN_SERVICE}\u0000ci@e2e/delegate_key`, "not-a-key");
    await expect(resolveSigner(Signers.fromKeychain({ profile: "ci" }), "e2e")).rejects.toThrow("the payment key stored in the keychain is unreadable");
  });
});

describe("the global keychain guard", () => {
  it("the real OS store is unreachable in tests", async () => {
    const real = await vi.importActual<typeof import("@assay-core/profile/keychain.js")>("@assay-core/profile/keychain.js");
    const before = realKeychainAttempts();
    const os = await real.openOsKeychain();
    await expect(os.probe()).rejects.toBeInstanceOf(real.KeychainError);
    expect(realKeychainAttempts()).toBe(before + 1);
  });
});
