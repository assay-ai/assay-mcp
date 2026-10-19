import pkg from "../package.json" with { type: "json" };

/** The package version, bundled at build time. */
export const VERSION: string = pkg.version;
