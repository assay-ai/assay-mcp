import type { KeyringBackend } from "../../src/profile/keychain.js";

/** An in-memory keyring for tests: they never touch the real OS keychain. */
export class MemoryKeyring implements KeyringBackend {
  readonly entries = new Map<string, string>();
  failWith: Error | null = null;

  private key(service: string, account: string): string {
    return `${service}\u0000${account}`;
  }
  async get(service: string, account: string): Promise<string | null> {
    if (this.failWith) throw this.failWith;
    return this.entries.get(this.key(service, account)) ?? null;
  }
  async set(service: string, account: string, value: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.entries.set(this.key(service, account), value);
  }
  async delete(service: string, account: string): Promise<boolean> {
    if (this.failWith) throw this.failWith;
    return this.entries.delete(this.key(service, account));
  }
}
