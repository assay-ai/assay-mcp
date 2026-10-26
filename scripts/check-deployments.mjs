#!/usr/bin/env node
// Release gate for deployments.json: no entry holds a placeholder left
// from ops config, every production network reads the chain through two distinct RPC hosts, and
// staging never shares the production escrow.
// The shape itself (CAIP ids, checksums) is checked by the unit tests and at startup.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Networks the production backend enables today. */
export const PRODUCTION_NETWORKS = ["eip155:4663"];

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

/** Entries that may use a single RPC and http URLs (local stacks). */
export const DEV_ENVIRONMENTS = ["e2e", "anvil"];

function collectPlaceholders(value, path, out) {
  if (typeof value === "string") {
    if (isPlaceholder(value)) out.push(`${path} is a placeholder: ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectPlaceholders(v, `${path}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectPlaceholders(v, path ? `${path}.${k}` : k, out);
  }
}

/** Returns the problems that block a release. */
export function checkReleaseDeployments(table) {
  const errors = [];
  const prod = table.production;
  if (!prod) return ["production entry is missing"];
  // Every entry ships in the bundle, so none may hold a value still to be filled from ops config.
  collectPlaceholders(table, "", errors);
  for (const key of ["mcp", "issuer", "api", "web"]) {
    const v = prod[key];
    if (!isPlaceholder(v) && !v?.startsWith("https://")) errors.push(`production.${key} must be https`);
  }
  const keys = Object.keys(prod.networks ?? {});
  if (keys.join(",") !== PRODUCTION_NETWORKS.join(",")) {
    errors.push(`production networks are [${keys.join(", ")}], expected [${PRODUCTION_NETWORKS.join(", ")}]`);
  }
  for (const [id, n] of Object.entries(prod.networks ?? {})) {
    const hosts = new Set();
    for (const r of n.rpc ?? []) {
      if (isPlaceholder(r)) continue;
      const host = hostOf(r);
      if (!host || !r.startsWith("https://")) errors.push(`production.networks.${id}.rpc entry is not an https URL`);
      else hosts.add(host);
    }
    if (hosts.size < 2) errors.push(`production.networks.${id}.rpc needs two distinct hosts`);
  }
  // Same chain and same escrow mean the same EIP-712 domain: a signature made for staging would
  // also be valid on the production escrow. Only the local dev entries may share it.
  for (const [env, entry] of Object.entries(table)) {
    if (env === "production" || DEV_ENVIRONMENTS.includes(env)) continue;
    for (const [id, n] of Object.entries(entry.networks ?? {})) {
      const p = prod.networks?.[id];
      if (p && !isPlaceholder(n.escrow) && n.escrow?.toLowerCase() === p.escrow?.toLowerCase()) {
        errors.push(`${env}.networks.${id}.escrow must differ from the production escrow`);
      }
    }
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
