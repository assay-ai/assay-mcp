import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/setup/global-guard.ts"],
    setupFiles: ["test/setup/temp-home.ts"],
    // Windows CI runners are slow: tests with several real round trips took 5-7 s there.
    testTimeout: process.platform === "win32" ? 20_000 : 5_000,
  },
});
