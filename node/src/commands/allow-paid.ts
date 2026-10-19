import { defaultProfileDeps } from "./profile-context.js";
import { runPaidUrlChange } from "./paid-urls.js";

/** `assay-mcp allow-paid <url>` (TTY only). */
export function run(args: readonly string[]): Promise<number> {
  return runPaidUrlChange("allow-paid", args, defaultProfileDeps());
}
