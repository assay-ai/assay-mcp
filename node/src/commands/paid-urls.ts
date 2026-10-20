/**
 * `assay-mcp allow-paid <url>` and `disallow-paid <url>` (spec §7.3, §7.7 step 5, G11,
 * R-MU-13): add or remove a canonical URL in `profiles/{profile}.paid-urls.json`.
 *
 * Terminal only, checked before anything is read or written. The URL goes through origin
 * pinning and the server URL parser (the same resolver as `add`), and is stored as its
 * canonical `path?query`, never a host, under the profile lock.
 */
import { RUN } from "../version.js";
import { EXIT_OK } from "../exit-codes.js";
import { UrlRefused, type ResolvedUrl } from "../clients/ports.js";
import { withLock } from "../profile/lock.js";
import { addPaidUrl, readExplicitPaidUrls, readPaidUrls, readProfileFor, removePaidUrl } from "../profile/profile.js";
import { requireTty } from "../tty.js";
import { parseFlags, UsageError } from "./context.js";
import { checkProfileName, DECLINED_TEXT, profileRef, reportFailure, typedConfirm, type ProfileDeps } from "./profile-context.js";
import { urlResolver } from "./wiring.js";

export type PaidUrlChange = "allow-paid" | "disallow-paid";

export async function changePaidUrl(command: PaidUrlChange, args: readonly string[], deps: ProfileDeps): Promise<number> {
  requireTty(command, deps.isTTY);
  const { values, positionals } = parseFlags(args, { profile: { type: "string" } }, 1);
  const profile = checkProfileName(values.profile as string | undefined);
  let url: ResolvedUrl;
  try {
    url = urlResolver({ dir: deps.dir, env: deps.env, print: deps.print })(positionals[0]!);
  } catch (err) {
    if (err instanceof UrlRefused) throw new UsageError(err.message);
    throw err;
  }
  const ref = profileRef(deps, profile);
  readProfileFor(ref, url.environment); // refused before any question; checked again under the lock
  // `allow-paid` counts only what a person allowed: the `{MCP}/` a profile starts with does not
  // reach project installs (R-MU-13), so allowing it asks and makes it explicit.
  const current = (): string[] => (command === "allow-paid" ? readExplicitPaidUrls(ref) : readPaidUrls(ref));
  if (command === "allow-paid" && !current().includes(url.pathAndQuery)) {
    const yes = await typedConfirm(
      deps,
      `Allow paid calls through ${url.url} for profile "${profile}"? Tools behind this URL can then spend within your local caps.`,
      profile,
    );
    if (!yes) {
      deps.print(`${DECLINED_TEXT}\n`);
      return EXIT_OK;
    }
  }
  const result = await withLock(
    ref,
    (lock) => {
      readProfileFor(ref, url.environment); // a profile of another environment is refused
      const before = current().includes(url.pathAndQuery);
      if (command === "allow-paid") addPaidUrl(ref, lock, url.pathAndQuery);
      else removePaidUrl(ref, lock, url.pathAndQuery);
      return { changed: before !== current().includes(url.pathAndQuery) };
    },
    deps.lockOptions,
  );
  if (command === "allow-paid") {
    deps.print(
      result.changed
        ? `Paid calls are allowed through ${url.url} for profile "${profile}". Local caps still apply (\`${RUN} limits\`).\n`
        : `Paid calls were already allowed through ${url.url} for profile "${profile}".\n`,
    );
  } else {
    deps.print(
      result.changed
        ? `Paid calls through ${url.url} are off for profile "${profile}". Free tools keep working.\n`
        : `Paid calls through ${url.url} were not allowed for profile "${profile}"; nothing changed.\n`,
    );
  }
  return EXIT_OK;
}

export async function runPaidUrlChange(command: PaidUrlChange, args: readonly string[], deps: ProfileDeps): Promise<number> {
  try {
    return await changePaidUrl(command, args, deps);
  } catch (err) {
    return reportFailure(command, err, deps);
  }
}
