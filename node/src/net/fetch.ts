import { isPlaceholder, type Deployment } from "../deployments.js";
import { isTrustedDeployment } from "../profile/deployments.js";
import { silentLogger, type Logger } from "../log/logger.js";
import { VERSION } from "../version.js";

/**
 * The proxy's one outbound path (R-MCP-17, spec §7.13).
 *
 * - The deployment must be a `resolveDeployment` result or the built-in production entry
 *   itself; a plain object (or a built-in dev entry without the dev-mode decision) is refused.
 * - Only the deployment's MCP, issuer, API and RPC origins are reachable. Every other
 *   origin, including `{WEB}`, is refused before any I/O.
 * - `Authorization` is attached only for the MCP and API origins, from `bearer`; a caller
 *   cannot set it through `headers`. The issuer gets it only when it is the MCP origin.
 * - Redirects are never followed (`redirect: 'error'`), whatever `init` says.
 * - `User-Agent: assay-mcp/V`.
 */

export type Target = "mcp" | "issuer" | "api" | "rpc";

export class PinnedFetchError extends Error {
  override readonly name = "PinnedFetchError";
}

export interface PinnedInit extends Omit<RequestInit, "redirect"> {
  /** The bearer credential. Sent only to the MCP and API origins, never to an RPC. */
  bearer?: string | null | undefined;
  /** Logs method, target, status and duration at debug. Never the URL, headers or body. */
  log?: Logger | undefined;
}

export const USER_AGENT = `assay-mcp/${VERSION}`;

function origin(value: string): string | null {
  if (isPlaceholder(value)) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Which of the deployment's origins `url` is on, or `null` when it is none of them. */
export function targetOf(deployment: Deployment, url: URL): Target | null {
  const o = url.origin;
  if (o === origin(deployment.mcp)) return "mcp";
  if (o === origin(deployment.issuer)) return "issuer";
  if (o === origin(deployment.api)) return "api";
  for (const network of Object.values(deployment.networks)) {
    if (network.rpc.some((r) => origin(r) === o)) return "rpc";
  }
  return null;
}

/** Whether a request to `target` may carry the bearer: the MCP and API origins only (R-MCP-17). */
export function carriesBearer(target: Target): boolean {
  return target === "mcp" || target === "api";
}

export async function pinnedFetch(deployment: Deployment, url: string | URL, init: PinnedInit = {}): Promise<Response> {
  const { bearer, log = silentLogger, ...rest } = init;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PinnedFetchError("not a URL");
  }
  if (parsed.username || parsed.password) throw new PinnedFetchError("URLs with credentials are refused");
  if (!isTrustedDeployment(deployment)) throw new PinnedFetchError("the deployment is not a built-in entry resolved by assay-mcp");
  const target = targetOf(deployment, parsed);
  if (target === null) throw new PinnedFetchError(`refusing ${parsed.origin}: not a built-in origin of this deployment`);

  const headers = new Headers(rest.headers);
  if (headers.has("authorization")) throw new PinnedFetchError("pass the credential as `bearer`, not as a header");
  if (headers.has("cookie") || headers.has("proxy-authorization")) throw new PinnedFetchError("credential headers are refused");
  if (bearer && carriesBearer(target)) headers.set("authorization", `Bearer ${bearer}`);
  headers.set("user-agent", USER_AGENT);

  const method = (rest.method ?? "GET").toUpperCase();
  const started = Date.now();
  try {
    const res = await fetch(parsed, { ...rest, headers, redirect: "error" });
    log.debug("fetch", { target, method, status: res.status, ms: Date.now() - started });
    return res;
  } catch (err) {
    log.debug("fetch failed", { target, method, ms: Date.now() - started, error: err instanceof Error ? err.name : "error" });
    throw err;
  }
}
