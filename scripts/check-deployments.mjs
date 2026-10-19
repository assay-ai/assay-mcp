#!/usr/bin/env node
// Release gate for deployments.json: the production entry is complete (no placeholder left
// from ops config) and every production network reads the chain through two distinct RPC hosts.
// The shape itself (CAIP ids, checksums) is checked by the unit tests and at startup.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Networks the production backend enables today. */
export const PRODUCTION_NETWORKS = ["eip155:46630"];

export function isPlaceholder(value) {
  return typeof value === "string" && /^<[^<>]+>$/.test(value);
}

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Returns the problems that block a release. */
export function checkReleaseDeployments(table) {
  const errors = [];
  const prod = table.production;
  if (!prod) return ["production entry is missing"];
  for (const key of ["mcp", "issuer", "api", "web"]) {
    const v = prod[key];
    if (isPlaceholder(v)) errors.push(`production.${key} is a placeholder: ${v}`);
    else if (!v?.startsWith("https://")) errors.push(`production.${key} must be https`);
  }
  const keys = Object.keys(prod.networks ?? {});
  if (keys.join(",") !== PRODUCTION_NETWORKS.join(",")) {
    errors.push(`production networks are [${keys.join(", ")}], expected [${PRODUCTION_NETWORKS.join(", ")}]`);
  }
  for (const [id, n] of Object.entries(prod.networks ?? {})) {
    const rpc = n.rpc ?? [];
    const hosts = new Set();
    for (const r of rpc) {
      if (isPlaceholder(r)) {
        errors.push(`production.networks.${id}.rpc has a placeholder: ${r}`);
        continue;
      }
      const host = hostOf(r);
      if (!host || !r.startsWith("https://")) errors.push(`production.networks.${id}.rpc entry is not an https URL`);
      else hosts.add(host);
    }
    if (hosts.size < 2) errors.push(`production.networks.${id}.rpc needs two distinct hosts`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const errors = checkReleaseDeployments(JSON.parse(readFileSync(join(root, "deployments.json"), "utf8")));
  if (errors.length > 0) {
    console.error("deployments.json is not ready for a release:");
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log("check-deployments: ok");
}
