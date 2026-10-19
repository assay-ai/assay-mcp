#!/usr/bin/env node
// The SDK reuses the proxy's signer and guards through the `@assay-core/*` alias (R-SDK-1).
// Fails when sdk/node/src holds a copy: a `signer` or `guards` directory, any file named for one, or any symlink.
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_DIRS = new Set(["signer", "guards"]);

/** Repo-relative paths under `dir` that are, or sit inside, a forbidden directory. */
export function findForks(dir, root = dir) {
  const hits = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    // A symlink could point at a copy (or at the proxy's own folder under another name): refused.
    if (e.isSymbolicLink()) hits.push(relative(root, path));
    else if (e.isDirectory()) {
      if (FORBIDDEN_DIRS.has(e.name.toLowerCase())) hits.push(relative(root, path));
      else hits.push(...findForks(path, root));
    } else if (/^(signer|guards)(\.[^.]+)*\.[cm]?[jt]s$/i.test(e.name)) {
      hits.push(relative(root, path));
    }
  }
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const hits = findForks(join(root, "sdk/node/src"), root);
  if (hits.length > 0) {
    console.error("check-no-fork failed: the SDK must import the proxy's signer and guards through @assay-core, not copy them:");
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log("check-no-fork: ok");
}
