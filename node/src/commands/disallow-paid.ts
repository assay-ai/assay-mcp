import { defaultProfileDeps } from "./profile-context.js";
import { runPaidUrlChange } from "./paid-urls.js";

/** `assay-mcp disallow-paid <url>` (TTY only). */
export function run(args: readonly string[]): Promise<number> {
  return runPaidUrlChange("disallow-paid", args, defaultProfileDeps());
}
