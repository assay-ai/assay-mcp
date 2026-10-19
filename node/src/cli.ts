import { builtInDeployments, validateDeployments } from "./deployments.js";
import { EXIT_FATAL, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { VERSION } from "./version.js";
import * as add from "./commands/add.js";
import * as allowPaid from "./commands/allow-paid.js";
import * as devAllow from "./commands/dev-allow.js";
import * as disallowPaid from "./commands/disallow-paid.js";
import * as enablePaid from "./commands/enable-paid.js";
import * as limits from "./commands/limits.js";
import * as list from "./commands/list.js";
import * as login from "./commands/login.js";
import * as logout from "./commands/logout.js";
import * as remove from "./commands/remove.js";
import * as serve from "./commands/serve.js";
import * as status from "./commands/status.js";

export type Command = (args: readonly string[]) => Promise<number>;

/** Every command, keyed by its name. `dev allow` is the two-word `dev-allow`. */
export const COMMANDS: Readonly<Record<string, Command>> = {
  serve: serve.run,
  add: add.run,
  list: list.run,
  remove: remove.run,
  login: login.run,
  logout: logout.run,
  status: status.run,
  "enable-paid": enablePaid.run,
  limits: limits.run,
  "allow-paid": allowPaid.run,
  "disallow-paid": disallowPaid.run,
  "dev-allow": devAllow.run,
};

export const USAGE = `Usage:
  assay-mcp [serve] [--url <url|/path>] [--name <name>] [--profile <name>] [--no-paid] [--log-level <level>] [--log-file <path>]
  assay-mcp add <url|/path> [--client <id>] [--name <name>] [--scope user|project] [--profile <name>] [--force]
  assay-mcp list
  assay-mcp remove <name> [--client <id>] [--scope user|project]
  assay-mcp login | logout | status [--profile <name>]
  assay-mcp enable-paid [--profile <name>]
  assay-mcp limits [set --per-call <usd> --per-day <usd> [--confirm-above <usd>|off] [--providers <0x...,...>|off]] [--profile <name>]
  assay-mcp allow-paid <url> | disallow-paid <url> [--profile <name>]
  assay-mcp dev allow <origin>
  assay-mcp --version
`;

export type Resolved =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "usage-error"; message: string }
  | { kind: "command"; name: string; args: string[] };

/** Maps argv (without `node` and the script) to a command. No command, or a leading flag, means `serve`. */
export function resolve(argv: readonly string[]): Resolved {
  const [first, ...rest] = argv;
  if (first === "--version") return { kind: "version" };
  if (first === "--help" || first === "-h" || first === "help") return { kind: "help" };
  if (first === undefined || first.startsWith("-")) return { kind: "command", name: "serve", args: [...argv] };
  if (first === "dev") {
    const [sub, ...devArgs] = rest;
    if (sub === "allow") return { kind: "command", name: "dev-allow", args: devArgs };
    return { kind: "usage-error", message: `unknown command "dev ${sub ?? ""}".` };
  }
  if (first === "dev-allow" || !Object.hasOwn(COMMANDS, first)) {
    return { kind: "usage-error", message: `unknown command "${first}".` };
  }
  return { kind: "command", name: first, args: rest };
}

/** Runs the CLI and returns the exit code. Only MCP JSON-RPC (from `serve`) and `--version` write to stdout. */
export async function main(argv: readonly string[]): Promise<number> {
  const r = resolve(argv);
  switch (r.kind) {
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return EXIT_OK;
    case "help":
      process.stderr.write(USAGE);
      return EXIT_OK;
    case "usage-error":
      process.stderr.write(`assay-mcp: ${r.message}\n${USAGE}`);
      return EXIT_USAGE;
    case "command": {
      const errors = validateDeployments(builtInDeployments());
      if (errors.length > 0) {
        process.stderr.write(`assay-mcp: the built-in deployments table is invalid:\n  ${errors.join("\n  ")}\n`);
        return EXIT_FATAL;
      }
      return COMMANDS[r.name]!(r.args);
    }
  }
}
