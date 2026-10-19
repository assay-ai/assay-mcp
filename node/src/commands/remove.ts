import { runRemove } from "./remove-impl.js";
import { defaultDeps } from "./wiring.js";

/** `assay-mcp remove` (spec 8.3). */
export function run(args: readonly string[]): Promise<number> {
  return runRemove(args, defaultDeps());
}
