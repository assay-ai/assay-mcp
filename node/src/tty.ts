/**
 * Terminal-only commands (spec §7.3): `limits set`, `allow-paid`, `disallow-paid`, `dev allow`
 * and `settings set` run only when a person is at the keyboard, i.e. stdin and stdout are both
 * TTYs. An agent, a script or an MCP host runs them with pipes and is refused, so no server
 * response, web page, project config or tool call can change these settings.
 */
import { EXIT_USAGE } from "./exit-codes.js";

export interface TtyStreams {
  stdin: { isTTY?: boolean | undefined };
  stdout: { isTTY?: boolean | undefined };
}

/** True when stdin and stdout are both TTYs. */
export function isInteractive(streams: TtyStreams = process): boolean {
  return streams.stdin.isTTY === true && streams.stdout.isTTY === true;
}

export class TtyRequired extends Error {
  override readonly name = "TtyRequired";
  readonly exitCode = EXIT_USAGE;
  constructor(command: string) {
    super(`"${command}" changes local safety settings, so it runs only in an interactive terminal (stdin and stdout must be a TTY). Run it yourself in a terminal.`);
  }
}

/** Throws {@link TtyRequired} (exit code 2) unless stdin and stdout are TTYs. */
export function requireTty(command: string, interactive: boolean = isInteractive()): void {
  if (!interactive) throw new TtyRequired(command);
}
