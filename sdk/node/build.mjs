import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const core = fileURLToPath(new URL("../../node/src/", import.meta.url));
/**
 * The OS keychain binding ships native binaries per platform, so it cannot be bundled. Only
 * `Signers.fromKeychain` loads it, with a dynamic import; without it that signer reports
 * "No OS keychain is available" and every other signer works.
 */
const OPTIONAL_EXTERNAL = ["@napi-rs/keyring"];

// One self-contained file with no runtime dependencies: the MCP client, viem and the proxy's
// signer and guards (reached through the `@assay-core/*` alias, never copied) are bundled in.
const result = await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  alias: { "@assay-core": core.replace(/\/$/, "") },
  external: OPTIONAL_EXTERNAL,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
  // Bundled CommonJS dependencies call require() on Node built-ins.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});

const bad = [];
for (const [file, out] of Object.entries(result.metafile.outputs)) {
  for (const imp of out.imports) {
    const bare = imp.path.startsWith("node:") ? imp.path.slice(5) : imp.path;
    if (imp.external && OPTIONAL_EXTERNAL.includes(imp.path) && imp.kind === "dynamic-import") continue;
    if (imp.external && !builtinModules.includes(bare)) bad.push(`${file}: ${imp.kind} of "${imp.path}"`);
  }
}
if (bad.length > 0) {
  console.error(`The bundle loads modules that are not bundled:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}

execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit", shell: process.platform === "win32" });
