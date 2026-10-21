import { RUN } from "../version.js";
import { builtInDeployments, devModeWarning, isPlaceholder, type Deployment, type Environment } from "../deployments.js";
import { devOriginsFromEnv, normaliseOrigin } from "./dev-origins.js";
import { canonicalUrl, parseMcpAbsoluteUrl } from "./mcp-url.js";

/**
 * Which deployment a process talks to (spec §7.3, R-MCP-17).
 *
 * Every host comes from the built-in `deployments.json`. `--url` only chooses between the
 * built-in production entry and, in dev mode, a built-in dev entry; it never supplies a host
 * of its own. Profile files, project configs and server responses are not inputs here.
 */

/** Dev entries a dev origin may select, in tie-break order (e2e and anvil share an origin). */
export const DEV_SELECTABLE: readonly Environment[] = ["e2e", "staging", "anvil"];

/**
 * In dev mode only: names the dev entry when several share the dev origin (e2e and anvil both
 * use localhost:3200; the first in {@link DEV_SELECTABLE} wins without it). It can only pick
 * among the built-in entries of an origin that already passed both dev-mode gates.
 */
export const DEV_DEPLOYMENT_ENV = "ASSAY_MCP_DEV_DEPLOYMENT";

export const API_KEY_ENV = "ASSAY_API_KEY";
export const DEV_API_KEY_ENV = "ASSAY_DEV_API_KEY";

export class OriginError extends Error {
  override readonly name = "OriginError";
}

export interface ResolvedDeployment extends Deployment {
  readonly environment: Environment;
  /** True only when the origin was allowed by both the env var and `dev-origins.json`. */
  readonly dev: boolean;
  /** `--url`, canonicalised like the server. */
  readonly url: string;
}

export interface ResolveInputs {
  /** `--url`: a full URL or a path on the production MCP origin. Default `/`. */
  url?: string | undefined;
  /** The process environment (only `ASSAY_MCP_DEV_ORIGINS` is read). */
  env: Readonly<Record<string, string | undefined>>;
  /** The origins in `{dir}/dev-origins.json` (see `readDevOrigins`). */
  devOrigins: readonly string[];
  /** Where the dev-mode warning goes; stderr by default, never stdout. */
  warn?: (line: string) => void;
}

function originOf(value: string): string | null {
  return isPlaceholder(value) ? null : normaliseOrigin(new URL(value).origin);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export function resolveDeployment({ url, env, devOrigins, warn }: ResolveInputs): ResolvedDeployment {
  const table = builtInDeployments();
  const production = table.production;
  const productionOrigin = new URL(production.mcp).origin;

  const raw = (url ?? "/").trim();
  // A bare path is appended to the production origin as text, never resolved as a URL
  // reference: `//evil.example/` must stay a (refused) path, not become a host.
  const full = raw.startsWith("/") ? `${productionOrigin}${raw}` : raw;

  let parsed: URL;
  try {
    parsed = new URL(full);
  } catch {
    throw new OriginError("--url is not a URL or a path");
  }
  if (parsed.username || parsed.password) throw new OriginError("--url must not carry credentials");
  const origin = parsed.origin;

  let environment: Environment;
  let dev = false;
  if (origin === productionOrigin) {
    environment = "production";
  } else {
    const fromEnv = devOriginsFromEnv(env);
    const fromFile = devOrigins.map((o) => normaliseOrigin(o)).filter((o): o is string => o !== null);
    if (!fromEnv.includes(origin) || !fromFile.includes(origin)) {
      throw new OriginError(
        `refusing ${origin}: assay-mcp talks only to ${productionOrigin}. ` +
          `A dev origin needs both ASSAY_MCP_DEV_ORIGINS and \`${RUN} dev allow <origin>\`.`,
      );
    }
    const matches = DEV_SELECTABLE.filter((e) => originOf(table[e].mcp) === origin);
    if (matches.length === 0) throw new OriginError(`refusing ${origin}: no built-in dev deployment uses this origin`);
    const named = (env[DEV_DEPLOYMENT_ENV] ?? "").trim();
    if (named !== "" && !matches.includes(named as Environment)) {
      throw new OriginError(`refusing ${DEV_DEPLOYMENT_ENV}=${named.slice(0, 32)}: ${origin} is used by ${matches.join(", ")} only`);
    }
    environment = named !== "" ? (named as Environment) : matches[0]!;
    dev = true;
  }

  const deployment = table[environment];
  const canonical = parseMcpAbsoluteUrl(full, deployment.mcp);
  if (!canonical) throw new OriginError("--url is not an Assay MCP URL");

  if (dev) (warn ?? ((line: string) => void process.stderr.write(line)))(`assay-mcp: ${devModeWarning(environment)}\n`);

  const resolved: ResolvedDeployment = deepFreeze({
    ...structuredClone(deployment),
    environment,
    dev,
    url: canonicalUrl(new URL(deployment.mcp).origin, canonical),
  });
  RESOLVED.add(resolved);
  return resolved;
}

/**
 * The brand: every object {@link resolveDeployment} returned, and nothing else. A look-alike
 * object (`{environment: "e2e", dev: true, …}` built anywhere else) is not in it.
 */
const RESOLVED = new WeakSet<object>();

/** True only for a {@link resolveDeployment} result. */
export function isResolvedDeployment(value: unknown): value is ResolvedDeployment {
  return typeof value === "object" && value !== null && RESOLVED.has(value);
}

/**
 * The deployments `pinnedFetch` accepts: a {@link resolveDeployment} result, or the built-in
 * production entry itself (by identity). A built-in dev entry is accepted only through
 * `resolveDeployment`, i.e. only after the explicit dev-mode decision.
 */
export function isTrustedDeployment(value: unknown): value is Deployment {
  return isResolvedDeployment(value) || value === builtInDeployments().production;
}

/**
 * The gate for the signer (Task 2.2/2.9): outside dev mode only `production` may sign. The
 * e2e and anvil entries reuse the production escrow (same EIP-712 domain), so a non-production
 * environment is acceptable only when dev mode was chosen explicitly through both local
 * inputs; nothing a server returns can set `dev`.
 */
export function assertSignerEnvironment(resolved: ResolvedDeployment): void {
  if (!isResolvedDeployment(resolved)) throw new OriginError("refusing to sign: the deployment was not resolved by assay-mcp");
  const ok = resolved.dev ? resolved.environment !== "production" : resolved.environment === "production";
  if (!ok) throw new OriginError(`refusing to sign for ${resolved.environment} outside dev mode`);
}

/**
 * The API key from the environment: `ASSAY_API_KEY` outside dev mode, `ASSAY_DEV_API_KEY` in
 * dev mode (where `ASSAY_API_KEY` is ignored, so a real key is never sent to a dev origin).
 */
export function apiKeyFromEnv(resolved: Pick<ResolvedDeployment, "dev">, env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env[resolved.dev ? DEV_API_KEY_ENV : API_KEY_ENV]?.trim();
  return value ? value : null;
}
