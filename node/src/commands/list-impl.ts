/** `assay-mcp list`: `installs.json`, each checked against the client's config (spec 8.3). */
import { entryFlag } from "../clients/install-command.js";
import type { InstallRecord } from "../clients/installs.js";
import { EXIT_FATAL, EXIT_OK, EXIT_USAGE } from "../exit-codes.js";
import { parseFlags, UsageError, type InstallDeps } from "./context.js";

/** `ok`; `missing` (removed by hand); `changed` (the entry is no longer the one `add` wrote); `unreadable`. */
export type InstallStatus = "ok" | "missing" | "changed" | "unreadable";

export function statusOf(record: InstallRecord, deps: InstallDeps): InstallStatus {
  const client = deps.clients[record.client];
  let entry: unknown;
  try {
    const target = client.targetOf(record.scope, record.configPath, deps.clientEnv);
    const entries = client.entries(target, deps.clientEnv);
    if (!entries.has(record.name)) return "missing";
    entry = entries.get(record.name);
  } catch {
    return "unreadable";
  }
  if (!client.isOurs(entry)) return "changed";
  const url = entryFlag(entry, "--url");
  if (url !== null && url !== record.url) return "changed";
  return "ok";
}

export function listInstalls(deps: InstallDeps): { record: InstallRecord; status: InstallStatus }[] {
  return deps.installs.read().map((record) => ({ record, status: statusOf(record, deps) }));
}

export async function runList(args: readonly string[], deps: InstallDeps): Promise<number> {
  try {
    parseFlags(args, {}, 0);
    const rows = listInstalls(deps);
    if (rows.length === 0) {
      deps.print("No Assay servers installed with assay-mcp add.\n");
      return EXIT_OK;
    }
    for (const { record: r, status } of rows) {
      const profile = r.profile === "default" ? "" : `  profile ${r.profile}`;
      deps.print(`${r.name}  ${r.client} (${r.scope})  → ${r.url}${profile}  ${status}${r.scope === "project" ? `  ${r.configPath}` : ""}\n`);
    }
    return EXIT_OK;
  } catch (err) {
    deps.print(`assay-mcp list: ${(err as Error).message}\n`);
    return err instanceof UsageError ? EXIT_USAGE : EXIT_FATAL;
  }
}
