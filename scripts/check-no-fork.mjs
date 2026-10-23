#!/usr/bin/env node
// The proxy takes its payment core (guards G1-G12, the voucher and binding EIP-712 types and
// builders, the `_meta` helpers) from `@goassay-ai/sdk/core`. Fails when node/src defines any of
// it again: a local copy would drift from the SDK and its vectors.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What only the SDK may define: each pattern names one piece of the payment core. */
export const FORBIDDEN = [
  ["guard function", /\bfunction\s+(?:g(?:[1-9]|1[0-2])|checkAll|confirmationFor|usdToAtomic)\s*\(/],
  ["guard function", /\b(?:const|let|var)\s+(?:checkAll|confirmationFor|usdToAtomic)\s*=/],
  ["refusal code table", /\bREFUSAL_CODES\s*=/],
  ["refusal code", /\b["'`]?G(?:[1-9]|1[0-2])_[A-Z_]+["'`]?\s*:\s*["'`]G(?:[1-9]|1[0-2])["'`]/],
  ["voucher builder", /\bfunction\s+(?:buildVoucher\w*|checkBindingChallenge|bindingTypedData|guardAndBuild\w+)\s*\(/],
  ["voucher builder", /\b(?:const|let|var)\s+(?:buildVoucher\w*|checkBindingChallenge|bindingTypedData)\s*=/],
  ["EIP-712 domain name", /["'`](?:Assay Settlement|GoAssay Agent Binding)["'`]/],
  ["EIP-712 type", /\bname\s*:\s*["'`](?:resourceHash|requestHash|expiresAt|credentialId)["'`]\s*,\s*type\s*:/],
  ["EIP-712 primary type", /\bprimaryType\s*:\s*["'`](?:Voucher|DelegateBinding)["'`]/],
  ["EIP-712 type table", /\b(?:VOUCHER_TYPES|DELEGATE_BINDING_TYPES)\s*=/],
];

/** Every `.ts`/`.js` file under `dir`. */
function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(path));
    else if (/\.[cm]?[jt]s$/.test(e.name)) out.push(path);
  }
  return out;
}

/** The forbidden definitions in one file's text, as `what: line`. */
export function findForksIn(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const [what, re] of FORBIDDEN) if (re.test(line)) hits.push(`${what} at line ${i + 1}`);
  });
  return hits;
}

/** Repo-relative `file: what` for every forbidden definition under `dir`. */
export function findForks(dir, root = dir) {
  return sources(dir).flatMap((file) => findForksIn(readFileSync(file, "utf8")).map((h) => `${relative(root, file)}: ${h}`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const hits = findForks(join(root, "node/src"), root);
  if (hits.length > 0) {
    console.error("check-no-fork failed: the payment core comes from @goassay-ai/sdk/core, never a local copy:");
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log("check-no-fork: ok");
}
