// Probes the real OS keychain the way `assay-mcp` does at startup, then exits.
// Used by the gated real-keychain tests in node/test/keychain.test.ts.
import { KeychainError, loadOsKeyring, probeKeychain, reportKeychainError } from "../../src/profile/keychain.js";

async function main(): Promise<number> {
  try {
    await probeKeychain(await loadOsKeyring());
    return 0;
  } catch (err) {
    if (err instanceof KeychainError) return reportKeychainError(err);
    return 70;
  }
}

main().then((code) => process.exit(code));
