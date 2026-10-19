import { join } from "node:path";
import { cliClient } from "./cli-client.js";
import { readConfigText } from "./config-file.js";

const HEADER = /^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;

function unquoteKey(key: string): string {
  return key.startsWith('"') ? (JSON.parse(key) as string) : key;
}

/** A TOML basic string or an array of them, as JSON; undefined for anything else. */
function parseValue(text: string): unknown {
  try {
    return JSON.parse(text.replace(/,\s*\]$/, "]"));
  } catch {
    return undefined;
  }
}

/**
 * The `[mcp_servers.<name>]` tables of a Codex `config.toml`, with `command`, `args` and whether
 * an `env` is present. A deliberately small reader: values it cannot read are left out, so an
 * entry it does not fully understand is never taken for ours.
 */
export function parseCodexServers(text: string): Map<string, unknown> {
  const servers = new Map<string, Record<string, unknown>>();
  let current: Record<string, unknown> | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const header = HEADER.exec(line);
    if (header) {
      current = {};
      servers.set(unquoteKey(header[1]!), current);
      continue;
    }
    if (ANY_HEADER.test(line)) {
      // `[mcp_servers.x.env]` and similar subtables mark the entry as not ours.
      const sub = /^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*\./.exec(line);
      const owner = sub ? servers.get(unquoteKey(sub[1]!)) : undefined;
      if (owner) owner.extra = true;
      current = null;
      continue;
    }
    if (current === null) continue;
    const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value.startsWith("[") && !value.endsWith("]")) {
      while (i + 1 < lines.length && !value.endsWith("]")) value += ` ${lines[++i]!.trim()}`;
    }
    const parsed = parseValue(value);
    if (kv[1] === "command" || kv[1] === "args") {
      if (parsed !== undefined) current[kv[1]] = parsed;
    } else {
      current[kv[1]!] = parsed ?? value;
    }
  }
  return servers;
}

/** Codex CLI: `codex mcp add`, user scope only, in `$CODEX_HOME/config.toml` (default `~/.codex`). */
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
});
