/**
 * The real dependencies of `add`, `list` and `remove`, bound to the URL parser and origin
 * pinning, the private `{dir}` files, and the profile store and lock.
 *
 * `longestTool` (Task 2.12) measures L(u) through `tools/list` on the URL with the profile's
 * token (or the env API key); when signed out or on any failure it is null, which keeps the
 * signed-out L of 48, the safe side.
 */
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { execFileRunner, which, type CliRunner } from "../clients/client.js";
import { installsStore, type InstallsLock } from "../clients/installs.js";
import { UrlRefused, slugWordsFor, type PrivateFiles, type ProfilePort, type UrlResolver } from "../clients/ports.js";
import { CLIENTS } from "../clients/registry.js";
import { builtInDeployments } from "../deployments.js";
import { apiKey } from "../oauth/api-key.js";
import { currentAccess } from "../oauth/tokens.js";
import { OriginError, resolveDeployment } from "../profile/deployments.js";
import { openOsKeychain, type OsKeychain } from "../profile/keychain.js";
import { readDevOrigins } from "../profile/dev-origins.js";
import { withLock, type ProfileRef } from "../profile/lock.js";
import { parseMcpAbsoluteUrl } from "../profile/mcp-url.js";
import { configDir, isValidProfileName, readPrivateFile, writePrivateFile } from "../profile/paths.js";
import { addPaidUrl, paidUrlKey, readProfile, readProfileFor } from "../profile/profile.js";
import { VERSION } from "../version.js";
import type { InstallDeps } from "./context.js";
import { measureLongestTool } from "./measure-tools.js";

/**
 * `installs.json` is shared by every profile, so it has its own lock: the profile lock protocol
 * (spec 8.4) on the name `installs`. A profile of that name only shares the mutual exclusion.
 */
export const INSTALLS_LOCK_NAME = "installs";

/** True when `bin` resolves to an executable in an absolute `PATH` directory (nothing is run). */
export function onPath(bin: string, pathEnv = process.env.PATH ?? "", platform = process.platform): boolean {
  return which(bin, pathEnv, platform) !== null;
}

async function ask(question: string, choices: readonly string[]): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const list = choices.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
    const answer = (await rl.question(`${question}\n${list}\nNumber: `)).trim();
    const n = Number(answer);
    return Number.isInteger(n) && n >= 1 && n <= choices.length ? choices[n - 1]! : null;
  } finally {
    rl.close();
  }
}

export interface WiringInputs {
  /** `{dir}`. */
  dir: string;
  /** The OS account's home directory (client configs live under it). */
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  run: CliRunner;
  isTTY: boolean;
  print(text: string): void;
  ask(question: string, choices: readonly string[]): Promise<string | null>;
  onPath(bin: string): boolean;
  /** L(u) with the profile's token; null (the signed-out 48) when not given. */
  longestTool?: ProfilePort["longestTool"];
}

/**
 * L(u) from `tools/list` on the URL, authenticated like `serve` would be: the env API key
 * (`ASSAY_API_KEY`, or `ASSAY_DEV_API_KEY` in dev mode), else the profile's OAuth token
 * (refreshed under the lock if needed). Null when signed out or on any failure.
 */
export function tokenLongestTool(w: {
  dir: string;
  env: Readonly<Record<string, string | undefined>>;
  openKeychain: () => Promise<OsKeychain>;
  timeoutMs?: number;
}): ProfilePort["longestTool"] {
  return async (profile, url) => {
    try {
      const deployment = resolveDeployment({ url: url.url, env: w.env, devOrigins: readDevOrigins(w.dir), warn: () => {} });
      let bearer = apiKey(deployment, w.env);
      if (bearer === null) {
        const os = await w.openKeychain();
        await os.probe();
        const keychain = os.forScope({ profile, environment: deployment.environment });
        bearer = await currentAccess({ profile: { dir: w.dir, name: profile }, deployment, keychain });
      }
      if (bearer === null) return null;
      return await measureLongestTool(deployment, deployment.url, bearer, w.timeoutMs !== undefined ? { timeoutMs: w.timeoutMs } : {});
    } catch {
      return null;
    }
  };
}

/** `<url|/path>` → the canonical URL, through origin pinning (dev mode included) and the server URL parser. */
export function urlResolver(w: Pick<WiringInputs, "dir" | "env" | "print">): UrlResolver {
  return (input) => {
    let resolved;
    try {
      resolved = resolveDeployment({ url: input, env: w.env, devOrigins: readDevOrigins(w.dir), warn: w.print });
    } catch (err) {
      if (err instanceof OriginError) throw new UrlRefused(err.message);
      throw err;
    }
    const parsed = parseMcpAbsoluteUrl(resolved.url, resolved.mcp);
    if (parsed === null) throw new UrlRefused("--url is not an Assay MCP URL");
    return {
      url: resolved.url,
      pathAndQuery: paidUrlKey(resolved),
      kind: parsed.path.kind,
      slugWords: slugWordsFor(parsed.path, parsed.filter),
      dev: resolved.dev,
      environment: resolved.environment,
    };
  };
}

export function wiredDeps(w: WiringInputs): InstallDeps {
  const resolveUrl = urlResolver(w);

  const ref = (name: string): ProfileRef => ({ dir: w.dir, name });

  const profiles: ProfilePort = {
    isValidName: isValidProfileName,
    exists: (name) => readProfile(ref(name)) !== null,
    addPaidUrl: async (name, url) => {
      await withLock(ref(name), (lock) => {
        readProfileFor(ref(name), url.environment);
        addPaidUrl(ref(name), lock, url.pathAndQuery);
      });
    },
    longestTool: w.longestTool ?? (() => Promise.resolve(null)),
  };

  const files: PrivateFiles = {
    read: (rel) => readPrivateFile(w.dir, rel),
    write: (rel, data) => writePrivateFile(w.dir, rel, data),
  };
  const lock: InstallsLock = (fn) => withLock(ref(INSTALLS_LOCK_NAME), (l) => fn(() => l.assertHeld()));

  return {
    clients: CLIENTS,
    clientEnv: { home: w.home, platform: w.platform, cwd: w.cwd, env: w.env, run: w.run },
    resolveUrl,
    profiles,
    installs: installsStore(files, lock),
    env: w.env,
    isTTY: w.isTTY,
    onPath: w.onPath,
    ask: w.ask,
    print: w.print,
    version: VERSION,
    productionOrigin: builtInDeployments().production.mcp,
  };
}

export function defaultDeps(): InstallDeps {
  const dir = configDir();
  return wiredDeps({
    dir,
    home: userInfo().homedir,
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
    run: execFileRunner,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    print: (text) => void process.stderr.write(text),
    ask,
    onPath: (bin) => onPath(bin),
    longestTool: tokenLongestTool({ dir, env: process.env, openKeychain: openOsKeychain }),
  });
}
