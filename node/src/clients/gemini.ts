import { join } from "node:path";
import { cliClient } from "./cli-client.js";
import { readMcpServers } from "./claude-code.js";

/** Gemini CLI: `gemini mcp add --scope user|project`; `~/.gemini/settings.json` or `.gemini/settings.json`. */
export const gemini = cliClient({
  id: "gemini",
  label: "Gemini CLI",
  bin: "gemini",
  userPath: (env) => join(env.home, ".gemini", "settings.json"),
  projectRel: ".gemini/settings.json",
  read: readMcpServers,
  removeArgv: (name, scope) => ["mcp", "remove", "--scope", scope, name],
});
