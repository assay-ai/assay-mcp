import { runAdd } from "./add-impl.js";
import { defaultDeps } from "./wiring.js";

/** `assay-mcp add` (spec 8.3). */
export function run(args: readonly string[]): Promise<number> {
  return runAdd(args, defaultDeps());
}
