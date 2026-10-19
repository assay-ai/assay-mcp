#!/usr/bin/env node
// Release gate for the npm package (R-MCP-2, spec §7.5): exact versions only, no install
// scripts in the package or its runtime dependency tree, and only the bundle is shipped.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@assay-ai/mcp";
export const RUNTIME_DEPENDENCIES = ["@napi-rs/keyring"];
export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const EXACT = /^\d+\.\d+\.\d+$/;
const ALLOWED_FILES = new Set(["package.json", "README.md", "LICENSE", "dist/cli.js"]);

/** Checks the manifest that `npm pack` ships. Returns a list of problems. */
export function checkManifest(pkg) {
  const errors = [];
  if (pkg.name !== PACKAGE_NAME) errors.push(`name is ${pkg.name}, expected ${PACKAGE_NAME}`);
  if (!EXACT.test(pkg.version ?? "")) errors.push(`version ${pkg.version} is not an exact x.y.z`);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (field !== "dependencies") errors.push(`${field}.${name} is not allowed`);
      else if (!RUNTIME_DEPENDENCIES.includes(name)) errors.push(`dependency ${name} is not allowed`);
      if (typeof range !== "string" || !EXACT.test(range)) errors.push(`${field}.${name} is "${range}", not an exact version`);
    }
  }
  for (const s of INSTALL_SCRIPTS) {
    if (pkg.scripts?.[s] !== undefined) errors.push(`install script "${s}" is not allowed`);
  }
  if (pkg.bin?.["assay-mcp"] !== "dist/cli.js") errors.push(`bin assay-mcp must be dist/cli.js`);
  return errors;
}

/** Checks the file list from `npm pack --dry-run --json`. */
export function checkPackFiles(files) {
  const errors = [];
  const paths = files.map((f) => f.path);
  for (const p of paths) if (!ALLOWED_FILES.has(p)) errors.push(`unexpected file in package: ${p}`);
  if (!paths.includes("dist/cli.js")) errors.push("dist/cli.js is missing; run the build first");
  return errors;
}

/**
 * Checks the runtime tree in package-lock.json: every package a user installs (the keyring and
 * its platform binaries) is pinned exactly and has no install script.
 */
export function checkLockRuntime(lock) {
  const errors = [];
  const entries = Object.entries(lock.packages ?? {});
  const runtime = entries.filter(([path, meta]) => path.startsWith("node_modules/") && !meta.dev && !meta.link);
  for (const [path, meta] of runtime) {
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!RUNTIME_DEPENDENCIES.some((d) => name === d || name.startsWith(`${d}-`))) {
      errors.push(`runtime package ${name} is not allowed`);
      continue;
    }
    if (meta.hasInstallScript) errors.push(`runtime package ${name} has an install script`);
    for (const [dep, range] of Object.entries({ ...meta.dependencies, ...meta.optionalDependencies })) {
      if (!EXACT.test(range)) errors.push(`${name} depends on ${dep}@"${range}", not an exact version`);
    }
  }
  if (runtime.length === 0) errors.push("no runtime packages found in package-lock.json");
  return errors;
}

export const SDK_PACKAGE_NAME = "@assay-ai/sdk";
const SDK_FILE = /^(package\.json|README\.md|LICENSE|dist\/index\.js|dist\/types\/.+\.d\.ts)$/;

/** The SDK ships a self-contained bundle: exact versions, no runtime dependencies, no install scripts. */
export function checkSdkManifest(pkg) {
  const errors = [];
  if (pkg.name !== SDK_PACKAGE_NAME) errors.push(`name is ${pkg.name}, expected ${SDK_PACKAGE_NAME}`);
  if (!EXACT.test(pkg.version ?? "")) errors.push(`version ${pkg.version} is not an exact x.y.z`);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) errors.push(`${field}.${name} is not allowed: the SDK bundles everything`);
  }
  for (const s of INSTALL_SCRIPTS) {
    if (pkg.scripts?.[s] !== undefined) errors.push(`install script "${s}" is not allowed`);
  }
  return errors;
}

/** Checks the file list from `npm pack --dry-run --json` of the SDK. */
export function checkSdkPackFiles(files) {
  const errors = [];
  const paths = files.map((f) => f.path);
  for (const p of paths) if (!SDK_FILE.test(p)) errors.push(`unexpected file in the SDK package: ${p}`);
  if (!paths.includes("dist/index.js")) errors.push("sdk dist/index.js is missing; run the build first");
  return errors;
}

function packFiles(root, workspace = "node") {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "-w", workspace], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const result = JSON.parse(out);
  return result[0].files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const errors = [
    ...checkManifest(JSON.parse(readFileSync(join(root, "node/package.json"), "utf8"))),
    ...checkLockRuntime(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))),
    ...checkPackFiles(packFiles(root)),
    ...checkSdkManifest(JSON.parse(readFileSync(join(root, "sdk/node/package.json"), "utf8"))),
    ...checkSdkPackFiles(packFiles(root, "sdk/node")),
  ];
  if (errors.length > 0) {
    console.error("check-pack failed:");
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log("check-pack: ok");
}
