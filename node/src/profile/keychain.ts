import { ENVIRONMENTS, type Environment } from "../deployments.js";
import { EXIT_FATAL } from "../exit-codes.js";
import type { LockHandle } from "./lock.js";
import { isValidProfileName } from "./paths.js";

/**
 * Profile secrets in the OS keychain (spec §7.4, §7.9; R-MCP-6, R-MU-3, R-MU-6).
 *
 * The access token, the refresh token and the delegate private key live only here: never in
 * a file, a log, an environment variable or an error message. There is no file fallback in
 * v1: with no usable keychain, `assay-mcp` exits 1. On Linux only the Secret Service is used;
 * the kernel keyutils store (the library's silent fallback) is never used.
 *
 * Entries are `@napi-rs/keyring` `AsyncEntry("ai.assay.mcp", "{profile}@{environment}/{kind}")`.
 * The service and the account are fixed in code; nothing comes from the environment.
 * Calls are asynchronous so a keychain prompt does not freeze the lock heartbeat.
 *
 * Every read goes to the keychain (nothing is cached), so a process that takes the profile
 * lock sees what another process stored before it. Every write takes the `LockHandle` and
 * calls `assertHeld()` immediately before writing (see the rules in `lock.ts`).
 */

export const KEYCHAIN_SERVICE = "ai.assay.mcp";
export const SECRET_KINDS = ["access_token", "refresh_token", "delegate_key"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export const NO_KEYCHAIN_MESSAGE = "No OS keychain is available. Use the Assay SDK with an API key and a KMS key instead.";
export const LOCKED_KEYCHAIN_MESSAGE = "Unlock your keychain, then try again.";

/** The account name of the probe entry; it is read, never written. */
const PROBE_ACCOUNT = "probe";

/** Entry options for every operation: Secret Service only on Linux (ignored elsewhere). */
export const ENTRY_OPTIONS = Object.freeze({ linux: Object.freeze({ store: "secret-service" as const }) });

/**
 * The storage the keychain uses. Production uses the OS keychain through `@napi-rs/keyring`;
 * tests inject an in-memory backend so they never touch the real keychain.
 */
export interface KeyringBackend {
  get(service: string, account: string): Promise<string | null>;
  /** `signal`: the lock's signal; an aborted write is dropped by the store (`@napi-rs/keyring`). */
  set(service: string, account: string, value: string, signal?: AbortSignal): Promise<void>;
  /** True if an entry was deleted, false if there was none. */
  delete(service: string, account: string, signal?: AbortSignal): Promise<boolean>;
}

export type KeychainFailure = "unavailable" | "locked";

export class KeychainError extends Error {
  override readonly name = "KeychainError";
  readonly exitCode = EXIT_FATAL;
  constructor(readonly reason: KeychainFailure) {
    super(reason === "locked" ? LOCKED_KEYCHAIN_MESSAGE : NO_KEYCHAIN_MESSAGE);
  }
}

/**
 * Maps an error thrown by the keyring to a failure kind. The original error is dropped on
 * purpose: its text comes from the platform and is never shown or logged.
 *
 * Locked: macOS `errSecInteractionNotAllowed` (-25308), `errSecAuthFailed` (-25293) and the
 * Secret Service "locked" errors.
 */
export function classifyKeyringError(err: unknown): KeychainFailure {
  const text = err instanceof Error ? err.message : String(err);
  return /\block(ed)?\b|interaction is not allowed|-25308|-25293/i.test(text) ? "locked" : "unavailable";
}

export interface KeychainScope {
  profile: string;
  environment: Environment;
}

/** `{profile}@{environment}/{kind}`. */
export function accountFor({ profile, environment }: KeychainScope, kind: SecretKind): string {
  if (!isValidProfileName(profile)) throw new TypeError("invalid profile name");
  if (!(ENVIRONMENTS as readonly string[]).includes(environment)) throw new TypeError("invalid environment");
  if (!(SECRET_KINDS as readonly string[]).includes(kind)) throw new TypeError("invalid secret kind");
  return `${profile}@${environment}/${kind}`;
}

async function guarded<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof KeychainError) throw err;
    throw new KeychainError(classifyKeyringError(err));
  }
}

/**
 * A keychain write under the lock: an abort (the lock was lost while it was pending) and a
 * completion after the loss both surface as `LOCK_LOST`, never as a keychain failure.
 */
async function guardedUnderLock<T>(lock: LockHandle, op: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await guarded(op);
  } catch (err) {
    if (lock.signal.aborted) lock.assertHeld();
    throw err;
  }
  lock.assertHeld();
  return result;
}

/**
 * Checks at startup that the keychain can be read. Throws `KeychainError` (exit code 1)
 * with the exact §7.9 text, or the "unlock" text for a locked store.
 */
export async function probeKeychain(backend: KeyringBackend): Promise<void> {
  await guarded(() => backend.get(KEYCHAIN_SERVICE, PROBE_ACCOUNT));
}

/** Writes the failure text to stderr and returns exit code 1. For the command entry points. */
export function reportKeychainError(err: KeychainError, stderr: (line: string) => void = (l) => process.stderr.write(l)): number {
  stderr(`${err.message}\n`);
  return err.exitCode;
}

/** The access token and when it expires (Unix seconds), stored together in one entry. */
export interface AccessToken {
  token: string;
  expiresAt: number;
}

/** One profile's secrets. */
export class Keychain {
  constructor(
    private readonly backend: KeyringBackend,
    private readonly scope: KeychainScope,
  ) {
    accountFor(scope, "access_token"); // validates the scope early
  }

  private checkLock(lock: LockHandle): void {
    if (lock.profile.name !== this.scope.profile) throw new TypeError("the lock held is for another profile");
    lock.assertHeld();
  }

  async get(kind: SecretKind): Promise<string | null> {
    const account = accountFor(this.scope, kind);
    const value = await guarded(() => this.backend.get(KEYCHAIN_SERVICE, account));
    return value === null || value === undefined || value === "" ? null : value;
  }

  /**
   * Writes one secret. Refused with `LOCK_LOST` unless `lock` is held and fresh right now.
   * `lock.signal` goes to the store, so a write still pending when the lock is lost is
   * aborted; a write that completes after the loss throws `LOCK_LOST` to the caller.
   */
  async set(lock: LockHandle, kind: SecretKind, value: string): Promise<void> {
    const account = accountFor(this.scope, kind);
    if (typeof value !== "string" || value === "") throw new TypeError("refusing to store an empty secret");
    this.checkLock(lock);
    await guardedUnderLock(lock, () => this.backend.set(KEYCHAIN_SERVICE, account, value, lock.signal));
  }

  async delete(lock: LockHandle, kind: SecretKind): Promise<boolean> {
    const account = accountFor(this.scope, kind);
    this.checkLock(lock);
    return guardedUnderLock(lock, () => this.backend.delete(KEYCHAIN_SERVICE, account, lock.signal));
  }

  /** Removes every secret of the profile (logout). */
  async clear(lock: LockHandle): Promise<void> {
    for (const kind of SECRET_KINDS) await this.delete(lock, kind);
  }

  /** The access token and its expiry; `null` when missing or unreadable. */
  async getAccessToken(): Promise<AccessToken | null> {
    const raw = await this.get("access_token");
    if (raw === null) return null;
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      if (typeof v.token === "string" && v.token !== "" && typeof v.expiresAt === "number" && Number.isSafeInteger(v.expiresAt)) {
        return { token: v.token, expiresAt: v.expiresAt };
      }
    } catch {
      // unreadable: treated as missing
    }
    return null;
  }

  /**
   * Stores a new token pair (refresh token first, then the access token with its expiry).
   * Each write checks the lock; an answer that arrives after the lock was lost is dropped.
   */
  async storeTokens(lock: LockHandle, tokens: { refreshToken: string; accessToken: AccessToken }): Promise<void> {
    const { token, expiresAt } = tokens.accessToken;
    if (token === "" || !Number.isSafeInteger(expiresAt)) throw new TypeError("invalid access token");
    await this.set(lock, "refresh_token", tokens.refreshToken);
    await this.set(lock, "access_token", JSON.stringify({ token, expiresAt }));
  }

  /**
   * After `invalid_grant`: deletes both tokens only if the keychain still holds the refresh
   * token that was sent. Returns false (and deletes nothing) when a newer one was stored.
   */
  async deleteTokensIfRefreshIs(lock: LockHandle, sentRefreshToken: string): Promise<boolean> {
    this.checkLock(lock);
    if ((await this.get("refresh_token")) !== sentRefreshToken) return false;
    await this.delete(lock, "access_token");
    await this.delete(lock, "refresh_token");
    return true;
  }
}

interface NapiAsyncEntry {
  getPassword(): Promise<string | undefined | null>;
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
  deletePassword(signal?: AbortSignal): Promise<boolean>;
}
export type NapiAsyncEntryCtor = new (service: string, account: string, options?: typeof ENTRY_OPTIONS) => NapiAsyncEntry;

/** A backend over `@napi-rs/keyring`'s `AsyncEntry`, always with `ENTRY_OPTIONS`. */
export function keyringBackendFrom(AsyncEntry: NapiAsyncEntryCtor): KeyringBackend {
  const entry = (service: string, account: string) => new AsyncEntry(service, account, ENTRY_OPTIONS);
  return {
    get: async (service, account) => (await entry(service, account).getPassword()) ?? null,
    set: (service, account, value, signal) => entry(service, account).setPassword(value, signal),
    delete: (service, account, signal) => entry(service, account).deletePassword(signal),
  };
}

/**
 * The OS keychain through `@napi-rs/keyring`, loaded on first use (so `--version` never loads
 * it). Not exported: callers get the probe and lock-aware `Keychain`s from `openOsKeychain`,
 * never the raw store.
 */
async function loadOsKeyring(): Promise<KeyringBackend> {
  let AsyncEntry: NapiAsyncEntryCtor;
  try {
    ({ AsyncEntry } = (await import("@napi-rs/keyring")) as unknown as { AsyncEntry: NapiAsyncEntryCtor });
  } catch {
    throw new KeychainError("unavailable");
  }
  return keyringBackendFrom(AsyncEntry);
}

/** The OS keychain, reachable only through the probe and the lock-aware {@link Keychain}. */
export interface OsKeychain {
  /** The startup probe (see {@link probeKeychain}). */
  probe(): Promise<void>;
  /** The secrets of one profile and environment. */
  forScope(scope: KeychainScope): Keychain;
}

export async function openOsKeychain(): Promise<OsKeychain> {
  const backend = await loadOsKeyring();
  return { probe: () => probeKeychain(backend), forScope: (scope) => new Keychain(backend, scope) };
}

/** The service of the gated real-keychain smoke test; never the product service. */
export const SMOKE_TEST_SERVICE = `${KEYCHAIN_SERVICE}.smoke-test`;

/**
 * For the gated CI smoke test only: writes, reads back and deletes one random value under
 * {@link SMOKE_TEST_SERVICE}. Returns true when every step behaved.
 */
export async function realKeychainSmokeTest(account: string, value: string): Promise<boolean> {
  const backend = await loadOsKeyring();
  await probeKeychain(backend);
  let ok = false;
  try {
    await guarded(() => backend.set(SMOKE_TEST_SERVICE, account, value));
    ok = (await guarded(() => backend.get(SMOKE_TEST_SERVICE, account))) === value;
  } finally {
    ok = (await guarded(() => backend.delete(SMOKE_TEST_SERVICE, account))) && ok;
  }
  return ok && (await guarded(() => backend.get(SMOKE_TEST_SERVICE, account))) === null;
}
