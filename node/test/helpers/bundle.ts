import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const nodeRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Bundles a test fixture into a temporary `.mjs` that `child_process.fork` can run. It is
 * written under `node/` so the external `@napi-rs/keyring` resolves; callers delete `dir`.
 */
export async function bundleFixture(entry: string): Promise<{ dir: string; file: string }> {
  const dir = mkdtempSync(join(nodeRoot, ".test-fixture-"));
  const file = join(dir, "fixture.mjs");
  await build({
    entryPoints: [entry],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["@napi-rs/keyring"],
    logLevel: "silent",
  });
  return { dir, file };
}
