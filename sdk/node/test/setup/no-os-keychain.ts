/**
 * Global guard for every SDK test file: the real OS keychain is never touched. `@napi-rs/keyring`
 * is replaced by an entry whose every operation throws, so a test that reaches the real store
 * fails (the keychain module reports it as "no keychain"), and the attempt is counted for
 * `test/keychain-guard.test.ts`. Tests use the in-memory backend of the proxy's own tests.
 */
import { vi } from "vitest";

const touched = vi.hoisted(() => ({ count: 0 }));

vi.mock("@napi-rs/keyring", () => {
  class AsyncEntry {
    constructor() {
      touched.count++;
    }
    getPassword(): Promise<never> {
      return Promise.reject(new Error("the real OS keychain is not available in tests"));
    }
    setPassword(): Promise<never> {
      return Promise.reject(new Error("the real OS keychain is not available in tests"));
    }
    deletePassword(): Promise<never> {
      return Promise.reject(new Error("the real OS keychain is not available in tests"));
    }
  }
  return { AsyncEntry, Entry: AsyncEntry };
});

/** How many times this test file built a real keychain entry (each one was refused). */
export function realKeychainAttempts(): number {
  return touched.count;
}
