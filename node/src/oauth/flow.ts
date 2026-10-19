import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname as osHostname, userInfo } from "node:os";
import { win32 } from "node:path";
import { silentLogger, type Logger } from "../log/logger.js";
import { pinnedFetch } from "../net/fetch.js";
import type { ResolvedDeployment } from "../profile/deployments.js";
import type { Keychain } from "../profile/keychain.js";
import { withLock, type LockHandle, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { createProfile, readProfileFor, updateProfile } from "../profile/profile.js";
import {
  clientIdOf,
  endpoint,
  issuerOf,
  postForm,
  readCapped,
  readTokenAnswer,
  REQUEST_TIMEOUT_MS,
  requestSignal,
  resourceOf,
  SCOPE,
  type IssuedTokens,
} from "./endpoints.js";
import { startLoopback, type CallbackResult } from "./loopback.js";
import { activateMarker, claimMarker, releaseMarker } from "./signin-marker.js";

/**
 * F1 for the built-in client (spec §6.6 F1, §7.6, §7.14; R-MCP-5, R-MCP-18, R-MU-6, F5).
 *
 * The profile lock is held only for short steps, never while the browser is open (Task 2.8
 * fix round 1): first to re-read the keychain (a stored grant ends the sign-in, unless
 * `force`) and claim the "sign-in in progress" marker (`signin-marker.ts`), so a second
 * process starts no browser flow of its own; then, after the callback, to re-read the keychain
 * again (a grant stored meanwhile wins and this code is dropped unexchanged, so one profile
 * never gets two grants; an explicit re-login, `force`, always completes and replaces it) and
 * exchange and store. In between:
 * 1. re-read the profile; `assay_replaces` defaults to the credential id it holds (F5);
 * 2. PKCE S256 verifier and a 256-bit `state`; the loopback listener on `127.0.0.1`;
 * 3. the authorize URL is built here from the pinned issuer (PRM `authorization_servers` and
 *    AS metadata are never read), and the browser is launched with `execFile`, no shell, on
 *    that URL only;
 * 4. the callback must carry the right `state` (the listener checks it) and
 *    `iss === deployment.issuer` (RFC 9207), else the sign-in is refused;
 * 5. the code is exchanged with the verifier; the pair is stored in the keychain (lock-aware
 *    writes) before the access token is used;
 * 6. the credential id is read back from `GET {API}/agents/me/delegate` and written to the
 *    profile. The delegate key, if any, is kept: F5 rebinds it to the new credential.
 *
 * Nothing here logs a token, the code, the verifier or `state`.
 */

export type SignInFailure = "denied" | "refused" | "failed" | "timeout" | "cancelled" | "busy";

export class SignInError extends Error {
  override readonly name = "SignInError";
  constructor(
    readonly reason: SignInFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface SignInOptions {
  /** A display-only device label; default the host name, sanitised. */
  readonly device?: string | null;
  /** The credential this sign-in replaces; default the profile's own (F5). `null`: none. */
  readonly replaces?: string | null;
  /** A link-only sign-in (startup): an active sign-in may take its marker over. */
  readonly passive?: boolean;
  /** Sign in even when a grant is stored (an explicit re-login). */
  readonly force?: boolean;
}

export interface LaunchOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly timeout: number;
  /** A fixed directory (the profile dir), never the host's cwd. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}
export type ExecFile = (file: string, args: readonly string[], options: LaunchOptions, callback: (err: Error | null) => void) => unknown;

export interface SignInDeps {
  /** The profile's secrets, through the lock-aware 2.5 API. */
  readonly keychain: Keychain;
  readonly log?: Logger;
  /** Called with the authorize URL before the browser opens (tool text, stderr). */
  readonly onLink?: (url: string) => void;
  /** Opens the browser; default {@link openBrowser}. Returns false when it could not. */
  readonly openBrowser?: (url: string) => Promise<boolean>;
  readonly hostname?: () => string;
  readonly nowSeconds?: () => number;
  /** The loopback wait; default 5 minutes. */
  readonly timeoutMs?: number;
  readonly lockOptions?: LockOptions;
  /** Loopback ports to try (tests). */
  readonly ports?: readonly number[];
  /** Per-request timeout for the exchange and the credential read; default 15 s. */
  readonly requestTimeoutMs?: number;
  /** Cancels the wait for the browser. */
  readonly signal?: AbortSignal;
  /** Receives a function that marks this (passive) sign-in active; false: it was taken over. */
  readonly onMarker?: (activate: () => Promise<boolean>) => void;
  readonly nowMs?: () => number;
  readonly pidAlive?: (pid: number) => boolean;
}

export interface SignInResult {
  /** The new credential's id, or `null` when it could not be read back (tokens are stored). */
  readonly credentialId: string | null;
  /** True when a grant was already stored (before, or by another process meanwhile): no new one was made. */
  readonly existing?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEVICE_MAX = 32;

/** The host name as a device label: printable ASCII words, at most 32 characters, or `null`. */
export function deviceLabel(raw: string): string | null {
  const cleaned = raw
    .replace(/\.(local|localdomain|lan|home)$/i, "")
    .replace(/[^A-Za-z0-9 ._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DEVICE_MAX)
    .trim();
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : null;
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");

/** RFC 7636: a 43-character verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier, "ascii").digest()) };
}

export interface AuthorizeParams {
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
  readonly device: string | null;
  readonly replaces: string | null;
}

/** The authorize URL, from built-in values only (R-MCP-18). */
export function authorizeUrl(deployment: ResolvedDeployment, p: AuthorizeParams): string {
  const url = new URL(endpoint(deployment, "authorize"));
  const q = url.searchParams;
  q.set("response_type", "code");
  q.set("client_id", clientIdOf(deployment));
  q.set("redirect_uri", p.redirectUri);
  q.set("code_challenge", p.challenge);
  q.set("code_challenge_method", "S256");
  q.set("state", p.state);
  q.set("scope", SCOPE);
  q.set("resource", resourceOf(deployment));
  if (p.device) q.set("assay_device", p.device);
  if (p.replaces) q.set("assay_replaces", p.replaces.toLowerCase());
  return url.href;
}

/** Where the launcher may live: absolute paths only, never `PATH` or the cwd (I3). */
export const POSIX_OPENERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  darwin: Object.freeze(["/usr/bin/open"]),
  linux: Object.freeze(["/usr/bin/xdg-open", "/usr/local/bin/xdg-open"]),
});
const WINDOWS_DIR_RE = /^[A-Za-z]:\\Windows$/i;
const DEFAULT_WINDOWS_DIR = "C:\\Windows";

export interface LauncherInputs {
  readonly platform: NodeJS.Platform;
  /** Only `SystemRoot` is read on Windows, and only in the form `X:\Windows`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
}

/**
 * The launcher for each platform, as an absolute path, with the URL as one argument; `null`
 * when none is installed where expected (the caller then only prints the link).
 * - macOS: `/usr/bin/open`.
 * - Windows: `{SystemRoot}\System32\rundll32.exe url.dll,FileProtocolHandler`. A project
 *   config can set env, so `SystemRoot` is trusted only as a drive's `\Windows`; otherwise
 *   `C:\Windows`.
 * - Linux and the rest: `xdg-open` from `/usr/bin` or `/usr/local/bin`.
 */
export function browserCommand(inputs: LauncherInputs, url: string): { file: string; args: string[] } | null {
  if (inputs.platform === "win32") {
    const fromEnv = inputs.env.SystemRoot ?? "";
    // The fixed location first; `SystemRoot` (never `windir`) only when that file is missing.
    const roots = WINDOWS_DIR_RE.test(fromEnv) ? [DEFAULT_WINDOWS_DIR, fromEnv] : [DEFAULT_WINDOWS_DIR];
    for (const root of roots) {
      const file = win32.join(root, "System32", "rundll32.exe");
      if (inputs.exists(file)) return { file, args: ["url.dll,FileProtocolHandler", url] };
    }
    return null;
  }
  const candidates = POSIX_OPENERS[inputs.platform] ?? POSIX_OPENERS.linux!;
  const file = candidates.find((c) => inputs.exists(c));
  return file ? { file, args: [url] } : null;
}

/** Desktop-session variables `xdg-open` needs to reach the running browser. */
const XDG_ENV_KEEP = ["HOME", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "DBUS_SESSION_BUS_ADDRESS", "LANG"];

/**
 * The launcher's environment. `xdg-open` is a shell script that runs other programs by name
 * and honours `BROWSER`, so it gets `PATH=/usr/bin:/bin` and only the desktop-session
 * variables. Elsewhere the process env is kept, without `BROWSER`.
 */
export function launcherEnv(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (platform !== "darwin" && platform !== "win32") {
    const minimal: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    for (const key of XDG_ENV_KEEP) if (typeof env[key] === "string") minimal[key] = env[key];
    return minimal;
  }
  const copy = { ...env };
  delete copy.BROWSER;
  // Windows: never search the cwd for a bare program name (as for client CLIs).
  if (platform === "win32") copy.NoDefaultCurrentDirectoryInExePath = "1";
  return copy;
}

/**
 * Opens `url` in the browser with `execFile` (no shell, an absolute launcher, a fixed cwd).
 * Only an `http(s)` URL on the deployment's issuer or web origin is opened (R-MCP-18);
 * anything else, or a missing launcher, returns false and the caller prints the link.
 */
export function openBrowser(
  deployment: ResolvedDeployment,
  url: string,
  options: { execFile?: ExecFile; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean; cwd?: string } = {},
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  const allowed = [issuerOf(deployment), deployment.web].flatMap((o) => {
    try {
      return [new URL(o).origin];
    } catch {
      return [];
    }
  });
  if (!/^https?:$/.test(parsed.protocol) || !allowed.includes(parsed.origin) || parsed.username || parsed.password) {
    return Promise.resolve(false);
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const command = browserCommand({ platform, env, exists: options.exists ?? existsSync }, parsed.href);
  if (command === null) return Promise.resolve(false);
  const run = options.execFile ?? (nodeExecFile as unknown as ExecFile);
  const launch: LaunchOptions = { shell: false, windowsHide: true, timeout: 15_000, cwd: options.cwd ?? userInfo().homedir, env: launcherEnv(platform, env) };
  return new Promise((resolve) => {
    try {
      run(command.file, command.args, launch, (err) => resolve(err === null));
    } catch {
      resolve(false);
    }
  });
}

/**
 * The credential id of an access token: `GET {API}/agents/me/delegate` (`{data: {credentialId}}`
 * through the API envelope). `null` on any failure.
 */
export async function identifyCredential(
  deployment: ResolvedDeployment,
  accessToken: string,
  log: Logger = silentLogger,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
): Promise<string | null> {
  try {
    const res = await pinnedFetch(deployment, `${deployment.api.replace(/\/+$/, "")}/agents/me/delegate`, {
      headers: { accept: "application/json" },
      bearer: accessToken,
      log,
      signal: requestSignal(options.timeoutMs ?? REQUEST_TIMEOUT_MS, options.signal),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readCapped(res);
    if (text === null) return null;
    const body = JSON.parse(text) as { data?: { credentialId?: unknown } } | null;
    const id = body?.data?.credentialId;
    return typeof id === "string" && UUID_RE.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Fixed messages: nothing from the callback or the server is echoed. */
const MESSAGES = {
  denied: "The sign-in was declined in the browser.",
  refused: "The sign-in answer did not come from Assay; it was refused.",
  failed: "The sign-in did not complete. Try again.",
  timeout: "The sign-in was not finished within 5 minutes. Try again.",
  cancelled: "The sign-in was cancelled.",
  busy: "Assay sign-in is already in progress in another window.",
} as const;

function fail(reason: SignInFailure): SignInError {
  return new SignInError(reason, MESSAGES[reason]);
}

/** The error for "another process's sign-in is pending". */
export function signInBusyError(): SignInError {
  return fail("busy");
}

/** Checks the callback (RFC 9207 `iss` first) and returns the code. */
export function codeFrom(result: CallbackResult, issuer: string): string {
  if (result.iss === null || result.iss !== issuer) throw fail("refused");
  if (result.kind === "error") throw fail(result.error === "access_denied" ? "denied" : result.error === "invalid_response" ? "refused" : "failed");
  return result.code;
}

export async function signIn(profile: ProfileRef, deployment: ResolvedDeployment, options: SignInOptions, deps: SignInDeps): Promise<SignInResult> {
  const log = (deps.log ?? silentLogger).child("oauth");
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const nowMs = deps.nowMs ?? Date.now;

  // 1. A short lock: an existing grant ends here; else claim the "sign-in in progress" marker.
  const begun = await withLock(
    profile,
    async (lock) => {
      const heldRefresh = await deps.keychain.get("refresh_token");
      if (heldRefresh !== null && options.force !== true) return { kind: "existing" as const };
      const claim = claimMarker(profile, lock, options.passive === true, nowMs(), deps.pidAlive);
      if (claim.kind === "busy") return { kind: "busy" as const };
      return { kind: "claimed" as const, token: claim.marker.token, heldRefresh, record: readProfileFor(profile, deployment.environment) };
    },
    deps.lockOptions,
  );
  if (begun.kind === "existing") return { credentialId: readProfileFor(profile, deployment.environment)?.credentialId ?? null, existing: true };
  if (begun.kind === "busy") throw fail("busy");

  const { token, heldRefresh, record } = begun;
  const dropMarker = () => releaseMarker(profile, token);
  process.on("exit", dropMarker);
  try {
    deps.onMarker?.(() => withLock(profile, (lock) => activateMarker(profile, lock, token), deps.lockOptions));
    const wanted = options.replaces === undefined ? (record?.credentialId ?? null) : options.replaces;
    const replaces = wanted !== null && UUID_RE.test(wanted) ? wanted : null;
    const device = options.device === undefined ? deviceLabel((deps.hostname ?? osHostname)()) : options.device === null ? null : deviceLabel(options.device);

    // 2. The browser flow, without the lock.
    const { verifier, challenge } = pkcePair();
    const state = b64url(randomBytes(32));
    const loopback = await startLoopback({
      state,
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.ports !== undefined ? { ports: deps.ports } : {}),
    });
    let code: string;
    try {
      const link = authorizeUrl(deployment, { redirectUri: loopback.redirectUri, state, challenge, device, replaces });
      deps.onLink?.(link);
      const opened = await (deps.openBrowser ?? ((u: string) => openBrowser(deployment, u, { cwd: profile.dir })))(link);
      if (!opened) log.warn("browser not opened; use the printed link");
      let result: CallbackResult;
      try {
        result = await loopback.result;
      } catch (err) {
        throw (err as { reason?: string }).reason === "timeout" ? fail("timeout") : fail("cancelled");
      }
      code = codeFrom(result, issuerOf(deployment));
    } finally {
      loopback.close();
    }

    // 3. Under the lock: re-read; a grant stored meanwhile wins and our code is dropped unused.
    return await withLock(
      profile,
      async (lock) => {
        const now = await deps.keychain.get("refresh_token");
        // An explicit re-login (`force`) always completes: a sibling's refresh rotating the
        // stored token meanwhile does not drop it; the new grant replaces the old one through
        // `assay_replaces` (F5).
        if (now !== null && now !== heldRefresh && options.force !== true) {
          log.info("signed in by another process; this sign-in's code is not used");
          return { credentialId: readProfileFor(profile, deployment.environment)?.credentialId ?? null, existing: true };
        }
        lock.assertHeld();
        const answer = await exchange(deployment, lock, { code, verifier, redirectUri: loopback.redirectUri }, nowSeconds, log, deps.requestTimeoutMs);
        try {
          lock.assertHeld();
          await deps.keychain.storeTokens(lock, { refreshToken: answer.refreshToken, accessToken: { token: answer.accessToken, expiresAt: answer.expiresAt } });
        } catch (err) {
          // Lost the lock between the exchange and the write: give the new grant back.
          await bestEffortRevoke(deployment, answer.refreshToken, log);
          throw err;
        }
        log.info("signed in");

        const credentialId = await identifyCredential(deployment, answer.accessToken, log, { signal: lock.signal, timeoutMs: deps.requestTimeoutMs });
        if (credentialId === null) {
          log.warn("signed in, but the credential id could not be read; it is read again later");
          return { credentialId: null };
        }
        lock.assertHeld();
        const current = readProfileFor(profile, deployment.environment);
        if (current === null) {
          createProfile(profile, lock, {
            environment: deployment.environment,
            credentialId,
            agentLabel: "agent",
            createdAt: new Date(nowSeconds() * 1000).toISOString(),
          });
        } else {
          updateProfile(profile, lock, (c) => ({ ...c, credentialId }));
        }
        log.info("credential recorded", { credential: credentialId.slice(0, 8) });
        return { credentialId };
      },
      deps.lockOptions,
    );
  } finally {
    process.off("exit", dropMarker);
    dropMarker();
  }
}

/**
 * The code exchange. Every failure (network, timeout, a reset or oversized body, a refusal) is
 * `SignInError("failed")`, except a lost lock (`LOCK_LOST`). If the AS minted the grant but
 * the answer was lost, that grant is orphaned: nothing holds a token to revoke it, and it
 * expires after 30 idle days or is revoked from Agents & keys.
 */
async function exchange(
  deployment: ResolvedDeployment,
  lock: LockHandle,
  input: { code: string; verifier: string; redirectUri: string },
  nowSeconds: () => number,
  log: Logger,
  timeoutMs: number | undefined,
): Promise<IssuedTokens> {
  let answer;
  try {
    const res = await postForm(
      deployment,
      "token",
      {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: clientIdOf(deployment),
        code_verifier: input.verifier,
        resource: resourceOf(deployment),
      },
      { signal: lock.signal, log, timeoutMs },
    );
    answer = await readTokenAnswer(res, nowSeconds());
  } catch (err) {
    lock.assertHeld();
    log.warn("code exchange failed", { error: err instanceof Error ? err.name : "error" });
    throw fail("failed");
  }
  if (!answer.ok) {
    log.warn("code exchange refused", { status: answer.status, error: answer.error });
    throw fail("failed");
  }
  return answer.tokens;
}

/** RFC 7009 revocation of a refresh token; failures are ignored (the grant expires anyway). */
export async function bestEffortRevoke(deployment: ResolvedDeployment, refreshToken: string, log: Logger = silentLogger): Promise<boolean> {
  try {
    const res = await postForm(deployment, "revoke", { token: refreshToken, token_type_hint: "refresh_token", client_id: clientIdOf(deployment) }, { log });
    await res.body?.cancel();
    return res.status === 200;
  } catch {
    return false;
  }
}
