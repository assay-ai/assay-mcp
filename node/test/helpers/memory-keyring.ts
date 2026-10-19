import type { KeyringBackend } from "../../src/profile/keychain.js";

/** An in-memory keyring for tests: they never touch the real OS keychain. */
export class MemoryKeyring implements KeyringBackend {
  readonly entries = new Map<string, string>();
  failWith: Error | null = null;
  /** The signal each write received (set and delete), in order. */
  readonly writeSignals: (AbortSignal | undefined)[] = [];
  /** Runs before a write lands; a test can stall it here. */
  beforeWrite: ((signal: AbortSignal | undefined) => Promise<void>) | null = null;

  private key(service: string, account: string): string {
    return `${service}\u0000${account}`;
  }
  private async gate(signal: AbortSignal | undefined): Promise<void> {
    this.writeSignals.push(signal);
    if (this.beforeWrite) await this.beforeWrite(signal);
    // Like @napi-rs/keyring: an aborted signal drops the write.
    if (signal?.aborted) throw new Error("AbortError: the write was aborted");
  }
  async get(service: string, account: string): Promise<string | null> {
    if (this.failWith) throw this.failWith;
    return this.entries.get(this.key(service, account)) ?? null;
  }
  async set(service: string, account: string, value: string, signal?: AbortSignal): Promise<void> {
    if (this.failWith) throw this.failWith;
    await this.gate(signal);
    this.entries.set(this.key(service, account), value);
  }
  async delete(service: string, account: string, signal?: AbortSignal): Promise<boolean> {
    if (this.failWith) throw this.failWith;
    await this.gate(signal);
    return this.entries.delete(this.key(service, account));
  }
}
