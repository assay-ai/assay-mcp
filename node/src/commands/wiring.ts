/**
 * The real dependencies of `add`, `list` and `remove`.
 *
 * WIRING (when Tasks 2.4 and 2.5 merge): the three `notWired` ports below fail closed until then.
 * - `resolveUrl`: Task 2.4 `resolveDeployment` (origin pinning, dev mode) + `parseMcpAbsoluteUrl`
 *   / `parseMcpUrl` (path form) + `canonicalUrl`; `slugWords` from `slugWordsFor(parsed.path,
 *   parsed.filter)`; `dev` from the resolved deployment. Any refusal throws `UrlRefused`.
 * - `files`: Task 2.4 `readPrivateFile(configDir(), rel)` / `writePrivateFile(configDir(), rel, data)`.
 * - `profiles`: `isValidName` = 2.4 `isValidProfileName`; `exists` = 2.5 `readProfile(...) !== null`;
 *   `addPaidUrl` = 2.5 `addPaidUrl(ref, lock, url.pathAndQuery)` under the profile lock;
 *   `longestTool` = `longestTool({mode: "full", tools})` over `tools/list` with the profile's
 *   token once the proxy can do it (null keeps the signed-out L of 48, the safe side).
 */
import { accessSync, constants } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { execFileRunner } from "../clients/client.js";
import type { PrivateFiles, ProfilePort, UrlResolver } from "../clients/ports.js";
import { CLIENTS } from "../clients/registry.js";
import { builtInDeployments } from "../deployments.js";
import { VERSION } from "../version.js";
import type { InstallDeps } from "./context.js";

class NotWired extends Error {
  override readonly name = "NotWired";
}

function notWired(what: string): never {
  throw new NotWired(`${what} is not available in this build yet`);
}

const resolveUrl: UrlResolver = () => notWired("MCP URL parsing");

const files: PrivateFiles = {
  read: () => notWired("the assay-mcp config directory"),
  write: () => notWired("the assay-mcp config directory"),
};

/** Must match Task 2.4's `isValidProfileName`; replace with that import when wiring. */
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

const profiles: ProfilePort = {
  isValidName: (name) => PROFILE_NAME.test(name),
  exists: () => notWired("the profile store"),
  addPaidUrl: () => notWired("the profile store"),
  longestTool: () => Promise.resolve(null),
};

/** True when `bin` is an executable file in a `PATH` directory (no shell, nothing run). */
export function onPath(bin: string, pathEnv = process.env.PATH ?? "", platform = process.platform): boolean {
  const names = platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
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

export function defaultDeps(): InstallDeps {
  return {
    clients: CLIENTS,
    clientEnv: { home: userInfo().homedir, platform: process.platform, cwd: process.cwd(), env: process.env, run: execFileRunner },
    resolveUrl,
    profiles,
    files,
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    onPath: (bin) => onPath(bin),
    ask,
    print: (text) => process.stderr.write(text),
    version: VERSION,
    productionOrigin: builtInDeployments().production.mcp,
  };
}
