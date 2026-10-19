import { join } from "node:path";
import type { ClientEnv } from "./client.js";
import { fileClient } from "./file-client.js";

export function claudeDesktopPath(env: Pick<ClientEnv, "home" | "platform">): string {
  if (env.platform === "win32") return join(env.home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  if (env.platform === "darwin") return join(env.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return join(env.home, ".config", "Claude", "claude_desktop_config.json");
}

/** Claude Desktop: `claude_desktop_config.json`, key `mcpServers`. No project scope. */
export const claudeDesktop = fileClient({
  id: "claude-desktop",
  label: "Claude Desktop",
  key: "mcpServers",
  userPath: claudeDesktopPath,
});
