import { apiKeyFromEnv, type ResolvedDeployment } from "../profile/deployments.js";
import { hasGrant, type TokenContext } from "./tokens.js";

/**
 * API-key mode (spec §7.3, R-MCP-5): the credential comes from the environment only, never
 * from a flag or a file. `ASSAY_API_KEY` outside dev mode; in dev mode only
 * `ASSAY_DEV_API_KEY` (so a real key never reaches a dev origin). An API key binds, guards and
 * pays exactly like an OAuth grant; it is never refreshed, stored or revoked by the proxy.
 */

/** Agent keys: `assay_sk_live_` and a printable body, no whitespace. */
const API_KEY_RE = /^assay_sk_live_[A-Za-z0-9_-]{16,256}$/;

export class ApiKeyError extends Error {
  override readonly name = "ApiKeyError";
}

/** The API key from the environment, `null` when unset. A malformed value is refused. */
export function apiKey(resolved: Pick<ResolvedDeployment, "dev">, env: Readonly<Record<string, string | undefined>>): string | null {
  const value = apiKeyFromEnv(resolved, env);
  if (value === null) return null;
  if (!API_KEY_RE.test(value)) throw new ApiKeyError(`${resolved.dev ? "ASSAY_DEV_API_KEY" : "ASSAY_API_KEY"} is not an Assay agent key (assay_sk_live_…)`);
  return value;
}

export type AuthMode = "api-key" | "oauth" | "pre-sign-in";

/** Which credential the process uses: an env API key wins; else a stored grant; else none. */
export async function authMode(ctx: TokenContext, env: Readonly<Record<string, string | undefined>>): Promise<AuthMode> {
  if (apiKey(ctx.deployment, env) !== null) return "api-key";
  return (await hasGrant(ctx)) ? "oauth" : "pre-sign-in";
}
