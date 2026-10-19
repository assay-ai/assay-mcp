// A child process for node/test/paid.test.ts: the real `serve` over stdio in API-key mode (dev
// mode, e2e entry), with the test's keyring file instead of the OS keychain and a temporary
// profile directory. The e2e MCP and API origins and the e2e RPC are rerouted at the transport
// (after pinnedFetch's checks) to the local fake Assay; every outbound URL is reported to its
// /__test/fetch. Env (test-only): TEST_DIR, TEST_KEYRING, TEST_PORT, TEST_POLL_MS, TEST_LOCK_TIMEOUT_MS.
import { serve } from "../../src/commands/serve.js";
import { builtInDeployments } from "../../src/deployments.js";
import { Keychain } from "../../src/profile/keychain.js";
import { FileKeyring } from "../helpers/file-keyring.js";

const env = process.env;
const port = Number(env.TEST_PORT);
const realFetch = globalThis.fetch;
const fake = `http://127.0.0.1:${port}`;
const rpcOrigins = new Set(builtInDeployments().e2e.networks["eip155:46630"]!.rpc.map((r) => new URL(r).origin));

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(input instanceof Request ? input.url : String(input instanceof URL ? input.href : input));
  if (u.origin !== fake) await realFetch(`${fake}/__test/fetch`, { method: "POST", body: u.href }).then((r) => r.text()).catch(() => {});
  if (u.origin === "http://localhost:3200" || u.origin === "http://localhost:3000") return realFetch(`${fake}${u.pathname}${u.search}`, init);
  if (rpcOrigins.has(u.origin)) return realFetch(`${fake}/__rpc`, init);
  if (u.origin === fake) return realFetch(input, init);
  throw new TypeError("no network in tests");
}) as typeof fetch;

const keyring = new FileKeyring(env.TEST_KEYRING!);
const code = await serve(process.argv.slice(2), {
  configDir: env.TEST_DIR!,
  env: { ASSAY_MCP_DEV_ORIGINS: env.ASSAY_MCP_DEV_ORIGINS, ASSAY_DEV_API_KEY: env.ASSAY_DEV_API_KEY },
  openKeychain: async () => ({ probe: async () => {}, forScope: (scope) => new Keychain(keyring, scope) }),
  openBrowser: async (url) => (await realFetch(`${fake}/__test/browser`, { method: "POST", body: url })).ok,
  grantPollMs: 200,
  ...(env.TEST_POLL_MS ? { paidPollMs: Number(env.TEST_POLL_MS) } : {}),
  ...(env.TEST_LOCK_TIMEOUT_MS ? { lockOptions: { timeoutMs: Number(env.TEST_LOCK_TIMEOUT_MS) } } : {}),
});
process.exit(code);
