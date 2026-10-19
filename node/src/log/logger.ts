import type { LogFile } from "./log-file.js";
import { REDACTED, redact } from "./redact.js";

/**
 * The proxy's logger (spec §7.13).
 *
 * - stderr only (stdout carries MCP JSON-RPC and nothing else, R-MCP-3), plus `--log-file`
 *   when one is given;
 * - one line per entry: `ts level component message key=value…`, `ts` in UTC;
 * - default level `warn`;
 * - control characters escaped, and every line passed through {@link redact} before it is
 *   written (R-MCP-12).
 *
 * Only scalars are formatted. Objects and arrays are never serialised, so a tool's
 * arguments or result cannot reach a log line by being passed as a field.
 */

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const DEFAULT_LOG_LEVEL: LogLevel = "warn";

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export function parseLogLevel(value: string): LogLevel | null {
  return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : null;
}

export type FieldValue = string | number | bigint | boolean | null | undefined | Error;
export type Fields = Readonly<Record<string, FieldValue>>;

export interface Logger {
  readonly level: LogLevel;
  error(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  debug(message: string, fields?: Fields): void;
  /** A logger for another component, sharing the level and the sinks. */
  child(component: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  component?: string;
  file?: LogFile | null;
  /** Where stderr lines go; tests replace it. Never stdout. */
  stderr?: (line: string) => void;
  now?: () => Date;
}

/**
 * Field names whose value is never logged, whatever it looks like: credentials, signatures,
 * PKCE verifiers, request ids, tool arguments and results. Matched on whole words of the
 * name (`refreshToken`, `x-authorization`, `tool_args`).
 */
const SECRET_WORDS = new Set([
  "authorization", "bearer", "cookie", "password", "secret", "token", "tokens",
  "signature", "sig", "verifier", "private", "privatekey", "mnemonic", "seed",
  "rid", "arguments", "args", "result", "results",
]);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

export function isSecretFieldName(name: string): boolean {
  const words = nameWords(name);
  return words.some((w) => SECRET_WORDS.has(w)) || SECRET_WORDS.has(words.join(""));
}

/**
 * Escapes C0 and C1 control characters, DEL, the Unicode line and paragraph separators and
 * the bidi controls as `\uXXXX`, and the backslash itself, so a logged value can neither
 * forge a line nor drive the terminal.
 */
export function escapeControl(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return text.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) =>
    c === "\\" ? "\\\\" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function scalar(value: FieldValue): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      // Never serialise objects: they may be tool arguments or results.
      return "[object]";
  }
}

function formatValue(value: FieldValue): string {
  const text = escapeControl(redact(scalar(value)));
  return text === "" || /[\s"=]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function formatKey(key: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(key) ? key : "field";
}

function formatComponent(component: string): string {
  return /^[a-z0-9][a-z0-9_.-]{0,31}$/.test(component) ? component : "main";
}

/** One log line without its newline. Exported for tests. */
export function formatLine(ts: Date, level: LogLevel, component: string, message: string, fields?: Fields): string {
  const parts = [ts.toISOString(), level, formatComponent(component), escapeControl(redact(message))];
  for (const [key, value] of Object.entries(fields ?? {})) {
    parts.push(`${formatKey(key)}=${isSecretFieldName(key) ? REDACTED : formatValue(value)}`);
  }
  // The filter runs again on the finished line: escaping never assembles a secret, but the
  // last pass is what the spec's grep test relies on.
  return redact(parts.join(" "));
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? DEFAULT_LOG_LEVEL;
  const stderr = options.stderr ?? ((line: string) => void process.stderr.write(line));
  const file = options.file ?? null;
  const now = options.now ?? (() => new Date());

  const make = (component: string): Logger => {
    const emit = (at: LogLevel, message: string, fields?: Fields) => {
      if (RANK[at] > RANK[level]) return;
      const line = `${formatLine(now(), at, component, message, fields)}\n`;
      stderr(line);
      file?.write(line);
    };
    return {
      level,
      error: (m, f) => emit("error", m, f),
      warn: (m, f) => emit("warn", m, f),
      info: (m, f) => emit("info", m, f),
      debug: (m, f) => emit("debug", m, f),
      child: (c) => make(c),
    };
  };
  return make(options.component ?? "main");
}

/** A logger that drops everything (the default where no logger is passed). */
export const silentLogger: Logger = createLogger({ level: "error", stderr: () => {}, file: null });
