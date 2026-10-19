import { ENVIRONMENTS, type Environment } from "../deployments.js";
import { EXIT_FATAL } from "../exit-codes.js";
import { isValidProfileName } from "./paths.js";

/**
 * Profile secrets in the OS keychain (spec §7.4, §7.9; R-MCP-6, R-MU-3).
 *
 * The access token, the refresh token and the delegate private key live only here: never in
 * a file, a log, an environment variable or an error message. There is no file fallback in
 * v1: with no usable keychain, `assay-mcp` exits 1.
 *
 * Entries are `@napi-rs/keyring` `Entry("ai.assay.mcp", "{profile}@{environment}/{kind}")`.
 * Every read goes to the keychain (nothing is cached), so a process that takes the profile
 * lock always sees what another process stored before it (R-MU-6).
 */

export const KEYCHAIN_SERVICE = "ai.assay.mcp";
export const SECRET_KINDS = ["access_token", "refresh_token", "delegate_key"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export const NO_KEYCHAIN_MESSAGE = "No OS keychain is available. Use the Assay SDK with an API key and a KMS key instead.";
export const LOCKED_KEYCHAIN_MESSAGE = "Unlock your keychain, then try again.";

/** The account name of the probe entry; it is read, never written. */
const PROBE_ACCOUNT = "probe";

/**
 * The storage the keychain uses. Production uses the OS keychain through `@napi-rs/keyring`;
 * tests inject an in-memory backend so they never touch the real keychain.
 */
export interface KeyringBackend {
  get(service: string, account: string): string | null;
  set(service: string, account: string, value: string): void;
  /** True if an entry was deleted, false if there was none. */
  delete(service: string, account: string): boolean;
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

function guarded<T>(op: () => T): T {
  try {
    return op();
  } catch (err) {
    if (err instanceof KeychainError) throw err;
    throw new KeychainError(classifyKeyringError(err));
  }
}

/**
 * Checks at startup that the keychain can be read. Throws `KeychainError` (exit code 1)
 * with the exact §7.9 text, or the "unlock" text for a locked store.
 */
export function probeKeychain(backend: KeyringBackend): void {
  guarded(() => backend.get(KEYCHAIN_SERVICE, PROBE_ACCOUNT));
}

/** Writes the failure text to stderr and returns exit code 1. For the command entry points. */
export function reportKeychainError(err: KeychainError, stderr: (line: string) => void = (l) => process.stderr.write(l)): number {
  stderr(`${err.message}\n`);
  return err.exitCode;
}

/** One profile's secrets. */
export class Keychain {
  constructor(
    private readonly backend: KeyringBackend,
    private readonly scope: KeychainScope,
  ) {
    accountFor(scope, "access_token"); // validates the scope early
  }

  get(kind: SecretKind): string | null {
    const account = accountFor(this.scope, kind);
    const value = guarded(() => this.backend.get(KEYCHAIN_SERVICE, account));
    return value === null || value === undefined || value === "" ? null : value;
  }

  set(kind: SecretKind, value: string): void {
    const account = accountFor(this.scope, kind);
    if (typeof value !== "string" || value === "") throw new TypeError("refusing to store an empty secret");
    guarded(() => this.backend.set(KEYCHAIN_SERVICE, account, value));
  }

  delete(kind: SecretKind): boolean {
    const account = accountFor(this.scope, kind);
    return guarded(() => this.backend.delete(KEYCHAIN_SERVICE, account));
  }

  /** Removes every secret of the profile (logout). */
  clear(): void {
    for (const kind of SECRET_KINDS) this.delete(kind);
  }
}

interface NapiEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
type NapiEntryCtor = new (service: string, account: string) => NapiEntry;

/** The OS keychain through `@napi-rs/keyring`, loaded on first use (so `--version` never loads it). */
export async function loadOsKeyring(): Promise<KeyringBackend> {
  let Entry: NapiEntryCtor;
  try {
    ({ Entry } = (await import("@napi-rs/keyring")) as unknown as { Entry: NapiEntryCtor });
  } catch {
    throw new KeychainError("unavailable");
  }
  return {
    get: (service, account) => new Entry(service, account).getPassword() ?? null,
    set: (service, account, value) => new Entry(service, account).setPassword(value),
    delete: (service, account) => new Entry(service, account).deletePassword(),
  };
}
