import type { Deployment } from "../deployments.js";
import type { Logger } from "../log/logger.js";
import { pinnedFetch } from "../net/fetch.js";

/**
 * The Assay authorization server as the proxy sees it (spec §6.3).
 *
 * Every endpoint is built from the built-in deployment: the issuer is pinned, and neither the
 * PRM `authorization_servers` nor the AS metadata is read (a server answer can never move the
 * proxy to another AS). All requests go through `pinnedFetch` (built-in origins only,
 * `redirect: 'error'`), never carry `Authorization`, and are never logged with their bodies.
 */

export const CLIENT_PATH = "/oauth/clients/assay-mcp";
export const SCOPE = "assay:agent offline_access";

const trim = (url: string) => url.replace(/\/+$/, "");

/** The pinned issuer, compared byte for byte with `iss` (RFC 9207). */
export function issuerOf(deployment: Deployment): string {
  return trim(deployment.issuer);
}

/** The built-in client id, `{MCP}/oauth/clients/assay-mcp` (§6.3.6). */
export function clientIdOf(deployment: Deployment): string {
  return `${trim(deployment.mcp)}${CLIENT_PATH}`;
}

/** The RFC 8707 resource: `{MCP}`, the audience of every Assay grant (§6.3.13). */
export function resourceOf(deployment: Deployment): string {
  return trim(deployment.mcp);
}

export function endpoint(deployment: Deployment, name: "authorize" | "token" | "revoke"): string {
  return `${issuerOf(deployment)}/oauth/${name}`;
}

/** A token pair the AS returned, with the access token's expiry in Unix seconds. */
export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

/** How a token request ended. `error` is an RFC 6749 §5.2 code (or `server_error`). */
export type TokenAnswer =
  | { readonly ok: true; readonly tokens: IssuedTokens }
  | { readonly ok: false; readonly status: number; readonly error: string };

const ACCESS_RE = /^assay_at_[A-Za-z0-9_-]{20,256}$/;
const REFRESH_RE = /^assay_rt_[A-Za-z0-9_-]{20,256}$/;
const ERROR_RE = /^[a-z_]{1,64}$/;
const MAX_BODY = 16 * 1024;

/** Parses a token endpoint answer. A 200 that is not a well-formed pair is a `server_error`. */
export async function readTokenAnswer(res: Response, nowSeconds: number): Promise<TokenAnswer> {
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  if (text.length <= MAX_BODY) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  if (res.status === 200 && body !== null) {
    const { access_token: at, refresh_token: rt, token_type: type, expires_in: expiresIn } = body;
    if (
      typeof at === "string" &&
      ACCESS_RE.test(at) &&
      typeof rt === "string" &&
      REFRESH_RE.test(rt) &&
      typeof type === "string" &&
      type.toLowerCase() === "bearer" &&
      typeof expiresIn === "number" &&
      Number.isSafeInteger(expiresIn) &&
      expiresIn > 0 &&
      expiresIn <= 86_400
    ) {
      return { ok: true, tokens: { accessToken: at, refreshToken: rt, expiresAt: nowSeconds + expiresIn } };
    }
    return { ok: false, status: res.status, error: "server_error" };
  }
  const error = body && typeof body.error === "string" && ERROR_RE.test(body.error) ? body.error : "server_error";
  return { ok: false, status: res.status, error };
}

/** `POST` a form to an AS endpoint on the pinned issuer. */
export function postForm(
  deployment: Deployment,
  name: "token" | "revoke",
  form: Record<string, string>,
  options: { signal?: AbortSignal | undefined; log?: Logger | undefined } = {},
): Promise<Response> {
  return pinnedFetch(deployment, endpoint(deployment, name), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: options.signal ?? null,
    log: options.log,
  });
}
