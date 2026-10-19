import { build } from "esbuild";

// One self-contained bundle. viem and every other library are bundled in; only the
// native keychain binding stays external (it ships prebuilt binaries per platform).
await build({
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
});
