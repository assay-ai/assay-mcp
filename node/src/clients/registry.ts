import { claudeCode } from "./claude-code.js";
import { claudeDesktop } from "./claude-desktop.js";
import type { ClientAdapter } from "./client.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import { gemini } from "./gemini.js";
import type { ClientId } from "./install-command.js";
import { vscode } from "./vscode.js";
import { windsurf } from "./windsurf.js";

export const CLIENTS: Readonly<Record<ClientId, ClientAdapter>> = Object.freeze({
  "claude-code": claudeCode,
  codex,
  cursor,
  vscode,
  windsurf,
  gemini,
  "claude-desktop": claudeDesktop,
});
