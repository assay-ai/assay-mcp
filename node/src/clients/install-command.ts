/**
 * The single source of the spec 7.12 install commands, links and config entries. The Connect UI
 * (frontend) and the README are tested against `vectors/commands.json`, which this module
 * reproduces exactly (R-MU-9, R-WEB-7).
 *
 * Nothing here ever carries a secret or an `env` entry: an entry is only the `npx` command, the
 * exactly pinned package, and the URL arguments.
 */
import { builtInDeployments } from "../deployments.js";
import { isValidName } from "./server-name.js";

/** Client ids, in `CONNECT_CLIENTS` order (spec 7.10 item 5), local clients only. */
export const CLIENT_IDS = ["claude-code", "codex", "cursor", "vscode", "windsurf", "gemini", "claude-desktop"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

export type Scope = "user" | "project";

export const PACKAGE_NAME = "@goassay-ai/mcp";
export const DEFAULT_PROFILE = "default";

/** An exact version: no range, no tag (R-MCP-14). */
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;
/** Characters a canonical MCP URL can hold; anything else is refused before it reaches a config file. */
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#@!$&()*+,;=%]+$/;
/** Profile names become file names (spec 8; the profile store owns the authoritative rule). */
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Words a POSIX shell (and zsh) passes through unquoted. */
const SHELL_SAFE = /^[A-Za-z0-9_\-./:@,=+%]+$/;

export class InstallInputError extends Error {
  override readonly name = "InstallInputError";
}

export interface InstallInput {
  /** The package version, pinned exactly. */
  V: string;
  /** The canonical absolute MCP URL (already checked against the built-in origin). */
  url: string;
  /** The server name (spec 8.3.1). */
  name: string;
  /** Only written when it is not `default`. */
  profile?: string;
  /** User scope only: an absolute `.log` path passed through as `--log-file`. */
  logFile?: string;
}

/** A stdio entry exactly as a client stores it. */
export interface StdioEntry {
  command: "npx";
  args: string[];
}

export interface VscodeEntry extends StdioEntry {
  type: "stdio";
}

function hasControlOrQuote(text: string): boolean {
  return [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f || ch === "'" || ch === '"');
}

function checkUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InstallInputError("the URL is not absolute");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new InstallInputError("the URL is not http(s)");
  if (parsed.username || parsed.password || parsed.hash) throw new InstallInputError("the URL has credentials or a fragment");
  if (!URL_CHARS.test(url)) throw new InstallInputError("the URL has characters a canonical URL never has");
  return parsed;
}

function check(input: InstallInput, scope: Scope): URL {
  if (!EXACT_VERSION.test(input.V)) throw new InstallInputError(`"${input.V}" is not an exact version`);
  if (!isValidName(input.name)) throw new InstallInputError("invalid server name");
  if (input.profile !== undefined && !PROFILE_NAME.test(input.profile)) throw new InstallInputError("invalid profile name");
  if (input.logFile !== undefined) {
    if (scope === "project") throw new InstallInputError("a project config never names a log file");
    if (!/^(\/|[A-Za-z]:\\)/.test(input.logFile) || !input.logFile.endsWith(".log") || hasControlOrQuote(input.logFile)) {
      throw new InstallInputError("--log-file must be an absolute path ending in .log");
    }
  }
  return checkUrl(input.url);
}

/**
 * True for the production `{MCP}/` with no query: `{url-args}` is then `--name {name}` only, because
 * the package defaults to it. A dev origin's `/` keeps `--url`, or the install would reach production.
 */
export function isRootUrl(url: string): boolean {
  const u = checkUrl(url);
  return u.origin === new URL(builtInDeployments().production.mcp).origin && u.pathname === "/" && u.search === "" && !url.endsWith("?");
}

export function pinnedPackage(V: string): string {
  if (!EXACT_VERSION.test(V)) throw new InstallInputError(`"${V}" is not an exact version`);
  return `${PACKAGE_NAME}@${V}`;
}

/**
 * The arguments after `npx`.
 * - User scope (spec 7.12): `-y @goassay-ai/mcp@V {url-args}`, plus `--profile` when not default.
 * - Project scope (R-MU-4): only the pinned package, `--url` and `--profile`. No name, no log file.
 */
export function serverArgs(input: InstallInput, scope: Scope = "user"): string[] {
  check(input, scope);
  const args = ["-y", pinnedPackage(input.V)];
  const profile = input.profile !== undefined && input.profile !== DEFAULT_PROFILE ? ["--profile", input.profile] : [];
  if (scope === "project") return [...args, "--url", input.url, ...profile];
  if (!isRootUrl(input.url)) args.push("--url", input.url);
  args.push("--name", input.name, ...profile);
  if (input.logFile !== undefined) args.push("--log-file", input.logFile);
  return args;
}

/** The entry that lands in the client's config under the server name (R-MU-9 compares these). */
export function serverEntry(client: ClientId, input: InstallInput, scope: Scope = "user"): StdioEntry | VscodeEntry {
  const args = serverArgs(input, scope);
  return client === "vscode" ? { type: "stdio", command: "npx", args } : { command: "npx", args };
}

/** Quotes one word for a POSIX shell, only when it needs it. */
export function shellQuote(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function shellLine(words: readonly string[]): string {
  return words.map(shellQuote).join(" ");
}

/** The program and arguments a CLI client is run with (through `execFile`, never a shell). */
export interface CliInvocation {
  bin: "claude" | "codex" | "gemini";
  argv: string[];
}

/**
 * The CLI invocation for `claude-code`, `codex` and `gemini`: in user scope exactly the spec 7.12
 * command (Gemini passes `--scope user`, since its `mcp add` defaults to project scope).
 */
export function cliInvocation(client: ClientId, input: InstallInput, scope: Scope = "user"): CliInvocation {
  const npx = ["npx", ...serverArgs(input, scope)];
  switch (client) {
    case "claude-code":
      return { bin: "claude", argv: ["mcp", "add", "--scope", scope, input.name, "--", ...npx] };
    case "codex":
      if (scope !== "user") throw new InstallInputError("Codex has no project scope");
      return { bin: "codex", argv: ["mcp", "add", input.name, "--", ...npx] };
    case "gemini":
      return { bin: "gemini", argv: ["mcp", "add", "--scope", scope, input.name, ...npx] };
    default:
      throw new InstallInputError(`${client} is not a CLI client`);
  }
}

/** `{"mcpServers": {name: {command, args}}}`: the manual config for Cursor, Windsurf and Claude Desktop. */
function mcpServersConfig(input: InstallInput): { mcpServers: Record<string, StdioEntry> } {
  return { mcpServers: { [input.name]: { command: "npx", args: serverArgs(input) } } };
}

function vscodeConfig(input: InstallInput): { name: string } & VscodeEntry {
  return { name: input.name, type: "stdio", command: "npx", args: serverArgs(input) };
}

/**
 * The spec 7.12 paid-capable install, user scope: a shell command for the CLI clients and
 * VS Code, the config object for the file clients.
 */
export function installCommand(client: ClientId, input: InstallInput): string | object {
  switch (client) {
    case "claude-code":
      return shellLine(["claude", "mcp", "add", "--scope", "user", input.name, "--", "npx", ...serverArgs(input)]);
    case "codex":
      return shellLine(["codex", "mcp", "add", input.name, "--", "npx", ...serverArgs(input)]);
    case "gemini":
      return shellLine(["gemini", "mcp", "add", "--scope", "user", input.name, "npx", ...serverArgs(input)]);
    case "vscode":
      return `code --add-mcp ${shellQuote(JSON.stringify(vscodeConfig(input)))}`;
    case "cursor":
    case "windsurf":
    case "claude-desktop":
      return mcpServersConfig(input);
  }
}

/** The one-click install link (Cursor and VS Code), or null. */
export function installLink(client: ClientId, input: InstallInput): string | null {
  if (client === "cursor") {
    const config = Buffer.from(JSON.stringify({ command: "npx", args: serverArgs(input) }), "utf8").toString("base64");
    return `cursor://anysphere.cursor-deeplink/mcp/install?name=${input.name}&config=${encodeURIComponent(config)}`;
  }
  if (client === "vscode") return `vscode:mcp/install?${encodeURIComponent(JSON.stringify(vscodeConfig(input)))}`;
  return null;
}

/** The free-only remote alternative (spec 7.12), or null where it is a settings screen. */
export function remoteCommand(client: ClientId, input: Pick<InstallInput, "url" | "name">): string | object | null {
  checkUrl(input.url);
  if (!isValidName(input.name)) throw new InstallInputError("invalid server name");
  switch (client) {
    case "claude-code":
      return shellLine(["claude", "mcp", "add", "--transport", "http", "--scope", "user", input.name, input.url]);
    case "codex":
      return shellLine(["codex", "mcp", "add", input.name, "--url", input.url]);
    case "gemini":
      return shellLine(["gemini", "mcp", "add", "--transport", "http", "--scope", "user", input.name, input.url]);
    case "cursor":
      return { mcpServers: { [input.name]: { url: input.url } } };
    case "vscode":
      return { name: input.name, type: "http", url: input.url };
    case "windsurf":
      return { mcpServers: { [input.name]: { serverUrl: input.url } } };
    case "claude-desktop":
      return null;
  }
}

/** `npx -y @goassay-ai/mcp@V add {url} --client {id}` (spec 7.12, 8.3). `url` may be a path. */
export function addCommand(client: ClientId, input: { V: string; url: string }): string {
  if (input.url.startsWith("/")) {
    if (!URL_CHARS.test(input.url)) throw new InstallInputError("invalid path");
  } else {
    checkUrl(input.url);
  }
  return shellLine(["npx", "-y", pinnedPackage(input.V), "add", input.url, "--client", client]);
}

/** Keys a client may store for a stdio entry written without env (Claude Code adds `type` and an empty `env`). */
const ENTRY_KEYS = new Set(["command", "args", "type", "env"]);
const OUR_FLAGS_WITH_VALUE =new Set(["--url", "--name", "--profile", "--log-file"]);

/**
 * True when a config entry is one `assay-mcp add` writes: `npx -y @goassay-ai/mcp@<exact>` followed
 * only by our own flags, each with a value, and no `env`. `remove` touches nothing else.
 */
export function isAssayEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  if (!Object.keys(e).every((k) => ENTRY_KEYS.has(k))) return false;
  if (e.command !== "npx" || !Array.isArray(e.args)) return false;
  if (e.type !== undefined && e.type !== "stdio") return false;
  if (e.env !== undefined && !(typeof e.env === "object" && e.env !== null && Object.keys(e.env).length === 0)) return false;
  const args = e.args as unknown[];
  if (!args.every((a): a is string => typeof a === "string")) return false;
  if (args[0] !== "-y" || typeof args[1] !== "string") return false;
  const pkg = args[1];
  if (!pkg.startsWith(`${PACKAGE_NAME}@`) || !EXACT_VERSION.test(pkg.slice(PACKAGE_NAME.length + 1))) return false;
  const rest = args.slice(2);
  if (rest.length % 2 !== 0) return false;
  for (let i = 0; i < rest.length; i += 2) {
    if (!OUR_FLAGS_WITH_VALUE.has(rest[i] as string)) return false;
  }
  return true;
}

/** The value of one of our flags in an entry's args, or null. */
export function entryFlag(entry: unknown, flag: "--url" | "--name" | "--profile"): string | null {
  if (!isAssayEntry(entry)) return null;
  const args = (entry as { args: string[] }).args;
  for (let i = 2; i < args.length; i += 2) if (args[i] === flag) return args[i + 1] ?? null;
  return null;
}

/** {@link isAssayEntry}, and the entry has exactly these keys: what this client stores for what `add` wrote. */
export function isExactAssayEntry(entry: unknown, keys: readonly string[]): boolean {
  if (!isAssayEntry(entry)) return false;
  const actual = Object.keys(entry as object).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}
