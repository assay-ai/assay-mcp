import pkg from "../package.json" with { type: "json" };

/** The package version, bundled at build time. */
export const VERSION: string = pkg.version;

/**
 * How a user runs this exact package from a terminal: scoped and pinned to the running version,
 * never the unscoped `assay-mcp` name (which belongs to someone else) and never `latest`.
 */
export const RUN = `npx -y @assay-ai/mcp@${VERSION}`;
