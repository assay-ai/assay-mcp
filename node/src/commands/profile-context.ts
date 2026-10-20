/**
 * What the profile commands (`login`, `logout`, `status`, `enable-paid`, `limits`,
 * `allow-paid`, `disallow-paid`, `dev allow`, `settings`, `doctor`) run against. Tests pass
 * their own (a temp `{dir}`, a memory keyring, fake servers and chain); `defaultProfileDeps`
 * builds the real one.
 *
 * Every human-readable line goes to stderr: stdout is reserved for MCP JSON-RPC (R-MCP-3).
 */
import { RUN } from "../version.js";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { createChainReader, type ChainReader } from "../chain/reads.js";
import { CLIENTS } from "../clients/registry.js";
import type { ClientAdapter } from "../clients/client.js";
import { DEFAULT_PROFILE, type ClientId } from "../clients/install-command.js";
import { readInstalls, type InstallRecord } from "../clients/installs.js";
import { builtInDeployments, type Environment } from "../deployments.js";
import { EXIT_FATAL, EXIT_USAGE } from "../exit-codes.js";
import { redact } from "../log/redact.js";
import { silentLogger, type Logger } from "../log/logger.js";
import { openBrowser, SignInError, type SignInDeps } from "../oauth/flow.js";
import { RefreshError } from "../oauth/tokens.js";
import { ApiKeyError } from "../oauth/api-key.js";
import { OriginError, resolveDeployment, type ResolvedDeployment } from "../profile/deployments.js";
import { readDevOrigins } from "../profile/dev-origins.js";
import { KeychainError, openOsKeychain, reportKeychainError, type Keychain, type OsKeychain } from "../profile/keychain.js";
import { LockError, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { configDir, isValidProfileName, readPrivateFile } from "../profile/paths.js";
import { readProfile } from "../profile/profile.js";
import { isInteractive, TtyRequired } from "../tty.js";
import { UsageError } from "./context.js";
import { printable } from "./format.js";

/** §7.15: the lock wait ran out; never refresh. The CLI form of JSON-RPC `-32001`. */
export const LOCK_TIMEOUT_TEXT = "Assay sign-in in progress in another window.";

export interface ProfileDeps {
  /** `{dir}`. */
  dir: string;
  /** The OS account's home directory (client configs live under it). */
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** stdin and stdout are both TTYs. */
  isTTY: boolean;
  /** Human output: stderr only. */
  print(text: string): void;
  /** A yes/no question on the TTY; true only for an explicit yes. */
  confirm(question: string): Promise<boolean>;
  /** A free-text answer on the TTY (trimmed); null when there was none. */
  prompt(question: string): Promise<string | null>;
  /** The OS keychain (`openOsKeychain()` in production; a memory keyring in tests). */
  openKeychain(): Promise<OsKeychain>;
  /** Opens a URL built from `{WEB}` or `{MCP}` without a shell (R-MCP-18). */
  openBrowser(deployment: ResolvedDeployment, url: string): Promise<boolean>;
  /** The chain reader for one environment and profile. */
  chain(environment: Environment, profile: string): Pick<ChainReader, "readDelegation">;
  nowSeconds(): number;
  log: Logger;
  clients: Readonly<Record<ClientId, ClientAdapter>>;
  /** Test hooks for the sign-in (loopback ports, waits, host name). */
  signIn?: Partial<Pick<SignInDeps, "ports" | "timeoutMs" | "hostname" | "requestTimeoutMs" | "openBrowser">>;
  lockOptions?: LockOptions;
  /** Per-request timeout for API and revoke calls. */
  requestTimeoutMs?: number;
}

export function profileRef(deps: Pick<ProfileDeps, "dir">, name: string): ProfileRef {
  return { dir: deps.dir, name };
}

export function checkProfileName(name: string | undefined): string {
  const profile = name ?? DEFAULT_PROFILE;
  if (!isValidProfileName(profile)) throw new UsageError(`invalid profile name "${profile}"`);
  return profile;
}

/**
 * The deployment a profile command talks to. Hosts come only from the built-in table:
 * - with `--url` (login only), the URL selects it exactly as for `serve` (dev mode needs both
 *   `ASSAY_MCP_DEV_ORIGINS` and `dev-origins.json`);
 * - else the profile's own environment, if it has one: the same dev-mode gates apply, so a
 *   dev profile is refused while dev mode is off;
 * - else production.
 */
export function profileDeployment(deps: ProfileDeps, profile: string, url?: string): ResolvedDeployment {
  const record = readProfile(profileRef(deps, profile));
  const inputs = { env: deps.env, devOrigins: readDevOrigins(deps.dir), warn: (line: string) => deps.print(`${line}\n`) };
  if (url !== undefined) {
    const resolved = resolveDeployment({ ...inputs, url });
    if (record !== null && record.environment !== resolved.environment) {
      throw new UsageError(`profile "${profile}" belongs to the ${record.environment} environment; use another --profile`);
    }
    return resolved;
  }
  if (record === null || record.environment === "production") return resolveDeployment({ ...inputs, url: "/" });
  const resolved = resolveDeployment({ ...inputs, url: `${new URL(builtInDeployments()[record.environment].mcp).origin}/` });
  if (resolved.environment !== record.environment) {
    throw new OriginError(`profile "${profile}" belongs to the ${record.environment} environment, which this origin does not select`);
  }
  return resolved;
}

/** Opens and probes the keychain, then returns this profile's secrets. */
export async function profileKeychain(deps: ProfileDeps, profile: string, deployment: ResolvedDeployment): Promise<Keychain> {
  const os = await deps.openKeychain();
  await os.probe();
  return os.forScope({ profile, environment: deployment.environment });
}

/** `installs.json` (empty when missing). */
export function installRecords(deps: Pick<ProfileDeps, "dir">): InstallRecord[] {
  return readInstalls({
    read: (rel) => readPrivateFile(deps.dir, rel),
    write: () => {
      throw new Error("read only");
    },
  });
}

/** Maps a failure to its message and exit code: 2 for usage and a missing TTY, 1 otherwise. */
export function reportFailure(command: string, err: unknown, deps: Pick<ProfileDeps, "print">): number {
  if (err instanceof KeychainError) return reportKeychainError(err, (line) => deps.print(line));
  if (err instanceof TtyRequired || err instanceof UsageError) {
    deps.print(`${RUN} ${command}: ${printable(redact(err.message))}\n`);
    return EXIT_USAGE;
  }
  if (err instanceof OriginError) {
    deps.print(`${RUN} ${command}: ${printable(redact(err.message))}\n`);
    return EXIT_USAGE;
  }
  if (err instanceof LockError && err.code === "LOCK_TIMEOUT") {
    deps.print(`${LOCK_TIMEOUT_TEXT}\n`);
    return EXIT_FATAL;
  }
  if (err instanceof RefreshError) {
    deps.print(`${err.message} Try again later.\n`);
    return EXIT_FATAL;
  }
  if (err instanceof SignInError || err instanceof ApiKeyError) {
    deps.print(`${printable(redact(err.message))}\n`);
    return EXIT_FATAL;
  }
  const message = err instanceof Error ? err.message : String(err);
  deps.print(`${RUN} ${command}: ${printable(redact(message))}\n`);
  return EXIT_FATAL;
}

/**
 * A typed confirmation: the user must type `expected` (the profile name) exactly. A shell an
 * agent drives in a pseudo-terminal passes the TTY check, so a yes/no is not enough for the
 * settings that loosen a guard (`settings set ... on`, `allow-paid`).
 */
export async function typedConfirm(deps: Pick<ProfileDeps, "prompt">, question: string, expected: string): Promise<boolean> {
  const answer = await deps.prompt(`${question}\nType the profile name (${expected}) to confirm, or press Enter to cancel:`);
  return answer === expected;
}

/** The message and exit code for a confirmation the user declined: nothing changed, exit 0. */
export const DECLINED_TEXT = "Nothing changed.";

export async function promptOnTty(question: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(`${question} `)).trim();
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

async function confirmOnTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export function defaultProfileDeps(): ProfileDeps {
  const dir = configDir();
  return {
    dir,
    home: userInfo().homedir,
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
    isTTY: isInteractive(),
    print: (text) => void process.stderr.write(text),
    confirm: confirmOnTty,
    prompt: promptOnTty,
    openKeychain: openOsKeychain,
    openBrowser: (deployment, url) => openBrowser(deployment, url, { cwd: dir }),
    chain: (environment, profile) => createChainReader({ environment, profile }),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    log: silentLogger,
    clients: CLIENTS,
  };
}
