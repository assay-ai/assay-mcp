/**
 * `assay-mcp logout [--profile <name>]` (spec F7, §8.3).
 *
 * Under the profile lock, in one hold:
 * 1. `POST {MCP}/oauth/revoke` with the refresh token (the access token when it is the only
 *    one stored), which ends the grant;
 * 2. delete the tokens and the delegate key from the keychain;
 * 3. delete the profile files except `limits.json` and `paid-urls.json` (the user's own
 *    choices, kept for the next sign-in).
 * Sibling processes then get 401 and fall back to pre-sign-in mode on their own (F7 step 4).
 * The on-chain grant of the deleted key is not touched: the user is told how to stop it.
 */
import { EXIT_OK } from "../exit-codes.js";
import { clientIdOf, postForm, REQUEST_TIMEOUT_MS } from "../oauth/endpoints.js";
import { withLock } from "../profile/lock.js";
import { deletePrivateFile, profileFile } from "../profile/paths.js";
import { readProfile } from "../profile/profile.js";
import { parseFlags } from "./context.js";
import {
  checkProfileName,
  defaultProfileDeps,
  installRecords,
  profileDeployment,
  profileKeychain,
  profileRef,
  reportFailure,
  type ProfileDeps,
} from "./profile-context.js";

/** Profile files deleted by logout; `limits` and `paid-urls` are kept (F7 step 2). */
export const LOGOUT_DELETES = ["profile", "state", "settings"] as const;

export function signsOutText(n: number): string {
  return `This signs out all ${n} Assay servers on this computer.`;
}

export function onChainHint(web: string): string {
  return `Your payment key was deleted from this computer. To also cancel its on-chain permission, open ${web.replace(/\/+$/, "")}/agents and click Stop it (one signature).`;
}

export async function logout(args: readonly string[], deps: ProfileDeps): Promise<number> {
  const { values } = parseFlags(args, { profile: { type: "string" } }, 0);
  const profile = checkProfileName(values.profile as string | undefined);
  const deployment = profileDeployment(deps, profile);
  const keychain = await profileKeychain(deps, profile, deployment);
  const ref = profileRef(deps, profile);

  let n = 0;
  try {
    n = installRecords(deps).filter((r) => r.profile === profile).length;
  } catch {
    // An unreadable installs.json does not block signing out.
  }
  deps.print(`${signsOutText(n)}\n`);

  const outcome = await withLock(
    ref,
    async (lock) => {
      const record = readProfile(ref);
      const refreshToken = await keychain.get("refresh_token");
      const access = refreshToken === null ? await keychain.getAccessToken() : null;
      const token = refreshToken ?? access?.token ?? null;
      let revoked = false;
      if (token !== null) {
        lock.assertHeld();
        try {
          const res = await postForm(
            deployment,
            "revoke",
            { token, token_type_hint: refreshToken !== null ? "refresh_token" : "access_token", client_id: clientIdOf(deployment) },
            { signal: lock.signal, log: deps.log, timeoutMs: deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS },
          );
          await res.body?.cancel().catch(() => {});
          revoked = res.status === 200;
        } catch {
          revoked = false;
        }
      }
      await keychain.delete(lock, "access_token");
      await keychain.delete(lock, "refresh_token");
      const hadKey = await keychain.delete(lock, "delegate_key");
      lock.assertHeld();
      for (const kind of LOGOUT_DELETES) deletePrivateFile(deps.dir, profileFile(profile, kind));
      return { hadGrant: token !== null, revoked, hadKey: hadKey || (record?.delegateAddress ?? null) !== null };
    },
    deps.lockOptions,
  );

  if (!outcome.hadGrant) deps.print(`Profile "${profile}" was not signed in. Local sign-in data is removed.\n`);
  else if (outcome.revoked) deps.print(`Signed out. Profile "${profile}" no longer has access to Assay.\n`);
  else {
    deps.print(
      `Signed out on this computer, but Assay did not confirm the sign-out. The app's access ends after 30 idle days, or revoke it now at ${deployment.web.replace(/\/+$/, "")}/agents.\n`,
    );
  }
  if (outcome.hadKey) deps.print(`${onChainHint(deployment.web)}\n`);
  return EXIT_OK;
}

export async function runLogout(args: readonly string[], deps: ProfileDeps): Promise<number> {
  try {
    return await logout(args, deps);
  } catch (err) {
    return reportFailure("logout", err, deps);
  }
}

/** `assay-mcp logout`. */
export function run(args: readonly string[]): Promise<number> {
  return runLogout(args, defaultProfileDeps());
}
