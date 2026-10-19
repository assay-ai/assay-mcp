#!/usr/bin/env node
// Emits dist/signer/voucher.mjs: the proxy's voucher builder as one self-contained ESM file, for
// scripts that must sign exactly what the proxy signs (for example an on-chain test) without a
// hand-built bundle.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  entryPoints: [`${root}node/src/signer/voucher.ts`],
  outfile: `${root}dist/signer/voucher.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "warning",
});
console.log("build:signer: dist/signer/voucher.mjs");
