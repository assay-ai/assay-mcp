/**
 * `assay-mcp logout [--profile <name>]` (spec F7, §8.3).
 *
 * Under the profile lock, in one hold:
 * 1. `POST {MCP}/oauth/revoke` with the refresh token (the access token when it is the only
 *    one stored), which ends the grant;
 * 2. delete the tokens and the delegate key from the keychain;
 * 3. delete the profile files except `limits.json` and `paid-urls.json` (the user's own
 *    choices, kept for the next sign-in);
 * 4. delete the "sign-in in progress" marker when it is ours or its process is gone. A live
 *    marker of another process is kept: that sign-in finishes or expires on its own.
 * Sibling processes then get 401 and fall back to pre-sign-in mode on their own (F7 step 4).
 * The on-chain grant of the deleted key is not touched: the user is told how to stop it.
 */
import { EXIT_OK } from "../exit-codes.js";
import { clientIdOf, postForm, REQUEST_TIMEOUT_MS } from "../oauth/endpoints.js";
import { clearDeadMarker } from "../oauth/signin-marker.js";
import { ENVIRONMENTS, type Environment } from "../deployments.js";
import type { ResolvedDeployment } from "../profile/deployments.js";
import { LockError, withLock, type LockHandle } from "../profile/lock.js";
import { deletePrivateFile, profileFile } from "../profile/paths.js";
import { readProfile } from "../profile/profile.js";
import { parseFlags } from "./context.js";
import {
  checkProfileName,
  defaultProfileDeps,
  installRecords,
  profileDeployment,
  profileRef,
  reportFailure,
  type ProfileDeps,
} from "./profile-context.js";

/** Profile files deleted by logout; `limits` and `paid-urls` are kept (F7 step 2). */
export const LOGOUT_DELETES = ["profile", "state", "settings"] as const;

/** The spec's line for two or more servers; null when `add` installed none (nothing to warn about). */
export function signsOutText(n: number): string | null {
  if (n <= 0) return null;
  if (n === 1) return "This signs out the Assay server on this computer.";
  return `This signs out all ${n} Assay servers on this computer.`;
}

export function onChainHint(web: string): string {
  return `Your payment key was deleted from this computer. To also cancel its on-chain permission, open ${web.replace(/\/+$/, "")}/agents and click Stop it (one signature).`;
}

interface Outcome {
  hadGrant: boolean;
  revoked: boolean;
  hadKey: boolean;
}

/** The profile's environment from its file, or null when the file is missing or unreadable. */
function environmentOf(deps: ProfileDeps, profile: string): Environment | null {
  try {
    return readProfile(profileRef(deps, profile))?.environment ?? null;
  } catch {
    return null;
  }
}

export async function logout(args: readonly string[], deps: ProfileDeps): Promise<number> {
  const { values } = parseFlags(args, { profile: { type: "string" } }, 0);
  const profile = checkProfileName(values.profile as string | undefined);
  const ref = profileRef(deps, profile);

  // Logout is the recovery path: when the deployment cannot be resolved (an unreadable
  // profile file, or a dev profile while dev mode is off), nothing is sent to a server, but
  // the local sign-in data is still removed. The keychain scope needs no host.
  let deployment: ResolvedDeployment | null = null;
  let localOnly: string | null = null;
  try {
    deployment = profileDeployment(deps, profile);
  } catch (err) {
    localOnly = err instanceof Error ? err.message : String(err);
  }
  const known = deployment?.environment ?? environmentOf(deps, profile);
  const environments: readonly Environment[] = known !== null ? [known] : ENVIRONMENTS;
  const os = await deps.openKeychain();
  await os.probe();
  const keychains = environments.map((environment) => os.forScope({ profile, environment }));

  let n = 0;
  try {
    n = installRecords(deps).filter((r) => r.profile === profile).length;
  } catch {
    // An unreadable installs.json does not block signing out.
  }

  /** Deletes the tokens, the payment key and the profile files except limits and paid URLs. */
  const clearLocal = async (lock: LockHandle): Promise<boolean> => {
    let hadKey = false;
    for (const keychain of keychains) {
      await keychain.delete(lock, "access_token");
      await keychain.delete(lock, "refresh_token");
      hadKey = (await keychain.delete(lock, "delegate_key")) || hadKey;
    }
    lock.assertHeld();
    for (const kind of LOGOUT_DELETES) deletePrivateFile(deps.dir, profileFile(profile, kind));
    clearDeadMarker(ref, lock);
    return hadKey;
  };

  let recordHadKey = false;
  try {
    recordHadKey = (readProfile(ref)?.delegateAddress ?? null) !== null;
  } catch {
    // unreadable: the keychain answer decides
  }

  let outcome: Outcome;
  try {
    outcome = await withLock(
      ref,
      async (lock) => {
        let token: string | null = null;
        let hint: "refresh_token" | "access_token" = "refresh_token";
        if (deployment !== null) {
          const keychain = keychains[0]!;
          const refreshToken = await keychain.get("refresh_token");
          const access = refreshToken === null ? await keychain.getAccessToken() : null;
          token = refreshToken ?? access?.token ?? null;
          if (refreshToken === null) hint = "access_token";
        } else {
          for (const keychain of keychains) if ((await keychain.get("refresh_token")) !== null) token = "";
        }
        let revoked = false;
        if (deployment !== null && token !== null && token !== "") {
          lock.assertHeld();
          try {
            const res = await postForm(
              deployment,
              "revoke",
              { token, token_type_hint: hint, client_id: clientIdOf(deployment) },
              { signal: lock.signal, log: deps.log, timeoutMs: deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS },
            );
            await res.body?.cancel().catch(() => {});
            revoked = res.status === 200;
          } catch {
            revoked = false;
          }
        }
        const hadKey = await clearLocal(lock);
        return { hadGrant: token !== null, revoked, hadKey: hadKey || recordHadKey };
      },
      deps.lockOptions,
    );
  } catch (err) {
    if (!(err instanceof LockError && err.code === "LOCK_LOST")) throw err;
    // As in Task 2.7's revoke(): the lock was lost mid-way; clear locally under a new lock.
    const hadKey = await withLock(ref, clearLocal, deps.lockOptions);
    outcome = { hadGrant: true, revoked: false, hadKey: hadKey || recordHadKey };
  }

  // Printed only after the lock work is done, so a lock or keychain failure never follows it.
  const servers = signsOutText(n);
  if (servers !== null) deps.print(`${servers}\n`);
  const web = deployment?.web.replace(/\/+$/, "") ?? null;
  if (localOnly !== null) {
    deps.print(`Signed out on this computer only (${localOnly}). Revoke the app at Agents & keys on the Assay website if it still shows.\n`);
  } else if (!outcome.hadGrant) deps.print(`Profile "${profile}" was not signed in. Local sign-in data is removed.\n`);
  else if (outcome.revoked) deps.print(`Signed out. Profile "${profile}" no longer has access to Assay.\n`);
  else {
    deps.print(`Signed out on this computer, but Assay did not confirm the sign-out. The app's access ends after 30 idle days, or revoke it now at ${web}/agents.\n`);
  }
  if (outcome.hadKey) {
    deps.print(
      web !== null
        ? `${onChainHint(web)}\n`
        : "Your payment key was deleted from this computer. To also cancel its on-chain permission, open Agents & keys on the Assay website and click Stop it (one signature).\n",
    );
  }
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
