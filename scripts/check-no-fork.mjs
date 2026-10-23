#!/usr/bin/env node
// The proxy takes its payment core (guards G1-G12, the voucher and binding EIP-712 types and
// builders, the `_meta` helpers) from `@goassay-ai/sdk/core`. Fails when node/src or scripts/
// (except this file) defines any of it again: a local copy would drift from the SDK and its
// vectors.
//
// Each file is matched as a whole, after its whitespace is normalised and adjacent string
// literals joined, so a definition split across lines or built from `"a" + "b"` is still seen.
// Symbolic links are refused, never followed.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The directories scanned, relative to the repo root. */
export const SCAN_DIRS = ["node/src", "scripts"];
/** This file: it names the payment core in its patterns. Relative to the repo root. */
const SELF = "scripts/check-no-fork.mjs";

/** Source files: `.js`/`.ts` with the `m`/`c` variants and `.jsx`/`.tsx`. */
const SOURCE = /\.[cm]?[jt]sx?$/;

const Q = "[\"'`]";
const GUARDS = "g(?:[1-9]|1[0-2])|checkAll|confirmationFor|usdToAtomic";
const BUILDERS = "buildVoucher\\w*|checkBindingChallenge|bindingTypedData|guardAndBuild\\w+";
const MODIFIERS = "(?:(?:export|default|public|private|protected|static|async|readonly|override|declare) )*";

/**
 * Every way `names` can be defined, on normalised text: a function (generic or not), a
 * `const`/`let`/`var`, a class or object method, and a class field or object property that
 * holds a function.
 */
function definitions(names) {
  return [
    new RegExp(`\\bfunction\\*? ?(?:${names})\\b(?:<[^()]*>)?\\(`),
    new RegExp(`\\b(?:const|let|var) (?:${names})\\b(?::[^=;]{0,200})?=(?!=)`),
    new RegExp(`(?:^|[;{}])${MODIFIERS}\\*?(?:${names})\\b(?:<[^()]*>)?\\([^()]*\\)(?::[^{;]{0,200})?\\{`),
    new RegExp(`(?:^|[;{},])${MODIFIERS}${Q}?(?:${names})\\b${Q}?(?::[^=;,]{0,200})?[=:](?:async )?(?:function\\b|\\(|[A-Za-z_$][\\w$]*=>)`),
  ];
}

/** What only the SDK may define: each entry names one piece of the payment core. */
export const FORBIDDEN = [
  ...definitions(GUARDS).map((re) => ["guard function", re]),
  ["refusal code table", /\bREFUSAL_CODES\b(?::[^=;]{0,200})?=(?!=)/],
  ["refusal code", new RegExp(`${Q}?\\bG(?:[1-9]|1[0-2])_[A-Z_]+${Q}?:${Q}G(?:[1-9]|1[0-2])${Q}`)],
  ...definitions(BUILDERS).map((re) => ["voucher builder", re]),
  ["EIP-712 domain name", new RegExp(`${Q}(?:Assay Settlement|GoAssay Agent Binding)${Q}`)],
  ["EIP-712 type", new RegExp(`\\bname${Q}?:${Q}(?:resourceHash|requestHash|expiresAt|credentialId)${Q},${Q}?type${Q}?:`)],
  ["EIP-712 type", new RegExp(`\\btype${Q}?:${Q}\\w+${Q},${Q}?name${Q}?:${Q}(?:resourceHash|requestHash|expiresAt|credentialId)${Q}`)],
  ["EIP-712 primary type", new RegExp(`\\bprimaryType${Q}?:${Q}(?:Voucher|DelegateBinding)${Q}`)],
  ["EIP-712 type table", /\b(?:VOUCHER_TYPES|DELEGATE_BINDING_TYPES)\b(?::[^=;]{0,200})?=(?!=)/],
];

/**
 * `text` with all whitespace collapsed, the space next to punctuation removed (a space stays
 * only between two word characters), and adjacent string literals joined (`"a " + "b"`).
 */
export function normalise(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/["'`] ?\+ ?["'`]/g, "")
    .replace(/ (?=[^\w$])|(?<=[^\w$]) /g, "");
}

/** The kinds of forbidden definition in one file's text (each named once). */
export function findForksIn(text) {
  const flat = normalise(text);
  return [...new Set(FORBIDDEN.filter(([, re]) => re.test(flat)).map(([what]) => what))];
}

/** Every source file under `dir`, and every symbolic link (refused, never followed). */
function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isSymbolicLink()) out.links.push(path);
    else if (e.isDirectory()) walk(path, out);
    else if (e.isFile() && SOURCE.test(e.name)) out.files.push(path);
  }
  return out;
}

/** Repo-relative `file: what` for every forbidden definition or symbolic link under `dir`. */
export function findForks(dir, root = dir, skip = []) {
  const { files, links } = walk(dir, { files: [], links: [] });
  const skipped = new Set(skip.map((p) => resolve(root, p)));
  return [
    ...links.map((l) => `${relative(root, l)}: symbolic link (not followed; not allowed here)`),
    ...files
      .filter((f) => !skipped.has(resolve(f)))
      .flatMap((file) => findForksIn(readFileSync(file, "utf8")).map((h) => `${relative(root, file)}: ${h}`)),
  ];
}

/** Every hit under {@link SCAN_DIRS} of `root`, this script excepted. */
export function findForksInRepo(root) {
  return SCAN_DIRS.flatMap((d) => findForks(join(root, d), root, [SELF]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const hits = findForksInRepo(root);
  if (hits.length > 0) {
    console.error("check-no-fork failed: the payment core comes from @goassay-ai/sdk/core, never a local copy:");
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log("check-no-fork: ok");
}
