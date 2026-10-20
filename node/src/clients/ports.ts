/**
 * The narrow interfaces `add`, `list` and `remove` run against. `commands/wiring.ts` binds them
 * to the URL parser and origin pinning (`profile/mcp-url.ts`, `profile/deployments.ts`), the
 * private `{dir}` files (`profile/paths.ts`) and the profile store and lock (`profile/profile.ts`,
 * `profile/lock.ts`); tests bind them to temp directories and fakes.
 */
import type { Environment } from "../deployments.js";
import type { UrlKind } from "./server-name.js";

/** A `--url` after the server URL parser accepted and canonicalised it. */
export interface ResolvedUrl {
  /** The canonical absolute URL, e.g. `https://mcp.assay.ai/c/weather`. */
  url: string;
  /** The canonical path and query, e.g. `/c/weather` (the `paid-urls.json` form). */
  pathAndQuery: string;
  kind: UrlKind;
  /** Words of the default name's `{slug}` (spec 8.3.1); empty gives `assay`. */
  slugWords: string[];
  /** True when the origin is a dev origin (dev mode), not the built-in production MCP origin. */
  dev: boolean;
  /** The built-in deployment the URL selected. */
  environment: Environment;
}

export class UrlRefused extends Error {
  override readonly name = "UrlRefused";
}

/** Parses and canonicalises `<url|/path>`; throws `UrlRefused` for any URL the server would not accept or another origin. */
export type UrlResolver = (input: string) => ResolvedUrl;

export interface ProfilePort {
  isValidName(name: string): boolean;
  /** True when `profiles/{name}.json` exists. */
  exists(name: string): boolean;
  /** True when the URL is already in `paid-urls.json` (the `/` a profile starts with included). */
  isPaidUrl(profile: string, url: ResolvedUrl): boolean;
  /** Adds the URL to `paid-urls.json` under the profile lock (TTY only, after the typed confirmation; the caller checks). */
  addPaidUrl(profile: string, url: ResolvedUrl): Promise<void>;
  /** L(u) from `tools/list` on the URL with the profile's token; null when not signed in. */
  longestTool(profile: string, url: ResolvedUrl): Promise<number | null>;
}

/** Files in `{dir}`: regular 0600 files owned by the user in a 0700 directory, never through a symlink. */
export interface PrivateFiles {
  read(rel: string): string | null;
  write(rel: string, data: string): void;
}

/** The structural shape of Task 2.4's `McpPath` and `ViewFilter`, enough to pick the default name's slug. */
export type PathShape =
  | { kind: "ROOT" }
  | { kind: "MY_TOOLSET"; slug: string }
  | { kind: "CATEGORY"; category: string }
  | { kind: "HANDLE"; handle: string }
  | { kind: "PUBLIC_TOOLSET"; slug: string }
  | { kind: "UNLISTED_TOOLSET" };

export interface FilterShape {
  tools: readonly { name: string }[] | null;
}

function words(text: string): string[] {
  return text.split(/[-_]/).filter(Boolean);
}

/**
 * `{slug}` of the default name (spec 8.3.1, 9.3): the category, tool set slug or handle; for the
 * root with `?tools=`, the first tool's first word; none for an unlisted token (its slug is not in
 * the URL) or the plain root.
 */
export function slugWordsFor(path: PathShape, filter: FilterShape): string[] {
  switch (path.kind) {
    case "ROOT": {
      const first = filter.tools?.[0]?.name;
      return first ? words(first).slice(0, 1) : [];
    }
    case "MY_TOOLSET":
    case "PUBLIC_TOOLSET":
      return words(path.slug);
    case "CATEGORY":
      return words(path.category);
    case "HANDLE":
      return words(path.handle);
    case "UNLISTED_TOOLSET":
      return [];
  }
}
