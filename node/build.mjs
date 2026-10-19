import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { build } from "esbuild";

const ALLOWED_EXTERNAL = ["@napi-rs/keyring"];

/**
 * Bundles `package.json` as `{name, version}` only (4.1 M7): its scripts and devDependencies are
 * not part of the shipped file.
 */
const manifestOnly = {
  name: "manifest-only",
  setup(b) {
    b.onLoad({ filter: /[\\/]package\.json$/ }, (args) => {
      const { name, version } = JSON.parse(readFileSync(args.path, "utf8"));
      return { contents: JSON.stringify({ name, version }), loader: "json" };
    });
  },
};

// One self-contained bundle. viem and every other library are bundled in; only the
// native keychain binding stays external (it ships prebuilt binaries per platform).
const result = await build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@napi-rs/keyring"],
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
  plugins: [manifestOnly],
});

// First layer of the bundle check (scripts/check-bundle.mjs is the second): esbuild's own list
// of what the output still loads at run time must be Node built-ins or the keyring only.
const bad = [];
for (const [file, out] of Object.entries(result.metafile.outputs)) {
  for (const imp of out.imports) {
    const bare = imp.path.startsWith("node:") ? imp.path.slice(5) : imp.path;
    if (!imp.external) continue;
    if (builtinModules.includes(bare) || ALLOWED_EXTERNAL.includes(imp.path)) continue;
    bad.push(`${file}: ${imp.kind} of "${imp.path}"`);
  }
}
if (bad.length > 0) {
  console.error(`The bundle loads modules that are not bundled:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
