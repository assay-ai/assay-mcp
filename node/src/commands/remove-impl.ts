/**
 * `assay-mcp remove <name> [--client <id>] [--scope user|project]`: removes the client entry, then the `installs.json`
 * record. Only an entry `add` wrote (identified by its command, not its name) is removed. It does
 * not sign out.
 */
import { RUN } from "../version.js";
import { CLIENT_IDS, isClientId, type Scope } from "../clients/install-command.js";
import { forgetInstall, type InstallRecord } from "../clients/installs.js";
import { isValidName } from "../clients/server-name.js";
import { EXIT_FATAL, EXIT_OK, EXIT_USAGE } from "../exit-codes.js";
import { parseFlags, UsageError, type InstallDeps } from "./context.js";

export interface RemoveOptions {
  client?: string | undefined;
  scope?: string | undefined;
}

export async function remove(name: string, options: RemoveOptions, deps: InstallDeps): Promise<void> {
  const { client: clientId, scope } = options;
  if (!isValidName(name)) throw new UsageError(`"${name}" is not a server name`);
  if (clientId !== undefined && !isClientId(clientId)) {
    throw new UsageError(`unknown client "${clientId}". Use one of: ${CLIENT_IDS.join(", ")}`);
  }
  if (scope !== undefined && scope !== "user" && scope !== "project") throw new UsageError("--scope must be user or project");
  const matches = deps.installs
    .read()
    .filter((r) => r.name === name && (clientId === undefined || r.client === clientId) && (scope === undefined || r.scope === scope));
  if (matches.length > 1) {
    const places = matches.map((m) => `${m.client} ${m.scope}${m.scope === "project" ? ` (${m.configPath})` : ""}`).join(", ");
    const hints: string[] = [];
    if (clientId === undefined && new Set(matches.map((m) => m.client)).size > 1) hints.push("--client <id>");
    if (scope === undefined && new Set(matches.map((m) => m.scope)).size > 1) hints.push("--scope user|project");
    const hint = hints.length > 0 ? `pass ${hints.join(" and ")}` : "remove the extra ones in the app by hand";
    throw new UsageError(`"${name}" is installed in more than one place: ${places}; ${hint}`);
  }
  let record: Omit<InstallRecord, "url" | "profile">;
  if (matches[0] !== undefined) {
    record = matches[0];
  } else if (clientId !== undefined && isClientId(clientId)) {
    // Not recorded (e.g. installs.json was reset): the entry in that scope (user by default; project
    // is the current directory's), if it is ours.
    const s: Scope = scope === "project" ? "project" : "user";
    const adapter = deps.clients[clientId];
    if (!adapter.scopes.includes(s)) throw new UsageError(`${adapter.label} has no ${s} scope`);
    record = { client: clientId, scope: s, name, configPath: adapter.target(s, deps.clientEnv).configPath };
  } else {
    throw new UsageError(`no Assay server named "${name}"${scope ? ` in ${scope} scope` : ""} (see \`${RUN} list\`)`);
  }

  const client = deps.clients[record.client];
  const target = client.targetOf(record.scope, record.configPath, deps.clientEnv);
  const entries = client.entries(target, deps.clientEnv);
  if (!entries.has(name)) {
    if (matches.length === 0) throw new UsageError(`${client.label} has no server named "${name}"`);
    await forgetInstall(deps.installs, record);
    deps.print(`${name} was already gone from ${client.label} (${record.scope}); forgot it.\n`);
    return;
  }
  if (!client.isOurs(entries.get(name))) {
    throw new UsageError(
      `warning: ${client.label}'s "${name}" is not exactly the entry assay-mcp wrote (another command, an extra key such as env, or a hand edit); left unchanged. Remove it in ${client.label} if you want it gone.`,
    );
  }
  await client.uninstall(target, name, deps.clientEnv);
  if (matches.length === 1) await forgetInstall(deps.installs, record);
  deps.print(`Removed ${name} from ${client.label} (${record.scope}). This does not sign out; \`${RUN} logout\` does.\n`);
}

export async function runRemove(args: readonly string[], deps: InstallDeps): Promise<number> {
  try {
    const { values, positionals } = parseFlags(args, { client: { type: "string" }, scope: { type: "string" } }, 1);
    await remove(positionals[0]!, { client: values.client as string | undefined, scope: values.scope as string | undefined }, deps);
    return EXIT_OK;
  } catch (err) {
    deps.print(`${RUN} remove: ${(err as Error).message}\n`);
    return err instanceof UsageError ? EXIT_USAGE : EXIT_FATAL;
  }
}
