import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const core = fileURLToPath(new URL("../../node/src/", import.meta.url));

export default defineConfig({
  resolve: { alias: [{ find: /^@assay-core\//, replacement: core }] },
  test: {
    // The same guards as the proxy's suite: a temporary home per file, and a check that the
    // real profile directory was not touched. Plus: the real OS keychain is never reachable.
    globalSetup: ["../../node/test/setup/global-guard.ts"],
    setupFiles: ["../../node/test/setup/temp-home.ts", "test/setup/no-os-keychain.ts"],
  },
});
