#!/usr/bin/env node
// Fails when any tracked (or new, not ignored) file contains the unscoped install form.
// The only install form is the scoped, exactly pinned `@goassay-ai/mcp@V` (R-MCP-14).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Built from parts so that this file does not match itself.
export const FORBIDDEN = ["npx", "-y", "assay-mcp"].join(" ");

/** True when the text runs the unscoped package through npx, pnpm dlx, yarn dlx or bunx. */
export function containsUnscoped(text) {
  return /(?:npx(?:\s+(?:-y|--yes))?|pnpm\s+dlx|yarn\s+dlx|bunx)\s+assay-mcp(?![\w-])/.test(text);
}

const SUBCOMMANDS = "serve|login|logout|status|doctor|limits|settings|enable-paid|allow-paid|disallow-paid|add|remove|list|dev|paid-urls|measure-tools";

/**
 * True when the text writes a bare `assay-mcp <subcommand>` (T11): the unscoped name belongs to a
 * third party, so a user who types it runs a stranger's code. Allowed: the bin name in package.json
 * (not a command line) and identifiers such as `assay-mcp/refused` or `assay-mcp-cmd-`, which are
 * not followed by a space and a subcommand. Written scoped it is `@goassay-ai/mcp@V <cmd>`.
 */
export function containsBareCommand(text) {
  return new RegExp(String.raw`(?<![@/\w.-])assay-mcp\s+(?:(?:${SUBCOMMANDS})(?![\w-])|--[a-z]|<|\[)`).test(text);
}

/** Source files: comment-only lines are internal notes, not user-facing text, so they are not scanned. */
export function withoutComments(file, text) {
  if (!/\.(?:[cm]?[jt]s)$/.test(file)) return text;
  return text.split("\n").filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join("\n");
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
    if (containsUnscoped(text) || (!file.endsWith("package.json") && !file.endsWith("package-lock.json") && containsBareCommand(withoutComments(file, text)))) hits.push(file);
  }
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const hits = findUnscoped(root);
  if (hits.length > 0) {
    console.error(`These files contain "${FORBIDDEN}"; use the pinned "@goassay-ai/mcp@<version>" form:`);
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log("check-no-unscoped: ok");
}
