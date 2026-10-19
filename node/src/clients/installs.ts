/**
 * `{dir}/installs.json`: `[{client, scope, name, url, profile, configPath}]` (spec 7.4). No
 * secrets. Every read-modify-write runs under a lock (the Task 2.5 profile lock, see
 * `commands/wiring.ts`), so two `add`/`remove` runs never lose each other's record.
 */
import { isClientId, type ClientId, type Scope } from "./install-command.js";
import type { PrivateFiles } from "./ports.js";
import { isValidName } from "./server-name.js";

export const INSTALLS_FILE = "installs.json";

export interface InstallRecord {
  client: ClientId;
  scope: Scope;
  name: string;
  url: string;
  profile: string;
  configPath: string;
}

export class InstallsError extends Error {
  override readonly name = "InstallsError";
}

/** Runs `fn` while holding the lock; `assertHeld` throws if the lock was lost, and is called right before the write. */
export type InstallsLock = <T>(fn: (assertHeld: () => void) => T) => Promise<T>;

export interface InstallsStore {
  read(): InstallRecord[];
  /** Read, change and write under the lock. */
  update(change: (records: InstallRecord[]) => InstallRecord[]): Promise<void>;
}

function isRecord(v: unknown): v is InstallRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    Object.keys(r).length === 6 &&
    typeof r.client === "string" &&
    isClientId(r.client) &&
    (r.scope === "user" || r.scope === "project") &&
    typeof r.name === "string" &&
    isValidName(r.name) &&
    typeof r.url === "string" &&
    typeof r.profile === "string" &&
    typeof r.configPath === "string" &&
    r.configPath.length > 0
  );
}

export function readInstalls(files: PrivateFiles): InstallRecord[] {
  const text = files.read(INSTALLS_FILE);
  if (text === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InstallsError(`${INSTALLS_FILE} is not valid JSON`);
  }
  if (!Array.isArray(data) || !data.every(isRecord)) throw new InstallsError(`${INSTALLS_FILE} has an invalid record`);
  return data;
}

function serialize(records: readonly InstallRecord[]): string {
  const clean = records.map(({ client, scope, name, url, profile, configPath }) => ({ client, scope, name, url, profile, configPath }));
  return `${JSON.stringify(clean, null, 2)}\n`;
}

export function installsStore(files: PrivateFiles, lock: InstallsLock): InstallsStore {
  return {
    read: () => readInstalls(files),
    update: (change) =>
      lock((assertHeld) => {
        const next = change(readInstalls(files));
        assertHeld();
        files.write(INSTALLS_FILE, serialize(next));
      }),
  };
}

function sameInstall(a: InstallRecord, b: Pick<InstallRecord, "client" | "name" | "configPath">): boolean {
  return a.client === b.client && a.name === b.name && a.configPath === b.configPath;
}

/** Adds or replaces the record for (client, name, configPath). */
export function recordInstall(store: InstallsStore, record: InstallRecord): Promise<void> {
  return store.update((records) => [...records.filter((r) => !sameInstall(r, record)), record]);
}

export function forgetInstall(store: InstallsStore, record: Pick<InstallRecord, "client" | "name" | "configPath">): Promise<void> {
  return store.update((records) => records.filter((r) => !sameInstall(r, record)));
}
