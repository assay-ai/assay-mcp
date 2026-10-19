#!/usr/bin/env node
// Fails when node/dist/cli.js loads any module at run time other than Node built-ins and
// @napi-rs/keyring: everything else (viem included) must be bundled in (R-MCP-2).
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_EXTERNAL = ["@napi-rs/keyring"];

function allowed(specifier) {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return builtinModules.includes(bare) || ALLOWED_EXTERNAL.includes(specifier);
}

/** Returns the problems found in the bundle text. */
export function checkBundle(code) {
  const errors = [];
  const literal = String.raw`\s*(["'\x60])([^"'\x60]*)\1\s*\)`;
  const patterns = [
    ["require", new RegExp(String.raw`\b(?:__require|require)\(` + literal, "g")],
    ["dynamic import", new RegExp(String.raw`\bimport\(` + literal, "g")],
    ["static import", /^\s*(?:import|export)\b[^"';]*?\bfrom\s*(["'])([^"']+)\1/gm],
    ["side-effect import", /^\s*import\s*(["'])([^"']+)\1/gm],
  ];
  for (const [kind, re] of patterns) {
    for (const m of code.matchAll(re)) {
      if (!allowed(m[2])) errors.push(`${kind} of "${m[2]}"`);
    }
  }
  // A require or import whose argument is not a string literal cannot be checked.
  for (const m of code.matchAll(/\b(?:__require|require|import)\(\s*(?!["'\x60])([^)]{0,40})/g)) {
    errors.push(`non-literal ${m[0].trim()}`);
  }
  if (/\bcreateRequire\b/.test(code)) errors.push("createRequire is not allowed");
  if (/\bdlopen\b/.test(code)) errors.push("dlopen is not allowed");
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const errors = checkBundle(readFileSync(join(root, "node/dist/cli.js"), "utf8"));
  if (errors.length > 0) {
    console.error("node/dist/cli.js loads modules that are not bundled:");
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log("check-bundle: ok");
}
