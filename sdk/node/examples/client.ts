import { AssayClient, Signers } from "../src/index.js";

/** Reads a required variable, or stops with a clear message (no stack trace, no value shown). */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set. See sdk/node/README.md ("Running the examples").`);
    process.exit(2);
  }
  return value;
}

/**
 * The client the examples share.
 * - `ASSAY_API_KEY`: required.
 * - `ASSAY_URL`: default `https://mcp.assay.ai/`.
 * - `ASSAY_DEV_ORIGIN`: a development origin (for example the local stack); it goes to `dev.origins`.
 * - `ASSAY_EXAMPLE_TEST_KEY`: a throwaway payment key for a test stack. It turns paid calls on
 *   through `Signers.fromPrivateKey`, which is for tests only: in production use `Signers.fromAccount`.
 * Nothing here prints a key.
 */
export function clientFromEnv(): AssayClient {
  const testKey = process.env.ASSAY_EXAMPLE_TEST_KEY?.trim();
  const devOrigin = process.env.ASSAY_DEV_ORIGIN?.trim();
  return new AssayClient({
    url: process.env.ASSAY_URL?.trim() || "https://mcp.assay.ai/",
    apiKey: requireEnv("ASSAY_API_KEY"),
    ...(devOrigin ? { dev: { origins: [devOrigin] } } : {}),
    ...(testKey ? { signer: Signers.fromPrivateKey(testKey as `0x${string}`), maxPerCall: "0.50", maxPerDay: "5" } : {}),
  });
}
