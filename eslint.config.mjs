import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**"] },
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
    // `*.internal.*` signer modules (fixture doors, unbranded builders) stay inside the signer.
    files: ["node/src/**/*.ts"],
    ignores: ["node/src/signer/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)[^/]*\\.internal(\\.[cm]?[jt]s)?$",
              message: "Signer internals may be imported only from inside src/signer.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
);
