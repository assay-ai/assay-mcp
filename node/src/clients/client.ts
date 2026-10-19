/**
 * What every MCP client adapter offers `add`, `list` and `remove`. File clients edit their JSON
 * config through `config-file.ts`; CLI clients run the client's own `mcp add`/`mcp remove`
 * through `execFile` (never a shell) and are only read directly.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ClientId, InstallInput, Scope } from "./install-command.js";

/** Where one install lives: its scope and absolute config path (and project root, for project scope). */
export interface Target {
  scope: Scope;
  configPath: string;
  projectRoot: string | null;
}

/** Runs a client CLI. Rejects on a non-zero exit, with the output in the message. */
export type CliRunner = (bin: string, argv: readonly string[], options: { cwd: string }) => Promise<void>;

export interface ClientEnv {
  /** The OS account's home directory. */
  home: string;
  platform: NodeJS.Platform;
  /** The project root for project scope (the working directory). */
  cwd: string;
  /** Only the client's own config-dir variables are read (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). */
  env: Readonly<Record<string, string | undefined>>;
  run: CliRunner;
}

export interface ClientAdapter {
  id: ClientId;
  label: string;
  kind: "cli" | "file";
  /** The CLI on `PATH` that identifies this client, for CLI clients. */
  bin?: string;
  scopes: readonly Scope[];
  /** The config this scope writes to. Project scope checks containment in `env.cwd`. */
  target(scope: Scope, env: ClientEnv): Target;
  /** The target an `installs.json` record points at, rechecked. */
  targetOf(scope: Scope, configPath: string, env: ClientEnv): Target;
  /** Server entries by name in that config (empty when the file does not exist). */
  entries(target: Target, env: ClientEnv): Map<string, unknown>;
  /** Adds (or with `force`, replaces) the entry. The caller has already checked the name. */
  install(target: Target, input: InstallInput, options: { force: boolean }, env: ClientEnv): Promise<void>;
  /**
   * True only for an entry exactly as `assay-mcp add` writes it for this client. `remove` and
   * `uninstall` touch nothing else.
   */
  isOurs(entry: unknown): boolean;
  /** Removes the entry, after re-checking on its own read that it is still ours. */
  uninstall(target: Target, name: string, env: ClientEnv): Promise<void>;
}

export class ClientError extends Error {
  override readonly name = "ClientError";
}

const CLI_TIMEOUT_MS = 60_000;

/**
 * The absolute path of `bin` in an absolute `PATH` directory, or null. Empty and relative
 * entries are skipped, so a binary planted in a (project) working directory is never run.
 */
export function which(bin: string, pathEnv: string = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform): string | null {
  const names = platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin];
  for (const dir of pathEnv.split(platform === "win32" ? ";" : delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of names) {
      const path = join(dir, name);
      try {
        accessSync(path, constants.X_OK);
        if (statSync(path).isFile()) return path;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * The default runner: the binary resolved to an absolute path first ({@link which}), then
 * `execFile` without a shell, output captured (never written to stdout).
 */
export const execFileRunner: CliRunner = (bin, argv, { cwd }) =>
  new Promise((resolve, reject) => {
    const path = which(bin);
    if (path === null) {
      reject(new ClientError(`${bin} was not found on PATH`));
      return;
    }
    execFile(path, [...argv], { cwd, shell: false, timeout: CLI_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const output = `${String(stderr)}${String(stdout)}`.trim().slice(0, 2000);
        reject(new ClientError(`${bin} ${argv.slice(0, 2).join(" ")} failed${output ? `: ${output}` : ""}`));
      } else {
        resolve();
      }
    });
  });
