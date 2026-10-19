import { join } from "node:path";
import type { ClientEnv } from "./client.js";
import { fileClient } from "./file-client.js";

/** VS Code's user `mcp.json`, in the default profile's user directory. */
export function vscodeUserPath(env: Pick<ClientEnv, "home" | "platform">): string {
  if (env.platform === "win32") return join(env.home, "AppData", "Roaming", "Code", "User", "mcp.json");
  if (env.platform === "darwin") return join(env.home, "Library", "Application Support", "Code", "User", "mcp.json");
  return join(env.home, ".config", "Code", "User", "mcp.json");
}

/** VS Code: user `mcp.json`, project `.vscode/mcp.json`, key `servers`, entries carry `type: "stdio"`. */
export const vscode = fileClient({
  id: "vscode",
  label: "VS Code",
  key: "servers",
  userPath: vscodeUserPath,
  projectRel: ".vscode/mcp.json",
});
