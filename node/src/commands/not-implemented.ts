import { EXIT_USAGE } from "../exit-codes.js";

/** Shared stub body: a message on stderr (never stdout) and exit code 2. */
export function notImplemented(command: string, _args: readonly string[]): Promise<number> {
  process.stderr.write(`assay-mcp: "${command}" is not implemented yet.\n`);
  return Promise.resolve(EXIT_USAGE);
}
