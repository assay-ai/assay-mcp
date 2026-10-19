/**
 * `assay-mcp enable-paid [--profile <name>]`: prints and opens the "Enable paid calls" link
 * (spec §7.7 step 6, F4 step 5):
 * `{WEB}/agents/enable-paid?credential={credentialId}#key={address}`.
 *
 * The link is built only from the built-in `{WEB}`, a UUID-checked credential id and the
 * profile's checked delegate address (R-MCP-18), and the browser is launched without a shell.
 * The key itself is made and bound on the first paid call (F4 steps 2-3), never here.
 */
import { RUN } from "../version.js";
import { isPlaceholder } from "../deployments.js";
import { EXIT_FATAL, EXIT_OK } from "../exit-codes.js";
import { fingerprint } from "../profile/fingerprint.js";
import { readProfileFor } from "../profile/profile.js";
import { parseFlags } from "./context.js";
import { checkProfileName, defaultProfileDeps, profileDeployment, profileRef, reportFailure, type ProfileDeps } from "./profile-context.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The enable-paid link, or null when an input is not what it must be. */
export function enablePaidLink(web: string, credentialId: string, address: string): string | null {
  if (isPlaceholder(web) || !UUID_RE.test(credentialId) || !ADDRESS_RE.test(address)) return null;
  let base: URL;
  try {
    base = new URL(web);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  return `${base.origin}/agents/enable-paid?credential=${credentialId.toLowerCase()}#key=${address}`;
}

export async function enablePaid(args: readonly string[], deps: ProfileDeps): Promise<number> {
  const { values } = parseFlags(args, { profile: { type: "string" } }, 0);
  const profile = checkProfileName(values.profile as string | undefined);
  const deployment = profileDeployment(deps, profile);
  const record = readProfileFor(profileRef(deps, profile), deployment.environment);
  if (record === null) {
    deps.print(`This profile is not signed in. Run \`${RUN} login\` first.\n`);
    return EXIT_FATAL;
  }
  if (record.delegateAddress === null) {
    deps.print("This computer has no payment key for this profile yet. Ask your app to use a paid tool once: assay-mcp makes the key then and shows this link.\n");
    return EXIT_FATAL;
  }
  const link = enablePaidLink(deployment.web, record.credentialId, record.delegateAddress);
  if (link === null) {
    deps.print("This build has no usable web address or the profile's credential id is not known yet; try again after the next call.\n");
    return EXIT_FATAL;
  }
  deps.print(`Open ${link} to turn on paid calls. The page must show this payment key: ${fingerprint(record.delegateAddress)}.\n`);
  const opened = await deps.openBrowser(deployment, link);
  if (!opened) deps.print("Could not open a browser; open the link above yourself.\n");
  return EXIT_OK;
}

export async function runEnablePaid(args: readonly string[], deps: ProfileDeps): Promise<number> {
  try {
    return await enablePaid(args, deps);
  } catch (err) {
    return reportFailure("enable-paid", err, deps);
  }
}

/** `assay-mcp enable-paid`. */
export function run(args: readonly string[]): Promise<number> {
  return runEnablePaid(args, defaultProfileDeps());
}
