// A child process for node/test/oauth-flow.test.ts: one assay-mcp process whose call got a
// 401. Bundled with esbuild by the test and forked. argv: <dir> <keyringFile> <asPort> <failedToken>
import { Keychain } from "../../src/profile/keychain.js";
import { resolveDeployment } from "../../src/profile/deployments.js";
import { refreshUnderLock } from "../../src/oauth/tokens.js";
import { FileKeyring } from "../helpers/file-keyring.js";
import { E2E_MCP, rerouteFetch } from "../helpers/fake-as.js";

const [dir, keyringFile, port, failed] = process.argv.slice(2) as [string, string, string, string];
globalThis.fetch = rerouteFetch(globalThis.fetch, Number(port));

const deployment = resolveDeployment({ url: `${E2E_MCP}/`, env: { ASSAY_MCP_DEV_ORIGINS: E2E_MCP }, devOrigins: [E2E_MCP], warn: () => {} });
const keychain = new Keychain(new FileKeyring(keyringFile), { profile: "default", environment: deployment.environment });

process.on("message", (m) => {
  if (m !== "go") return;
  // Ten children queue for the one lock; a slow (Windows) runner can take longer than the 30 s
  // default to serve them all, so the wait gets more room here.
  refreshUnderLock({ profile: { dir, name: "default" }, deployment, keychain, nowSeconds: () => 1_800_000_000, lockOptions: { timeoutMs: 90_000 } }, failed).then(
    (token) => {
      process.send?.({ token });
      process.exit(0);
    },
    (err: unknown) => {
      process.send?.({ error: err instanceof Error ? err.name : "error" });
      process.exit(3);
    },
  );
});
process.send?.("ready");
