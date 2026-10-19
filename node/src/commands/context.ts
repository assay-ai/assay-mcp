/** What `add`, `list` and `remove` run against. Tests pass their own; `wiring.ts` builds the real one. */
import type { ClientAdapter, ClientEnv } from "../clients/client.js";
import type { ClientId } from "../clients/install-command.js";
import type { InstallsStore } from "../clients/installs.js";
import type { ProfilePort, UrlResolver } from "../clients/ports.js";
import { parseArgs, type ParseArgsConfig } from "node:util";

export interface InstallDeps {
  clients: Readonly<Record<ClientId, ClientAdapter>>;
  clientEnv: ClientEnv;
  resolveUrl: UrlResolver;
  profiles: ProfilePort;
  /** `{dir}/installs.json`, written under the lock. */
  installs: InstallsStore;
  /** The process environment (`ASSAY_API_KEY` is checked for `--scope project`). */
  env: Readonly<Record<string, string | undefined>>;
  /** stdin and stdout are both TTYs. */
  isTTY: boolean;
  onPath(bin: string): boolean;
  /** Asks the user to pick one of `choices` on the TTY; null when nothing was chosen. */
  ask(question: string, choices: readonly string[]): Promise<string | null>;
  /** All human output goes to stderr (only `serve` writes to stdout). */
  print(text: string): void;
  version: string;
  /** The built-in production MCP origin. */
  productionOrigin: string;
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** Strict flag parsing: unknown flags, missing values and repeated flags are usage errors. */
export function parseFlags(args: readonly string[], options: Options, positionals: number) {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true, tokens: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const seen = new Set<string>();
  for (const t of parsed.tokens ?? []) {
    if (t.kind !== "option") continue;
    if (seen.has(t.name)) throw new UsageError(`--${t.name} is given more than once`);
    seen.add(t.name);
  }
  if (parsed.positionals.length !== positionals) {
    throw new UsageError(positionals === 1 ? "expected exactly one argument" : `expected ${positionals} arguments`);
  }
  return { values: parsed.values as Record<string, string | boolean | undefined>, positionals: parsed.positionals };
}
