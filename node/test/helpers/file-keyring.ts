import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { KeyringBackend } from "../../src/profile/keychain.js";

/**
 * A keyring kept in one JSON file, so several test processes share it like the OS keychain.
 * Tests only: the real keychain is never touched. Writes are atomic (temp file + rename);
 * the callers write only under the profile lock.
 */
export class FileKeyring implements KeyringBackend {
  constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
  }
  private write(entries: Record<string, string>): void {
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  async get(service: string, account: string): Promise<string | null> {
    return this.read()[`${service}/${account}`] ?? null;
  }
  async set(service: string, account: string, value: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("aborted");
    const e = this.read();
    e[`${service}/${account}`] = value;
    this.write(e);
  }
  async delete(service: string, account: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) throw new Error("aborted");
    const e = this.read();
    const key = `${service}/${account}`;
    if (!(key in e)) return false;
    delete e[key];
    this.write(e);
    return true;
  }
}
