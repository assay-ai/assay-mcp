#!/usr/bin/env node
// Fails when any tracked (or new, not ignored) file contains the unscoped install form.
// The only install form is the scoped, exactly pinned `@assay-ai/mcp@V` (R-MCP-14).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Built from parts so that this file does not match itself.
export const FORBIDDEN = ["npx", "-y", "assay-mcp"].join(" ");

/** True when the text contains the forbidden form, at any whitespace between the words. */
export function containsUnscoped(text) {
  return /npx\s+-y\s+assay-mcp(?![\w-])/.test(text);
}

export function listRepoFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

/** Returns the repo-relative paths that contain the forbidden form. */
export function findUnscoped(root) {
  const hits = [];
  for (const file of listRepoFiles(root)) {
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    if (containsUnscoped(text)) hits.push(file);
  }
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const hits = findUnscoped(root);
  if (hits.length > 0) {
    console.error(`These files contain "${FORBIDDEN}"; use the pinned "@assay-ai/mcp@<version>" form:`);
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log("check-no-unscoped: ok");
}
