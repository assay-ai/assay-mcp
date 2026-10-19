import { silentLogger, type Logger } from "../log/logger.js";
import type { ResolvedDeployment } from "../profile/deployments.js";
import type { Keychain } from "../profile/keychain.js";
import { withLock, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { clientIdOf, postForm, readTokenAnswer } from "./endpoints.js";

/**
 * Access tokens, refresh and revoke (spec §6.6 F2, §7.6 "401", §7.15, §8.4; R-MU-1, R-MU-6, R-MU-8).
 *
 * Refresh runs only under the profile lock, following `lock.ts`:
 * - re-read the keychain after taking the lock; if the stored access token differs from the
 *   one that failed and is unexpired, another process already refreshed: use it;
 * - `assertHeld()` immediately before the request, and `lock.signal` on the request itself;
 * - an answer that arrives after the lock was lost is dropped (nothing stored, nothing used),
 *   so two token generations are never stored; the server's 30 s grace covers the next run;
 * - the new pair is stored (lock-aware writes) before the access token is returned;
 * - `invalid_grant` means the grant was revoked, expired or reused: the tokens are deleted if
 *   the keychain still holds the refresh token that was sent; the delegate key and the profile
 *   (its credential id, for `assay_replaces`) are kept, and the process is signed out.
 * Any other failure (network, 429, 5xx, 503 `temporarily_unavailable`) keeps the tokens.
 */

/** Refresh this long before the access token expires. */
export const EXPIRY_SKEW_SECONDS = 60;

export interface TokenContext {
  readonly profile: ProfileRef;
  readonly deployment: ResolvedDeployment;
  /** The profile's secrets, through the lock-aware 2.5 API. */
  readonly keychain: Keychain;
  readonly log?: Logger;
  readonly nowSeconds?: () => number;
  readonly lockOptions?: LockOptions;
}

/** A refresh that failed for a reason that keeps the tokens (retry later). */
export class RefreshError extends Error {
  override readonly name = "RefreshError";
  constructor(readonly status: number | null) {
    super("Can't reach Assay to renew the sign-in right now.");
  }
}

const now = (ctx: TokenContext) => (ctx.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();

function usable(expiresAt: number, nowSeconds: number): boolean {
  return expiresAt - EXPIRY_SKEW_SECONDS > nowSeconds;
}

/** Whether the profile holds an OAuth grant (a refresh token); without one it is signed out. */
export async function hasGrant(ctx: TokenContext): Promise<boolean> {
  return (await ctx.keychain.get("refresh_token")) !== null;
}

/**
 * The access token to send: the stored one while it is usable, else a refreshed one.
 * `null` means signed out (pre-sign-in mode). Throws `RefreshError` (keep tokens, retry) or
 * `LockError` (`LOCK_TIMEOUT`: a sign-in or refresh runs elsewhere; `LOCK_LOST`).
 */
export async function currentAccess(ctx: TokenContext): Promise<string | null> {
  const stored = await ctx.keychain.getAccessToken();
  if (stored !== null && usable(stored.expiresAt, now(ctx))) return stored.token;
  if (!(await hasGrant(ctx))) return null;
  return refreshUnderLock(ctx, stored?.token ?? null);
}

/**
 * After `failedToken` got a 401 (or expired): returns a fresh access token, or `null` when
 * the grant is gone (signed out).
 */
export async function refreshUnderLock(ctx: TokenContext, failedToken: string | null): Promise<string | null> {
  const log = (ctx.log ?? silentLogger).child("oauth");
  const { keychain, deployment } = ctx;
  return withLock(
    ctx.profile,
    async (lock) => {
      const stored = await keychain.getAccessToken();
      if (stored !== null && stored.token !== failedToken && usable(stored.expiresAt, now(ctx))) return stored.token;
      const refreshToken = await keychain.get("refresh_token");
      if (refreshToken === null) return null;

      lock.assertHeld();
      let res: Response;
      try {
        res = await postForm(deployment, "token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientIdOf(deployment) }, { signal: lock.signal, log });
      } catch (err) {
        lock.assertHeld(); // an abort because the lock was lost surfaces as LOCK_LOST
        log.warn("refresh failed", { error: err instanceof Error ? err.name : "error" });
        throw new RefreshError(null);
      }
      const answer = await readTokenAnswer(res, now(ctx));
      // A late answer (the lock was lost while waiting) is dropped here: nothing is stored.
      lock.assertHeld();
      if (answer.ok) {
        const { accessToken, refreshToken: next, expiresAt } = answer.tokens;
        await keychain.storeTokens(lock, { refreshToken: next, accessToken: { token: accessToken, expiresAt } });
        log.info("token refreshed");
        return accessToken;
      }
      if (answer.error === "invalid_grant") {
        await keychain.deleteTokensIfRefreshIs(lock, refreshToken);
        log.warn("sign-in ended by the server; sign in again", { status: answer.status });
        return null;
      }
      log.warn("refresh refused", { status: answer.status, error: answer.error });
      throw new RefreshError(answer.status);
    },
    ctx.lockOptions,
  );
}

/**
 * Signs this profile out of its grant: `POST {MCP}/oauth/revoke` with the refresh token (the
 * grant and all its tokens end, §6.3.12), then the local tokens are deleted. The delegate key
 * and the profile files are the caller's (logout, F7). Returns whether the server answered 200;
 * the local tokens are deleted either way.
 */
export async function revoke(ctx: TokenContext): Promise<{ revoked: boolean }> {
  const log = (ctx.log ?? silentLogger).child("oauth");
  const { keychain, deployment } = ctx;
  return withLock(
    ctx.profile,
    async (lock) => {
      const refreshToken = await keychain.get("refresh_token");
      let revoked = false;
      if (refreshToken !== null) {
        lock.assertHeld();
        try {
          const res = await postForm(deployment, "revoke", { token: refreshToken, token_type_hint: "refresh_token", client_id: clientIdOf(deployment) }, { signal: lock.signal, log });
          await res.body?.cancel();
          revoked = res.status === 200;
          if (!revoked) log.warn("revoke not confirmed", { status: res.status });
        } catch (err) {
          log.warn("revoke failed", { error: err instanceof Error ? err.name : "error" });
        }
      }
      await keychain.delete(lock, "access_token");
      await keychain.delete(lock, "refresh_token");
      return { revoked };
    },
    ctx.lockOptions,
  );
}
