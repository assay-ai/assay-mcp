import { escapeControl } from "./logger.js";
import { redact } from "./redact.js";

/**
 * The crash path (R-MCP-3, R-MCP-12). Node's default handlers print the stack and the whole
 * `cause` chain unredacted; these print one redacted, escaped line to stderr instead —
 * `name: message`, never the stack or the cause — and exit non-zero. stdout is never touched.
 */

export const EXIT_CRASH = 1;

/** The one line printed for a crash, without its newline. */
export function crashLine(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : "unexpected error";
  return `assay-mcp: ${escapeControl(redact(text))}`;
}

export interface CrashProcess {
  on(event: "uncaughtException" | "unhandledRejection", listener: (err: unknown) => void): unknown;
  exit(code: number): never;
}

/**
 * Installs `uncaughtException` and `unhandledRejection` handlers. Task 2.8: `serve` must not
 * exit on a network error (R-MCP-15); it catches those itself, so only real crashes get here.
 */
export function installCrashHandlers(
  proc: CrashProcess = process,
  stderr: (line: string) => void = (line) => void process.stderr.write(line),
): void {
  const crash = (err: unknown) => {
    try {
      stderr(`${crashLine(err)}\n`);
    } finally {
      proc.exit(EXIT_CRASH);
    }
  };
  proc.on("uncaughtException", crash);
  proc.on("unhandledRejection", crash);
}
