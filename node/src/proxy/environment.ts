import { RUN } from "../version.js";
import type { ProfileRef } from "../profile/lock.js";
import { readSettings } from "../profile/settings.js";

/**
 * Environment checks at `serve` start (ruling 2.4-N1, spec §11 T13).
 *
 * A project `.mcp.json` can set the proxy's environment, so:
 * - `NODE_TLS_REJECT_UNAUTHORIZED=0` (certificate checks off) is refused, always;
 * - an env HTTP proxy (`NODE_USE_ENV_PROXY`, `--use-env-proxy`, `HTTPS_PROXY`, `HTTP_PROXY`,
 *   lowercase forms included) is refused unless the user opted in through the 0600 profile
 *   file `profiles/{profile}.settings.json` (`{"version":1,"allowEnvProxy":true}`), written
 *   only by `assay-mcp settings set --allow-env-proxy on` on a TTY, never through env;
 * - `NODE_EXTRA_CA_CERTS` gets a warning.
 * `NODE_OPTIONS=--require` runs before any proxy code: it is the MCP client's approval
 * boundary (accepted risk, §11 T13).
 */

export const PROXY_ENV_VARS = ["NODE_USE_ENV_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

export interface EnvironmentVerdict {
  /** Refusal texts: the process must not start when any is present. */
  readonly refusals: string[];
  readonly warnings: string[];
}

export interface ProfileSettings {
  readonly allowEnvProxy: boolean;
}

/**
 * The profile's settings file, through the one parser `settings set` and `settings` use
 * (`profile/settings.ts` `readSettings`, review R1-N2). Missing, unreadable, loose (not 0600,
 * wrong owner, symlink) or malformed reads as "nothing allowed": the check fails closed.
 */
export function readProfileSettings(profile: ProfileRef): ProfileSettings {
  try {
    return { allowEnvProxy: readSettings(profile).allowEnvProxy };
  } catch {
    return { allowEnvProxy: false };
  }
}

function set(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

export function checkEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  execArgv: readonly string[],
  settings: () => ProfileSettings,
  profileName: string,
): EnvironmentVerdict {
  const refusals: string[] = [];
  const warnings: string[] = [];
  if (env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === "0") {
    refusals.push("NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks; assay-mcp refuses to run with it. Remove it from this server's environment.");
  }
  const proxyVars: string[] = PROXY_ENV_VARS.filter((name) => set(env[name]));
  const optionWords = (env.NODE_OPTIONS ?? "").split(/\s+/);
  if (optionWords.includes("--use-env-proxy") || execArgv.includes("--use-env-proxy")) proxyVars.push("--use-env-proxy");
  if (proxyVars.length > 0 && !settings().allowEnvProxy) {
    refusals.push(
      `${proxyVars.join(", ")} would send Assay traffic through an HTTP proxy from the environment; assay-mcp refuses to. ` +
        `To allow it for this profile, run in a terminal: ${RUN} settings set --allow-env-proxy on${profileName === "default" ? "" : ` --profile ${profileName}`}`,
    );
  }
  if (set(env.NODE_EXTRA_CA_CERTS)) {
    warnings.push("NODE_EXTRA_CA_CERTS is set: extra certificate authorities are trusted for Assay traffic. Remove it unless you added it yourself.");
  }
  return { refusals, warnings };
}
