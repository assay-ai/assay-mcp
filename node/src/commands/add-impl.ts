/** `assay-mcp add <url|/path>` (spec 8.3, Task 2.11). */
import { RUN } from "../version.js";
import { existsSync } from "node:fs";
import type { ClientAdapter } from "../clients/client.js";
import { CLIENT_IDS, DEFAULT_PROFILE, isClientId, shellQuote, type InstallInput, type Scope } from "../clients/install-command.js";
import { chooseName } from "../clients/install-name.js";
import { recordInstall } from "../clients/installs.js";
import { UrlRefused, type ResolvedUrl } from "../clients/ports.js";
import { SIGNED_OUT_L, SIGN_IN_HINT } from "../clients/server-name.js";
import { EXIT_FATAL, EXIT_OK, EXIT_USAGE } from "../exit-codes.js";
import { parseFlags, UsageError, type InstallDeps } from "./context.js";
import { typedConfirm } from "./profile-context.js";

const API_KEY_ENV = "ASSAY_API_KEY";

export interface AddOptions {
  input: string;
  client: string | undefined;
  name: string | undefined;
  scope: Scope;
  profile: string | undefined;
  force: boolean;
  logFile: string | undefined;
}

export function parseAddArgs(args: readonly string[]): AddOptions {
  const { values, positionals } = parseFlags(
    args,
    {
      client: { type: "string" },
      name: { type: "string" },
      scope: { type: "string" },
      profile: { type: "string" },
      force: { type: "boolean" },
      "log-file": { type: "string" },
    },
    1,
  );
  const scope = (values.scope as string | undefined) ?? "user";
  if (scope !== "user" && scope !== "project") throw new UsageError(`--scope must be user or project`);
  return {
    input: positionals[0]!,
    client: values.client as string | undefined,
    name: values.name as string | undefined,
    scope,
    profile: values.profile as string | undefined,
    force: values.force === true,
    logFile: values["log-file"] as string | undefined,
  };
}

/** `--client`, else the only client CLI on PATH, else a choice on the TTY, else a usage error listing the ids. */
export async function pickClient(requested: string | undefined, deps: InstallDeps): Promise<ClientAdapter> {
  if (requested !== undefined) {
    if (!isClientId(requested)) throw new UsageError(`unknown client "${requested}". Use one of: ${CLIENT_IDS.join(", ")}`);
    return deps.clients[requested];
  }
  const onPath = CLIENT_IDS.filter((id) => {
    const bin = deps.clients[id].bin;
    return bin !== undefined && deps.onPath(bin);
  });
  if (onPath.length === 1) return deps.clients[onPath[0]!];
  if (deps.isTTY) {
    const choice = await deps.ask("Which app should use this Assay server?", CLIENT_IDS);
    if (choice !== null && isClientId(choice)) return deps.clients[choice];
  }
  throw new UsageError(`choose an app with --client: ${CLIENT_IDS.join(", ")}`);
}

function checkOrigin(url: ResolvedUrl, scope: Scope, deps: InstallDeps): void {
  const origin = new URL(url.url).origin;
  const production = new URL(deps.productionOrigin).origin;
  if (origin === production && !url.dev) return;
  if (scope === "project") throw new UsageError("a project config can only name the built-in Assay origin, never a dev origin");
  if (!url.dev) throw new UsageError(`${origin} is not the Assay MCP origin`);
}

function allowHint(url: ResolvedUrl): string {
  return `Run \`${RUN} allow-paid ${shellQuote(url.url)}\` in a terminal to allow paid calls through it.`;
}

export async function add(options: AddOptions, deps: InstallDeps): Promise<void> {
  const profile = options.profile ?? DEFAULT_PROFILE;
  if (!deps.profiles.isValidName(profile)) throw new UsageError(`invalid profile name "${profile}"`);
  if (options.scope === "project") {
    // R-MU-4, R-MU-5, spec 7.3: a project config is shared with everyone who opens the project.
    if (options.logFile !== undefined) throw new UsageError("--scope project does not take --log-file");
    if (deps.env[API_KEY_ENV] !== undefined) throw new UsageError(`--scope project refuses to run while ${API_KEY_ENV} is set`);
    if (options.profile !== undefined && !deps.profiles.exists(profile)) {
      throw new UsageError(`--scope project needs an existing profile; "${profile}" has not signed in on this computer`);
    }
  }

  let url: ResolvedUrl;
  try {
    url = deps.resolveUrl(options.input);
  } catch (err) {
    if (err instanceof UrlRefused) throw new UsageError(err.message);
    throw err;
  }
  checkOrigin(url, options.scope, deps);

  const client = await pickClient(options.client, deps);
  if (!client.scopes.includes(options.scope)) throw new UsageError(`${client.label} has no ${options.scope} scope`);
  const target = client.target(options.scope, deps.clientEnv);

  const taken = [...client.entries(target, deps.clientEnv).keys()];

  // Idempotent: the same URL for the same profile already installed in this client and scope
  // (and still in its config) is reported, not installed again under another name.
  const existing = deps.installs
    .read()
    .find((r) => r.client === client.id && r.scope === options.scope && r.url === url.url && r.profile === profile && r.configPath === target.configPath && taken.includes(r.name));
  // `--force` always installs again.
  if (existing !== undefined && !options.force && (options.name === undefined || options.name === existing.name)) {
    deps.print(`${existing.name} → ${url.url} is already installed in ${client.label}. Nothing changed. Pass a new --name to add a second entry.\n`);
    if (options.scope === "user" && !deps.profiles.isPaidUrl(profile, url)) deps.print(`${allowHint(url)}\n`);
    return;
  }

  const measured = await deps.profiles.longestTool(profile, url);
  const L = measured ?? SIGNED_OUT_L;
  // `--force` on an existing install without `--name` replaces that entry rather than adding `-2`.
  const typed = options.name ?? (options.force ? existing?.name : undefined);
  const choice = chooseName({ scope: options.scope, L, slugWords: url.slugWords, taken, ...(typed !== undefined ? { typed } : {}) });
  if (!choice.ok) throw new UsageError(`${choice.message}${measured === null ? ` ${SIGN_IN_HINT}` : ""}`);
  const name = choice.name;
  if (options.name !== undefined && taken.includes(name) && !options.force) {
    throw new UsageError(`${client.label} already has a server named "${name}"; pass --force to replace it`);
  }

  const input: InstallInput = { V: deps.version, url: url.url, name };
  if (options.profile !== undefined) input.profile = profile;
  if (options.logFile !== undefined) input.logFile = options.logFile;

  const hadFile = existsSync(target.configPath);
  await client.install(target, input, { force: options.force }, deps.clientEnv);
  // Recorded right after the write, so `list` and `remove` always see what was installed.
  await recordInstall(deps.installs, { client: client.id, scope: options.scope, name, url: url.url, profile, configPath: target.configPath });

  const hint = allowHint(url);
  if (options.scope === "user" && deps.isTTY) {
    // The same typed confirmation as `allow-paid`: an agent driving a pseudo-terminal passes the TTY check.
    if (!deps.profiles.isPaidUrl(profile, url)) {
      const yes = await typedConfirm(
        deps,
        `Allow paid calls through ${url.url} for profile "${profile}"? Tools behind this URL can then spend within your local caps.`,
        profile,
      );
      if (!yes) {
        deps.print(`This install did not allow paid calls for ${url.url}. ${hint}\n`);
      } else {
        try {
          await deps.profiles.addPaidUrl(profile, url);
        } catch (err) {
          deps.print(`Could not allow paid calls for ${url.url} (${(err as Error).message}). ${hint}\n`);
        }
      }
    }
  } else if (options.scope === "user") {
    deps.print(`This install did not allow paid calls for ${url.url}. ${hint}\n`);
  } else {
    deps.print(`A project install never allows paid calls by itself. ${hint}\n`);
  }
  if (options.scope === "project" && client.kind === "file" && hadFile) {
    deps.print(`The previous ${target.configPath} is saved as ${target.configPath}.bak; do not commit it.\n`);
  }
  deps.print(`Added ${name} → ${url.url}. Restart ${client.label} if it is open.\n`);
}

/** Runs `add` and maps failures to exit codes: 2 for usage and refusals of the input, 1 otherwise. */
export async function runAdd(args: readonly string[], deps: InstallDeps): Promise<number> {
  try {
    await add(parseAddArgs(args), deps);
    return EXIT_OK;
  } catch (err) {
    deps.print(`${RUN} add: ${(err as Error).message}\n`);
    return err instanceof UsageError ? EXIT_USAGE : EXIT_FATAL;
  }
}
