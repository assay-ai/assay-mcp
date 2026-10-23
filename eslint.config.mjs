import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.test-fixture-*/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    // Only `serve` may write to stdout, and only MCP JSON-RPC (R-MCP-3).
    files: ["node/src/**/*.ts"],
    rules: { "no-console": "error" },
  },
  {
    // Every voucher goes through node/src/guards/sign.ts, which always passes the proxy's options
    // (G11, its G4 text, its built-in networks). The SDK's entry points that take them from the
    // caller, and the SDK client with its own network table, stay out of reach elsewhere.
    files: ["node/src/**/*.ts"],
    ignores: ["node/src/guards/sign.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@goassay-ai/sdk/core",
              importNames: ["guardAndBuild", "buildVoucher", "checkAll", "networkEntriesFrom", "eip155Networks"],
              message: "Build and guard vouchers only through node/src/guards/sign.ts.",
            },
          ],
          patterns: [{ regex: "^@goassay-ai/sdk(?!/core$)", message: "Import the SDK's payment core only (@goassay-ai/sdk/core)." }],
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
);
