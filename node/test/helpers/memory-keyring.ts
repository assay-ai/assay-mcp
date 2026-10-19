import type { KeyringBackend } from "../../src/profile/keychain.js";

/** An in-memory keyring for tests: they never touch the real OS keychain. */
export class MemoryKeyring implements KeyringBackend {
  readonly entries = new Map<string, string>();
  failWith: Error | null = null;

  private key(service: string, account: string): string {
    return `${service}\u0000${account}`;
  }
  get(service: string, account: string): string | null {
    if (this.failWith) throw this.failWith;
    return this.entries.get(this.key(service, account)) ?? null;
  }
  set(service: string, account: string, value: string): void {
    if (this.failWith) throw this.failWith;
    this.entries.set(this.key(service, account), value);
  }
  delete(service: string, account: string): boolean {
    if (this.failWith) throw this.failWith;
    return this.entries.delete(this.key(service, account));
  }
}
