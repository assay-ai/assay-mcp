import { join } from "node:path";
import { parse } from "smol-toml";
import { cliClient } from "./cli-client.js";
import { ClientError } from "./client.js";
import { readConfigText } from "./config-file.js";
import { isExactAssayEntry } from "./install-command.js";

/**
 * The `mcp_servers` table of a Codex `config.toml`, read with a full TOML parser, so a name
 * written in any valid form (dotted keys, quoted keys, inline tables) is seen. A file that does
 * not parse, or whose `mcp_servers` is not a table, is refused: `add` and `remove` stop and
 * `list` shows it as unreadable.
 */
export function parseCodexServers(text: string): Map<string, unknown> {
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new ClientError(`config.toml is not valid TOML (${(err as Error).message.split("\n")[0]})`);
  }
  const servers = doc.mcp_servers;
  if (servers === undefined) return new Map();
  if (typeof servers !== "object" || servers === null || Array.isArray(servers) || servers instanceof Date) {
    throw new ClientError(`config.toml: "mcp_servers" is not a table`);
  }
  return new Map(Object.entries(servers));
}

/**
 * Codex CLI: `codex mcp add`, user scope only, in `$CODEX_HOME/config.toml` (default `~/.codex`).
 * An entry is ours only when it is exactly `{command, args}` as `add` writes it: any other key
 * (an `env` table included) keeps it.
 */
export const codex = cliClient({
  id: "codex",
  label: "Codex CLI",
  bin: "codex",
  userPath: (env) => join(env.env.CODEX_HOME || join(env.home, ".codex"), "config.toml"),
  read: (configPath) => {
    const text = readConfigText(configPath);
    return text === null ? new Map() : parseCodexServers(text);
  },
  removeArgv: (name) => ["mcp", "remove", name],
  isOurs: (entry) => isExactAssayEntry(entry, ["command", "args"]),
});
