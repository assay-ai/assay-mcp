import { join } from "node:path";
import { fileClient } from "./file-client.js";

/**
 * Windsurf (Devin Desktop): `~/.config/devin/mcp_config.json`, key `mcpServers` (spec 7.12, S13).
 * No project scope.
 */
export const windsurf = fileClient({
  id: "windsurf",
  label: "Windsurf",
  key: "mcpServers",
  userPath: (env) => join(env.home, ".config", "devin", "mcp_config.json"),
});
