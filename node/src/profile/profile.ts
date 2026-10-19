import { ENVIRONMENTS, type Environment } from "../deployments.js";
import type { LockHandle, ProfileRef } from "./lock.js";
import { canonicalPath, canonicalQuery, parseMcpUrl } from "./mcp-url.js";
import { profileFile, readPrivateFile, writePrivateFile } from "./paths.js";

/**
 * The profile files of spec §7.4. None holds a secret or a host name (R-MU-3): secrets are
 * in the keychain, and paid URLs are stored as canonical paths on the profile's MCP origin
 * (`/` stands for `{MCP}/`), so a host can never be read from a file.
 *
 * Every write is atomic (temp file, fsync, rename; 0600) and takes a `LockHandle`, so it can
 * only run inside `withLock` for the same profile (read-modify-write under the lock).
 */

export const PROFILE_VERSION = 1;

export class ProfileStateError extends Error {
  override readonly name = "ProfileStateError";
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CAIP2_RE = /^eip155:[1-9][0-9]{0,18}$/;
/** Decimal USD amounts: up to 6 fractional digits (the asset's precision). */
const USD_RE = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/;
const UNITS_RE = /^(0|[1-9][0-9]{0,30})$/;

export interface ProfileRecord {
  version: number;
  environment: Environment;
  credentialId: string;
  agentLabel: string;
  delegateAddress: string | null;
  /** Written only after the chain confirms it (§7.8 G4). */
  payer: string | null;
  network: string | null;
  createdAt: string;
}

export interface Limits {
  version: number;
  /** USD, decimal string. */
  perCall: string;
  /** USD per rolling 24 h, decimal string. */
  perDay: string;
  /** USD, or `null` for off. */
  confirmAbove: string | null;
  /** Provider ids allowed, or `null` for any. */
  providers: string[] | null;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  version: PROFILE_VERSION,
  perCall: "0.50",
  perDay: "5.00",
  confirmAbove: null,
  providers: null,
});

export interface PaidUrls {
  version: number;
  /** Canonical `path?query` on the profile's MCP origin. */
  urls: string[];
}

export interface SpendEntry {
  /** ISO 8601 UTC. */
  at: string;
  /** Asset base units, decimal string. */
  amount: string;
}

export interface ProfileState {
  version: number;
  signed: SpendEntry[];
  lastBrowserOpen: string | null;
}

function assertLock(profile: ProfileRef, lock: LockHandle): void {
  if (lock.profile.dir !== profile.dir || lock.profile.name !== profile.name) {
    throw new ProfileStateError("the lock held is for another profile");
  }
  lock.assertHeld();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIsoTime(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
}

function isShortText(v: unknown, max: number): v is string {
  // eslint-disable-next-line no-control-regex
  return typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
}

function readJson(profile: ProfileRef, rel: string): unknown {
  const text = readPrivateFile(profile.dir, rel);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ProfileStateError(`${rel} is not valid JSON`);
  }
}

function writeJson(profile: ProfileRef, rel: string, value: unknown): void {
  writePrivateFile(profile.dir, rel, `${JSON.stringify(value, null, 2)}\n`);
}

/** `path?query` → its canonical form, or `null` when it is not an accepted MCP path. */
export function canonicalPaidUrl(pathAndQuery: string): string | null {
  if (!pathAndQuery.startsWith("/") || pathAndQuery.startsWith("//")) return null;
  const parsed = parseMcpUrl(pathAndQuery);
  if (!parsed) return null;
  const query = canonicalQuery(parsed.filter);
  return `${canonicalPath(parsed.path)}${query ? `?${query}` : ""}`;
}

// ---- validation ----------------------------------------------------------------------

export function validateProfileRecord(v: unknown): ProfileRecord {
  const bad = (field: string) => new ProfileStateError(`profile file: invalid ${field}`);
  if (!isObject(v)) throw bad("record");
  if (v.version !== PROFILE_VERSION) throw bad("version");
  if (typeof v.environment !== "string" || !(ENVIRONMENTS as readonly string[]).includes(v.environment)) throw bad("environment");
  if (!isShortText(v.credentialId, 128) || !/^[A-Za-z0-9_-]+$/.test(v.credentialId)) throw bad("credentialId");
  if (!isShortText(v.agentLabel, 128)) throw bad("agentLabel");
  if (v.delegateAddress !== null && !(typeof v.delegateAddress === "string" && ADDRESS_RE.test(v.delegateAddress))) throw bad("delegateAddress");
  if (v.payer !== null && !(typeof v.payer === "string" && ADDRESS_RE.test(v.payer))) throw bad("payer");
  if (v.network !== null && !(typeof v.network === "string" && CAIP2_RE.test(v.network))) throw bad("network");
  if (!isIsoTime(v.createdAt)) throw bad("createdAt");
  return {
    version: PROFILE_VERSION,
    environment: v.environment as Environment,
    credentialId: v.credentialId,
    agentLabel: v.agentLabel,
    delegateAddress: v.delegateAddress,
    payer: v.payer,
    network: v.network,
    createdAt: v.createdAt,
  };
}

export function validateLimits(v: unknown): Limits {
  const bad = (field: string) => new ProfileStateError(`limits file: invalid ${field}`);
  if (!isObject(v)) throw bad("record");
  if (v.version !== PROFILE_VERSION) throw bad("version");
  if (typeof v.perCall !== "string" || !USD_RE.test(v.perCall)) throw bad("perCall");
  if (typeof v.perDay !== "string" || !USD_RE.test(v.perDay)) throw bad("perDay");
  if (v.confirmAbove !== null && !(typeof v.confirmAbove === "string" && USD_RE.test(v.confirmAbove))) throw bad("confirmAbove");
  if (v.providers !== null) {
    if (!Array.isArray(v.providers) || v.providers.length === 0 || v.providers.length > 100) throw bad("providers");
    if (!v.providers.every((p) => isShortText(p, 128) && /^[A-Za-z0-9_:-]+$/.test(p))) throw bad("providers");
  }
  return {
    version: PROFILE_VERSION,
    perCall: v.perCall,
    perDay: v.perDay,
    confirmAbove: v.confirmAbove,
    providers: v.providers === null ? null : [...(v.providers as string[])],
  };
}

export function validatePaidUrls(v: unknown): PaidUrls {
  if (!isObject(v) || v.version !== PROFILE_VERSION || !Array.isArray(v.urls)) throw new ProfileStateError("paid-urls file: invalid record");
  const urls: string[] = [];
  for (const u of v.urls) {
    const c = typeof u === "string" ? canonicalPaidUrl(u) : null;
    if (c === null || c !== u) throw new ProfileStateError("paid-urls file: invalid URL path");
    if (!urls.includes(c)) urls.push(c);
  }
  return { version: PROFILE_VERSION, urls };
}

export function validateState(v: unknown): ProfileState {
  const bad = (field: string) => new ProfileStateError(`state file: invalid ${field}`);
  if (!isObject(v) || v.version !== PROFILE_VERSION) throw bad("record");
  if (!Array.isArray(v.signed)) throw bad("signed");
  const signed: SpendEntry[] = [];
  for (const e of v.signed) {
    if (!isObject(e) || !isIsoTime(e.at) || typeof e.amount !== "string" || !UNITS_RE.test(e.amount)) throw bad("signed entry");
    signed.push({ at: e.at, amount: e.amount });
  }
  if (v.lastBrowserOpen !== null && !isIsoTime(v.lastBrowserOpen)) throw bad("lastBrowserOpen");
  return { version: PROFILE_VERSION, signed, lastBrowserOpen: v.lastBrowserOpen };
}

// ---- profile.json --------------------------------------------------------------------

export type NewProfile = Omit<ProfileRecord, "version" | "payer" | "delegateAddress" | "network"> &
  Partial<Pick<ProfileRecord, "delegateAddress" | "network">>;

/** `null` when the profile does not exist yet. */
export function readProfile(profile: ProfileRef): ProfileRecord | null {
  const v = readJson(profile, profileFile(profile.name, "profile"));
  return v === undefined ? null : validateProfileRecord(v);
}

/**
 * Creates (or replaces, after a new sign-in) `profiles/{profile}.json`. On first creation
 * also writes the default `limits.json` ($0.50 / $5 / off / any) and `paid-urls.json`
 * with `{MCP}/`; existing limits and paid URLs are kept.
 */
export function createProfile(profile: ProfileRef, lock: LockHandle, input: NewProfile): ProfileRecord {
  assertLock(profile, lock);
  const record = validateProfileRecord({
    version: PROFILE_VERSION,
    environment: input.environment,
    credentialId: input.credentialId,
    agentLabel: input.agentLabel,
    delegateAddress: input.delegateAddress ?? null,
    payer: null,
    network: input.network ?? null,
    createdAt: input.createdAt,
  });
  if (readJson(profile, profileFile(profile.name, "limits")) === undefined) {
    writeJson(profile, profileFile(profile.name, "limits"), DEFAULT_LIMITS);
  }
  if (readJson(profile, profileFile(profile.name, "paid-urls")) === undefined) {
    writeJson(profile, profileFile(profile.name, "paid-urls"), { version: PROFILE_VERSION, urls: ["/"] });
  }
  writeJson(profile, profileFile(profile.name, "profile"), record);
  return record;
}

/** Read-modify-write of `profiles/{profile}.json` under the lock. */
export function updateProfile(profile: ProfileRef, lock: LockHandle, change: (current: ProfileRecord) => ProfileRecord): ProfileRecord {
  assertLock(profile, lock);
  const current = readProfile(profile);
  if (current === null) throw new ProfileStateError("profile file: not found");
  const next = validateProfileRecord(change(structuredClone(current)));
  if (next.environment !== current.environment || next.createdAt !== current.createdAt) {
    throw new ProfileStateError("profile file: environment and createdAt cannot change");
  }
  lock.assertHeld();
  writeJson(profile, profileFile(profile.name, "profile"), next);
  return next;
}

// ---- limits.json ---------------------------------------------------------------------

/** The limits; the defaults when the file does not exist yet. */
export function readLimits(profile: ProfileRef): Limits {
  const v = readJson(profile, profileFile(profile.name, "limits"));
  return v === undefined ? { ...DEFAULT_LIMITS } : validateLimits(v);
}

/** Only `limits set` (on a TTY) calls this. */
export function writeLimits(profile: ProfileRef, lock: LockHandle, limits: Omit<Limits, "version">): Limits {
  assertLock(profile, lock);
  const next = validateLimits({ ...limits, version: PROFILE_VERSION });
  writeJson(profile, profileFile(profile.name, "limits"), next);
  return next;
}

// ---- paid-urls.json ------------------------------------------------------------------

/** Canonical paths allowed for paid calls; `["/"]` when the file does not exist yet. */
export function readPaidUrls(profile: ProfileRef): string[] {
  const v = readJson(profile, profileFile(profile.name, "paid-urls"));
  return v === undefined ? ["/"] : validatePaidUrls(v).urls;
}

function changePaidUrls(profile: ProfileRef, lock: LockHandle, pathAndQuery: string, add: boolean): string[] {
  assertLock(profile, lock);
  const c = canonicalPaidUrl(pathAndQuery);
  if (c === null) throw new ProfileStateError("not an Assay MCP URL path");
  const urls = readPaidUrls(profile).filter((u) => u !== c);
  if (add) urls.push(c);
  lock.assertHeld();
  writeJson(profile, profileFile(profile.name, "paid-urls"), { version: PROFILE_VERSION, urls });
  return urls;
}

/** For `add --scope user` and `allow-paid` (on a TTY). Takes the canonical path, never a host. */
export function addPaidUrl(profile: ProfileRef, lock: LockHandle, pathAndQuery: string): string[] {
  return changePaidUrls(profile, lock, pathAndQuery, true);
}

/** For `disallow-paid` (on a TTY). */
export function removePaidUrl(profile: ProfileRef, lock: LockHandle, pathAndQuery: string): string[] {
  return changePaidUrls(profile, lock, pathAndQuery, false);
}

// ---- state.json ----------------------------------------------------------------------

export function readState(profile: ProfileRef): ProfileState {
  const v = readJson(profile, profileFile(profile.name, "state"));
  return v === undefined ? { version: PROFILE_VERSION, signed: [], lastBrowserOpen: null } : validateState(v);
}

/** Read-modify-write of `state.json` under the lock. A corrupt file is an error (fail closed), never reset. */
export function updateState(profile: ProfileRef, lock: LockHandle, change: (current: ProfileState) => ProfileState): ProfileState {
  assertLock(profile, lock);
  const next = validateState(change(readState(profile)));
  lock.assertHeld();
  writeJson(profile, profileFile(profile.name, "state"), next);
  return next;
}
