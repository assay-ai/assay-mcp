/**
 * What every MCP client adapter offers `add`, `list` and `remove`. File clients edit their JSON
 * config through `config-file.ts`; CLI clients run the client's own `mcp add`/`mcp remove`
 * through `execFile` (never a shell) and are only read directly.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";
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

/** The absolute `cmd.exe`: `C:\\Windows\\System32` first, else `SystemRoot` only in the form `X:\\Windows` (as for the browser launcher). */
export function windowsCmdExe(env: Readonly<Record<string, string | undefined>>, exists: (path: string) => boolean = existsSync): string | null {
  const fixed = "C:\\Windows\\System32\\cmd.exe";
  if (exists(fixed)) return fixed;
  const root = env.SystemRoot ?? "";
  if (/^[A-Za-z]:\\Windows$/.test(root)) {
    const candidate = win32.join(root, "System32", "cmd.exe");
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Characters a `cmd.exe` argument may hold inside double quotes. Inside quotes `&|<>()` are
 * literal; `"` would end the quote, `%` and `!` expand variables, `^` escapes, and control
 * characters end the line, so all of those are refused (never escaped).
 */
const CMD_SAFE_ARG = /^[A-Za-z0-9 _\-.,:/\\@=+?&#~()]*$/;

export interface Invocation {
  file: string;
  args: string[];
  /** Windows only: pass `args` as written (the quoting below is already final). */
  windowsVerbatimArguments: boolean;
}

/**
 * How to run the resolved binary `path` with `argv`, without a shell and never through `PATH`
 * or the working directory:
 * - POSIX and Windows `.exe`: the absolute file itself, `execFile` quoting.
 * - Windows `.cmd`/`.bat` shims (npm installs `claude.cmd`, `codex.cmd`, `gemini.cmd`), which
 *   Node refuses to start without a shell (CVE-2024-27980): the absolute `cmd.exe` with
 *   `/d /s /c "…"` (no AutoRun, verbatim line), every word double-quoted, and any word with a
 *   character outside {@link CMD_SAFE_ARG} refused.
 * - Anything else on Windows is refused.
 */
export function invocationFor(
  path: string,
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (path: string) => boolean = existsSync,
): Invocation {
  if (platform !== "win32") return { file: path, args: [...argv], windowsVerbatimArguments: false };
  if (!win32.isAbsolute(path)) throw new ClientError(`${path} is not an absolute path`);
  const ext = win32.extname(path).toLowerCase();
  if (ext === ".exe") return { file: path, args: [...argv], windowsVerbatimArguments: false };
  if (ext !== ".cmd" && ext !== ".bat") throw new ClientError(`${path} is not a program assay-mcp can start (.exe or .cmd)`);
  const cmd = windowsCmdExe(env, exists);
  if (cmd === null) throw new ClientError("cmd.exe was not found in the Windows system directory");
  for (const word of [path, ...argv]) {
    if (!CMD_SAFE_ARG.test(word) || word.endsWith("\\")) throw new ClientError(`refusing to pass "${word}" through cmd.exe`);
  }
  const line = [path, ...argv].map((w) => `"${w}"`).join(" ");
  return { file: cmd, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * The default runner: the binary resolved to an absolute path first ({@link which}), then
 * `execFile` without a shell (a `.cmd` shim through the absolute `cmd.exe`, see
 * {@link invocationFor}), output captured (never written to stdout).
 */
export const execFileRunner: CliRunner = (bin, argv, { cwd }) =>
  new Promise((resolve, reject) => {
    const path = which(bin);
    if (path === null) {
      reject(new ClientError(`${bin} was not found on PATH`));
      return;
    }
    let inv: Invocation;
    try {
      inv = invocationFor(path, argv);
    } catch (err) {
      reject(err);
      return;
    }
    execFile(
      inv.file,
      inv.args,
      { cwd, shell: false, timeout: CLI_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: inv.windowsVerbatimArguments },
      (error, stdout, stderr) => {
        if (error) {
          const output = `${String(stderr)}${String(stdout)}`.trim().slice(0, 2000);
          reject(new ClientError(`${bin} ${argv.slice(0, 2).join(" ")} failed${output ? `: ${output}` : ""}`));
        } else {
          resolve();
        }
      },
    );
  });
