/**
 * `assay-mcp login [--profile <name>] [--url <url|/path>]`: F1 from a terminal.
 *
 * The sign-in is Task 2.7/2.8 `signIn` with `force`: an explicit login always completes, and
 * replaces a stored grant through `assay_replaces`; the link is printed to stderr
 * before the browser opens, so it can be copied when no browser opens. `--url` only selects
 * the deployment (dev mode, same rules as `serve`); it defaults to the profile's own.
 */
import { EXIT_OK } from "../exit-codes.js";
import { signIn } from "../oauth/flow.js";
import { hasGrant } from "../oauth/tokens.js";
import { readProfile } from "../profile/profile.js";
import { parseFlags } from "./context.js";
import {
  checkProfileName,
  defaultProfileDeps,
  profileDeployment,
  profileKeychain,
  profileRef,
  reportFailure,
  type ProfileDeps,
} from "./profile-context.js";

export async function login(args: readonly string[], deps: ProfileDeps): Promise<number> {
  const { values } = parseFlags(args, { profile: { type: "string" }, url: { type: "string" } }, 0);
  const profile = checkProfileName(values.profile as string | undefined);
  const deployment = profileDeployment(deps, profile, values.url as string | undefined);
  const keychain = await profileKeychain(deps, profile, deployment);
  const ref = profileRef(deps, profile);

  // An explicit login always completes a fresh sign-in; a grant already stored is replaced
  // through `assay_replaces` (F5), even if another process refreshes it meanwhile.
  if (await hasGrant({ profile: ref, deployment, keychain })) {
    const id = readProfile(ref)?.credentialId;
    deps.print(`Signing in again; this replaces the current sign-in${id ? ` (credential ${id.slice(0, 8)})` : ""}.\n`);
  }

  const result = await signIn(ref, deployment, { force: true }, {
    keychain,
    log: deps.log,
    onLink: (link) => deps.print(`Approve in your browser: ${link}\n`),
    openBrowser: deps.signIn?.openBrowser ?? ((url) => deps.openBrowser(deployment, url)),
    nowSeconds: deps.nowSeconds,
    ...(deps.lockOptions ? { lockOptions: deps.lockOptions } : {}),
    ...(deps.signIn?.ports ? { ports: deps.signIn.ports } : {}),
    ...(deps.signIn?.timeoutMs !== undefined ? { timeoutMs: deps.signIn.timeoutMs } : {}),
    ...(deps.signIn?.hostname ? { hostname: deps.signIn.hostname } : {}),
    ...(deps.signIn?.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.signIn.requestTimeoutMs } : {}),
  });
  deps.print(
    result.credentialId !== null
      ? `Signed in (credential ${result.credentialId.slice(0, 8)}).\n`
      : "Signed in. The credential id could not be read yet; Assay servers read it on their next call.\n",
  );
  return EXIT_OK;
}

export async function runLogin(args: readonly string[], deps: ProfileDeps): Promise<number> {
  try {
    return await login(args, deps);
  } catch (err) {
    return reportFailure("login", err, deps);
  }
}

/** `assay-mcp login`. */
export function run(args: readonly string[]): Promise<number> {
  return runLogin(args, defaultProfileDeps());
}
