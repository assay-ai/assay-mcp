// A child process for node/test/proxy.test.ts: the real `serve` over stdio, with the test's
// keyring file instead of the OS keychain, a temporary profile directory, and the e2e origins
// rerouted at the transport (after pinnedFetch's checks) to the local fake AS and fake MCP.
// Every outbound URL is reported to the fake MCP's /__test/fetch. Env (test-only):
// TEST_DIR, TEST_KEYRING, TEST_AS_PORT, TEST_MCP_PORT, TEST_TIMEOUT_MS, TEST_LOCK_TIMEOUT_MS.
import { serve } from "../../src/commands/serve.js";
import { Keychain } from "../../src/profile/keychain.js";
import { FileKeyring } from "../helpers/file-keyring.js";

const env = process.env;
const asPort = Number(env.TEST_AS_PORT);
const mcpPort = Number(env.TEST_MCP_PORT);
const realFetch = globalThis.fetch;
const report = (url: string) => realFetch(`http://127.0.0.1:${mcpPort}/__test/fetch`, { method: "POST", body: url }).then((r) => r.text());

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(input instanceof Request ? input.url : String(input instanceof URL ? input.href : input));
  if (!u.pathname.startsWith("/__test/") && u.hostname !== "127.0.0.1") await report(u.href).catch(() => {});
  if (u.origin === "http://localhost:3200") {
    const port = u.pathname.startsWith("/oauth/") ? asPort : mcpPort;
    return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  }
  if (u.origin === "http://localhost:3000") return realFetch(`http://127.0.0.1:${asPort}${u.pathname}${u.search}`, init);
  return realFetch(input, init);
}) as typeof fetch;

const keyring = new FileKeyring(env.TEST_KEYRING!);
const code = await serve(process.argv.slice(2), {
  configDir: env.TEST_DIR!,
  openKeychain: async () => ({ probe: async () => {}, forScope: (scope) => new Keychain(keyring, scope) }),
  openBrowser: async (url) => (await realFetch(`http://127.0.0.1:${mcpPort}/__test/browser`, { method: "POST", body: url })).ok,
  grantPollMs: 200,
  ...(env.TEST_TIMEOUT_MS ? { requestTimeoutMs: Number(env.TEST_TIMEOUT_MS) } : {}),
  ...(env.TEST_LOCK_TIMEOUT_MS ? { lockOptions: { timeoutMs: Number(env.TEST_LOCK_TIMEOUT_MS) } } : {}),
});
process.exit(code);
