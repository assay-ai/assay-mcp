import { aliasTool, NO_NAME_BUDGET } from "../clients/server-name.js";
import { silentLogger, type Logger } from "../log/logger.js";

/**
 * Runtime tool aliases (spec §8.3.1 "At runtime", R-MU-14).
 *
 * A tool whose client-visible name (`mcp__{server}__{tool}`) would exceed the 64-character
 * budget is listed under 2.10's {@link aliasTool}: the first `64 − 7 − len(server) − 7`
 * characters, `_`, and 6 base32 characters of sha256(original). The table is rebuilt on every
 * `tools/list` (a paged list adds its later pages); a call on an alias is forwarded with the
 * exact original name. Without `--name` the server name is budgeted at 16 characters.
 */
export class AliasTable {
  private readonly serverName: string;
  private toOriginal = new Map<string, string>();
  private readonly warned = new Set<string>();

  constructor(
    serverName: string | null,
    private readonly log: Logger = silentLogger,
  ) {
    // aliasTool only measures the server name; without --name it is the 16-character budget.
    this.serverName = serverName ?? "x".repeat(NO_NAME_BUDGET);
  }

  /**
   * Rewrites the tools of one `tools/list` page in place and returns it. `firstPage` (no
   * cursor) starts a new table.
   */
  rewriteList(result: Record<string, unknown>, firstPage: boolean): Record<string, unknown> {
    if (firstPage) this.toOriginal = new Map();
    const tools = result.tools;
    if (!Array.isArray(tools)) return result;
    const names = new Set(tools.map((t) => (isObject(t) && typeof t.name === "string" ? t.name : null)));
    const out = tools.map((tool) => {
      if (!isObject(tool) || typeof tool.name !== "string") return tool;
      const original = tool.name;
      const alias = aliasTool(this.serverName, original);
      if (alias === null || alias === original) {
        if (alias === null && this.warnOnce(original)) this.log.warn("tool name too long for the client and cannot be aliased", { tool: original.slice(0, 80) });
        return tool;
      }
      if (names.has(alias) || (this.toOriginal.has(alias) && this.toOriginal.get(alias) !== original)) {
        // Another tool already has that name: leave this one as it is rather than shadow it.
        if (this.warnOnce(original)) this.log.warn("tool alias collides with another tool; left unaliased", { tool: original.slice(0, 80) });
        return tool;
      }
      this.toOriginal.set(alias, original);
      if (this.warnOnce(original)) this.log.warn("tool listed under an alias: its full name is longer than the client allows", { tool: original.slice(0, 80), alias });
      const description = typeof tool.description === "string" ? tool.description : "";
      return { ...tool, name: alias, description: `(Assay tool ${original})${description ? ` ${description}` : ""}` };
    });
    return { ...result, tools: out };
  }

  /** The exact original name for a called name: itself unless it is a current alias. */
  original(name: string): string {
    return this.toOriginal.get(name) ?? name;
  }

  isAlias(name: string): boolean {
    return this.toOriginal.has(name);
  }

  private warnOnce(tool: string): boolean {
    if (this.warned.has(tool)) return false;
    this.warned.add(tool);
    return true;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
