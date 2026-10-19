// Runs one example: `node run-example.mjs anthropic-messages|openai-responses`.
// The example is bundled with the same `@assay-core` alias as the package build (Node cannot run
// the .ts sources with their `.js` import specifiers), into a temporary directory, then run.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const name = process.argv[2];
if (name !== "anthropic-messages" && name !== "openai-responses") {
  console.error("usage: node run-example.mjs anthropic-messages|openai-responses");
  process.exit(2);
}
const core = fileURLToPath(new URL("../../node/src", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "assay-example-"));
try {
  const outfile = join(dir, `${name}.mjs`);
  await build({
    entryPoints: [fileURLToPath(new URL(`examples/${name}.ts`, import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    alias: { "@assay-core": core },
    external: ["@napi-rs/keyring"],
    logLevel: "warning",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  });
  const r = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: process.env });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
