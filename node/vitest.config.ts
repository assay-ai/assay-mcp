import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/setup/global-guard.ts"],
    setupFiles: ["test/setup/temp-home.ts"],
  },
});
