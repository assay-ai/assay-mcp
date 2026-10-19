/** `{dir}/installs.json`: `[{client, scope, name, url, profile, configPath}]` (spec 7.4). No secrets, written by `add`/`remove`. */
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

export function writeInstalls(files: PrivateFiles, records: readonly InstallRecord[]): void {
  const clean = records.map(({ client, scope, name, url, profile, configPath }) => ({ client, scope, name, url, profile, configPath }));
  files.write(INSTALLS_FILE, `${JSON.stringify(clean, null, 2)}\n`);
}

function sameInstall(a: InstallRecord, b: Pick<InstallRecord, "client" | "name" | "configPath">): boolean {
  return a.client === b.client && a.name === b.name && a.configPath === b.configPath;
}

/** Adds or replaces the record for (client, name, configPath). */
export function recordInstall(files: PrivateFiles, record: InstallRecord): void {
  writeInstalls(files, [...readInstalls(files).filter((r) => !sameInstall(r, record)), record]);
}

export function forgetInstall(files: PrivateFiles, record: Pick<InstallRecord, "client" | "name" | "configPath">): void {
  writeInstalls(files, readInstalls(files).filter((r) => !sameInstall(r, record)));
}
