// A child process for node/test/integration/equivalence.test.ts: the real `serve` over stdio
// against a REAL Assay backend (the e2e deployment entry, dev mode), with the test's keyring
// file instead of the OS keychain and a temporary profile directory. Nothing is faked on the
// way to the backend; the only transport change is an optional reroute (TEST_REROUTE, a JSON
// map of origin → origin, applied after pinnedFetch's checks) for a backend or an anvil fork on
// other ports. The browser is a file: every URL the proxy would open is appended to
// TEST_BROWSER_LOG. Env (test-only): TEST_DIR, TEST_KEYRING, TEST_BROWSER_LOG, TEST_REROUTE,
// TEST_POLL_MS, and ASSAY_DEV_API_KEY for API-key mode.
import { appendFileSync } from "node:fs";
import { serve } from "../../src/commands/serve.js";
import { Keychain } from "../../src/profile/keychain.js";
import { FileKeyring } from "../helpers/file-keyring.js";

const env = process.env;
const reroute = JSON.parse(env.TEST_REROUTE ?? "{}") as Record<string, string>;
const realFetch = globalThis.fetch;

if (Object.keys(reroute).length > 0) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input instanceof URL ? input.href : input));
    const target = reroute[u.origin];
    if (target === undefined) return realFetch(input, init);
    return realFetch(`${target}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
}

const keyring = new FileKeyring(env.TEST_KEYRING!);
const code = await serve(process.argv.slice(2), {
  configDir: env.TEST_DIR!,
  env: { ASSAY_MCP_DEV_ORIGINS: env.ASSAY_MCP_DEV_ORIGINS, ASSAY_DEV_API_KEY: env.ASSAY_DEV_API_KEY },
  openKeychain: async () => ({ probe: async () => {}, forScope: (scope) => new Keychain(keyring, scope) }),
  openBrowser: async (url) => {
    appendFileSync(env.TEST_BROWSER_LOG!, `${url}\n`);
    return true;
  },
  ...(env.TEST_POLL_MS ? { paidPollMs: Number(env.TEST_POLL_MS) } : {}),
});
process.exit(code);
