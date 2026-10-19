import { join } from "node:path";
import { fileClient } from "./file-client.js";

/** Cursor: `~/.cursor/mcp.json`, project `.cursor/mcp.json`, key `mcpServers`. */
export const cursor = fileClient({
  id: "cursor",
  label: "Cursor",
  key: "mcpServers",
  userPath: (env) => join(env.home, ".cursor", "mcp.json"),
  projectRel: ".cursor/mcp.json",
});
