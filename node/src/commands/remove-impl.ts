/**
 * `assay-mcp remove <name> [--client <id>]`: removes the client entry, then the `installs.json`
 * record. Only an entry `add` wrote (identified by its command, not its name) is removed. It does
 * not sign out.
 */
import { CLIENT_IDS, isClientId } from "../clients/install-command.js";
import { forgetInstall, type InstallRecord } from "../clients/installs.js";
import { isValidName } from "../clients/server-name.js";
import { EXIT_FATAL, EXIT_OK, EXIT_USAGE } from "../exit-codes.js";
import { parseFlags, UsageError, type InstallDeps } from "./context.js";

export async function remove(name: string, clientId: string | undefined, deps: InstallDeps): Promise<void> {
  if (!isValidName(name)) throw new UsageError(`"${name}" is not a server name`);
  if (clientId !== undefined && !isClientId(clientId)) {
    throw new UsageError(`unknown client "${clientId}". Use one of: ${CLIENT_IDS.join(", ")}`);
  }
  const matches = deps.installs.read().filter((r) => r.name === name && (clientId === undefined || r.client === clientId));
  if (matches.length > 1) {
    throw new UsageError(`"${name}" is installed in more than one place (${matches.map((m) => `${m.client} ${m.scope}`).join(", ")}); pass --client`);
  }
  let record: Omit<InstallRecord, "url" | "profile">;
  if (matches[0] !== undefined) {
    record = matches[0];
  } else if (clientId !== undefined && isClientId(clientId)) {
    // Not recorded (e.g. installs.json was reset): the user-scope entry, if it is ours.
    record = { client: clientId, scope: "user", name, configPath: deps.clients[clientId].target("user", deps.clientEnv).configPath };
  } else {
    throw new UsageError(`no Assay server named "${name}" (see \`assay-mcp list\`)`);
  }

  const client = deps.clients[record.client];
  const target = client.targetOf(record.scope, record.configPath, deps.clientEnv);
  const entries = client.entries(target, deps.clientEnv);
  if (!entries.has(name)) {
    if (matches.length === 0) throw new UsageError(`${client.label} has no server named "${name}"`);
    await forgetInstall(deps.installs, record);
    deps.print(`${name} was already gone from ${client.label}; forgot it.\n`);
    return;
  }
  if (!client.isOurs(entries.get(name))) {
    throw new UsageError(
      `warning: ${client.label}'s "${name}" is not exactly the entry assay-mcp wrote (another command, an extra key such as env, or a hand edit); left unchanged. Remove it in ${client.label} if you want it gone.`,
    );
  }
  await client.uninstall(target, name, deps.clientEnv);
  if (matches.length === 1) await forgetInstall(deps.installs, record);
  deps.print(`Removed ${name} from ${client.label}. You are still signed in; \`assay-mcp logout\` signs out.\n`);
}

export async function runRemove(args: readonly string[], deps: InstallDeps): Promise<number> {
  try {
    const { values, positionals } = parseFlags(args, { client: { type: "string" } }, 1);
    await remove(positionals[0]!, values.client as string | undefined, deps);
    return EXIT_OK;
  } catch (err) {
    deps.print(`assay-mcp remove: ${(err as Error).message}\n`);
    return err instanceof UsageError ? EXIT_USAGE : EXIT_FATAL;
  }
}
