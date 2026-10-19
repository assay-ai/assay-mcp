import { runList } from "./list-impl.js";
import { defaultDeps } from "./wiring.js";

/** `assay-mcp list` (spec 8.3). */
export function run(args: readonly string[]): Promise<number> {
  return runList(args, defaultDeps());
}
