import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { silentLogger, type Logger } from "../log/logger.js";
import { pinnedFetch } from "../net/fetch.js";
import type { ResolvedDeployment } from "../profile/deployments.js";
import type { Keychain } from "../profile/keychain.js";
import { withLock, type LockHandle, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { createProfile, readProfileFor, updateProfile } from "../profile/profile.js";
import { clientIdOf, endpoint, issuerOf, postForm, readTokenAnswer, resourceOf, SCOPE, type IssuedTokens } from "./endpoints.js";
import { startLoopback, type CallbackResult } from "./loopback.js";

/**
 * F1 for the built-in client (spec §6.6 F1, §7.6, §7.14; R-MCP-5, R-MCP-18, R-MU-6, F5).
 *
 * Under the profile lock (held, and touched, for the whole sign-in):
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

export type SignInFailure = "denied" | "refused" | "failed" | "timeout" | "cancelled";

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
}

export type ExecFile = (file: string, args: readonly string[], options: { shell: false; windowsHide: true; timeout: number }, callback: (err: Error | null) => void) => unknown;

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
}

export interface SignInResult {
  /** The new credential's id, or `null` when it could not be read back (tokens are stored). */
  readonly credentialId: string | null;
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

/** The launcher for each platform: never a shell, the URL as one argument. */
export function browserCommand(platform: NodeJS.Platform, url: string): { file: string; args: string[] } {
  if (platform === "darwin") return { file: "open", args: [url] };
  if (platform === "win32") return { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { file: "xdg-open", args: [url] };
}

/**
 * Opens `url` in the browser with `execFile` (no shell). Only an `http(s)` URL on the
 * deployment's issuer or web origin is opened (R-MCP-18); anything else is refused.
 */
export function openBrowser(
  deployment: ResolvedDeployment,
  url: string,
  options: { execFile?: ExecFile; platform?: NodeJS.Platform } = {},
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
  const { file, args } = browserCommand(options.platform ?? process.platform, parsed.href);
  const run = options.execFile ?? (nodeExecFile as unknown as ExecFile);
  return new Promise((resolve) => {
    try {
      run(file, args, { shell: false, windowsHide: true, timeout: 15_000 }, (err) => resolve(err === null));
    } catch {
      resolve(false);
    }
  });
}

/**
 * The credential id of an access token: `GET {API}/agents/me/delegate` (`{data: {credentialId}}`
 * through the API envelope). `null` on any failure.
 */
export async function identifyCredential(deployment: ResolvedDeployment, accessToken: string, log: Logger = silentLogger): Promise<string | null> {
  try {
    const res = await pinnedFetch(deployment, `${deployment.api.replace(/\/+$/, "")}/agents/me/delegate`, {
      headers: { accept: "application/json" },
      bearer: accessToken,
      log,
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { data?: { credentialId?: unknown } } | null;
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
} as const;

function fail(reason: SignInFailure): SignInError {
  return new SignInError(reason, MESSAGES[reason]);
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
  return withLock(
    profile,
    async (lock) => {
      const record = readProfileFor(profile, deployment.environment);
      const wanted = options.replaces === undefined ? (record?.credentialId ?? null) : options.replaces;
      const replaces = wanted !== null && UUID_RE.test(wanted) ? wanted : null;
      const device = options.device === undefined ? deviceLabel((deps.hostname ?? osHostname)()) : options.device === null ? null : deviceLabel(options.device);

      const { verifier, challenge } = pkcePair();
      const state = b64url(randomBytes(32));
      const loopback = await startLoopback({
        state,
        signal: lock.signal,
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        ...(deps.ports !== undefined ? { ports: deps.ports } : {}),
      });
      let code: string;
      try {
        const link = authorizeUrl(deployment, { redirectUri: loopback.redirectUri, state, challenge, device, replaces });
        deps.onLink?.(link);
        const opened = await (deps.openBrowser ?? ((u: string) => openBrowser(deployment, u)))(link);
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

      lock.assertHeld();
      const answer = await exchange(deployment, lock, { code, verifier, redirectUri: loopback.redirectUri }, nowSeconds, log);
      try {
        lock.assertHeld();
        await deps.keychain.storeTokens(lock, { refreshToken: answer.refreshToken, accessToken: { token: answer.accessToken, expiresAt: answer.expiresAt } });
      } catch (err) {
        // Lost the lock between the exchange and the write: give the new grant back.
        await bestEffortRevoke(deployment, answer.refreshToken, log);
        throw err;
      }
      log.info("signed in");

      const credentialId = await identifyCredential(deployment, answer.accessToken, log);
      if (credentialId === null) {
        log.warn("signed in, but the credential id could not be read; it is read again later");
        return { credentialId: null };
      }
      lock.assertHeld();
      if (record === null) {
        createProfile(profile, lock, {
          environment: deployment.environment,
          credentialId,
          agentLabel: "agent",
          createdAt: new Date(nowSeconds() * 1000).toISOString(),
        });
      } else {
        updateProfile(profile, lock, (current) => ({ ...current, credentialId }));
      }
      log.info("credential recorded", { credential: credentialId.slice(0, 8) });
      return { credentialId };
    },
    deps.lockOptions,
  );
}

async function exchange(
  deployment: ResolvedDeployment,
  lock: LockHandle,
  input: { code: string; verifier: string; redirectUri: string },
  nowSeconds: () => number,
  log: Logger,
): Promise<IssuedTokens> {
  let res: Response;
  try {
    res = await postForm(
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
      { signal: lock.signal, log },
    );
  } catch {
    throw fail("failed");
  }
  const answer = await readTokenAnswer(res, nowSeconds());
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
