import { join } from "node:path";
import { cliClient } from "./cli-client.js";
import { ClientError } from "./client.js";
import { readJsonDoc } from "./config-file.js";

/** Servers under a JSON object's `mcpServers` key. */
export function readMcpServers(configPath: string): Map<string, unknown> {
  const servers = readJsonDoc(configPath).data.mcpServers;
  if (servers === undefined) return new Map();
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new ClientError(`${configPath}: "mcpServers" is not an object`);
  }
  return new Map(Object.entries(servers));
}

/**
 * Claude Code: `claude mcp add --scope user|project`. User scope lives in `~/.claude.json`
 * (`$CLAUDE_CONFIG_DIR/.claude.json` when set), project scope in `.mcp.json`.
 */
export const claudeCode = cliClient({
  id: "claude-code",
  label: "Claude Code",
  bin: "claude",
  userPath: (env) => join(env.env.CLAUDE_CONFIG_DIR || env.home, ".claude.json"),
  projectRel: ".mcp.json",
  read: readMcpServers,
  removeArgv: (name, scope) => ["mcp", "remove", "--scope", scope, name],
});
