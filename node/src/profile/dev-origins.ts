import { ProfilePathError, readPrivateFile, writePrivateFile } from "./paths.js";

/**
 * Dev mode inputs (spec §7.3). Dev mode needs an origin listed in **both**
 * `ASSAY_MCP_DEV_ORIGINS` and `{dir}/dev-origins.json`; the file is written only by
 * `assay-mcp dev allow <origin>` on a TTY. Nothing a server sends can add to either list.
 */

export const DEV_ORIGINS_ENV = "ASSAY_MCP_DEV_ORIGINS";
export const DEV_ORIGINS_FILE = "dev-origins.json";

interface DevOriginsFile {
  version: 1;
  origins: string[];
}

/**
 * An origin in canonical form (`http://localhost:3200`), or `null` when `value` is not a
 * bare http(s) origin: no credentials, no path other than `/`, no query, no fragment.
 */
export function normaliseOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (/[?#]/.test(value.trim())) return null;
  return url.origin;
}

/** The origins in `ASSAY_MCP_DEV_ORIGINS` (a comma list); entries that are not origins are dropped. */
export function devOriginsFromEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  const raw = env[DEV_ORIGINS_ENV];
  if (!raw) return [];
  return unique(raw.split(",").map((s) => normaliseOrigin(s)).filter((o): o is string => o !== null));
}

/**
 * The origins in `{dir}/dev-origins.json`. A missing, unreadable, symlinked or malformed file
 * reads as empty: dev mode fails closed.
 */
export function readDevOrigins(dir: string): string[] {
  let text: string | null;
  try {
    text = readPrivateFile(dir, DEV_ORIGINS_FILE);
  } catch {
    return [];
  }
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const origins = (parsed as Partial<DevOriginsFile> | null)?.origins;
  if (!Array.isArray(origins)) return [];
  return unique(origins.filter((o): o is string => typeof o === "string").map((o) => normaliseOrigin(o)).filter((o): o is string => o !== null));
}

/**
 * The origins in the file for a writer: a missing file is empty, but a file that exists and
 * cannot be read or parsed throws, so a writer never silently replaces it.
 */
export function readDevOriginsForWrite(dir: string): string[] {
  const text = readPrivateFile(dir, DEV_ORIGINS_FILE);
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfilePathError(`${DEV_ORIGINS_FILE} is not valid JSON; fix or delete it first`);
  }
  const origins = (parsed as Partial<DevOriginsFile> | null)?.origins;
  if ((parsed as Partial<DevOriginsFile> | null)?.version !== 1 || !Array.isArray(origins) || !origins.every((o) => typeof o === "string" && normaliseOrigin(o) === o)) {
    throw new ProfilePathError(`${DEV_ORIGINS_FILE} is malformed; fix or delete it first`);
  }
  return unique(origins as string[]);
}

/**
 * Adds `origin` to `{dir}/dev-origins.json` (0600). The `dev allow` command checks for a TTY
 * and holds the `dev-origins` lock before it calls this; nothing else may.
 */
export function addDevOrigin(dir: string, origin: string): string {
  const normalised = normaliseOrigin(origin);
  if (normalised === null) throw new ProfilePathError("not an http(s) origin (expected e.g. http://localhost:3200)");
  const next: DevOriginsFile = { version: 1, origins: unique([...readDevOriginsForWrite(dir), normalised]) };
  writePrivateFile(dir, DEV_ORIGINS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return normalised;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
