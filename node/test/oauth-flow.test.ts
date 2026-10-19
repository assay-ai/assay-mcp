import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "../src/log/logger.js";
import { apiKey, ApiKeyError, authMode } from "../src/oauth/api-key.js";
import { clientIdOf, issuerOf } from "../src/oauth/endpoints.js";
import { authorizeUrl, browserCommand, codeFrom, deviceLabel, openBrowser, pkcePair, signIn, SignInError, type ExecFile } from "../src/oauth/flow.js";
import { LOOPBACK_TIMEOUT_MS, PAGES, startLoopback } from "../src/oauth/loopback.js";
import { currentAccess, refreshUnderLock, RefreshError, revoke, type TokenContext } from "../src/oauth/tokens.js";
import { resolveDeployment, type ResolvedDeployment } from "../src/profile/deployments.js";
import { Keychain } from "../src/profile/keychain.js";
import { LockError, withLock } from "../src/profile/lock.js";
import { readProfile } from "../src/profile/profile.js";
import { bundleFixture } from "./helpers/bundle.js";
import { CLIENT_ID, E2E_MCP, FakeAs, rerouteFetch } from "./helpers/fake-as.js";
import { FileKeyring } from "./helpers/file-keyring.js";
import { MemoryKeyring } from "./helpers/memory-keyring.js";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = 1_800_000_000;
const SECRET_RE = /assay_(at|rt|ac)_/;

let as: FakeAs;
let base: string;
let deployment: ResolvedDeployment;
let keyring: MemoryKeyring;
let keychain: Keychain;
let logLines: string[];
let log: Logger;
const realFetch = globalThis.fetch;
const profile = () => ({ dir: base, name: "default" });

function ctx(overrides: Partial<TokenContext> = {}): TokenContext {
  return { profile: profile(), deployment, keychain, log, nowSeconds: () => as.clock, ...overrides };
}

/** The browser: follows the AS redirect to the loopback, as a real one would. */
function browser(decide: (authorizeUrl: string) => string | Promise<string> = (u) => as.approve(u)) {
  const opened: string[] = [];
  const open = async (url: string) => {
    opened.push(url);
    const target = await decide(url);
    setImmediate(() => void realFetch(target).then((r) => r.text()).catch(() => {}));
    return true;
  };
  return { opened, open };
}

async function seedTokens(pair: { refreshToken: string; accessToken: string; expiresAt: number }) {
  await withLock(profile(), (lock) => keychain.storeTokens(lock, { refreshToken: pair.refreshToken, accessToken: { token: pair.accessToken, expiresAt: pair.expiresAt } }));
}

beforeEach(async () => {
  as = new FakeAs();
  as.clock = NOW;
  await as.start();
  vi.spyOn(globalThis, "fetch").mockImplementation(rerouteFetch(realFetch, as.port));
  base = mkdtempSync(join(tmpdir(), "assay-mcp-oauth-"));
  deployment = resolveDeployment({ url: `${E2E_MCP}/`, env: { ASSAY_MCP_DEV_ORIGINS: E2E_MCP }, devOrigins: [E2E_MCP], warn: () => {} });
  keyring = new MemoryKeyring();
  keychain = new Keychain(keyring, { profile: "default", environment: deployment.environment });
  logLines = [];
  log = createLogger({ level: "debug", stderr: (l) => logLines.push(l), file: null });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await as.stop();
  rmSync(base, { recursive: true, force: true });
});

function expectNoSecretsLogged(...extra: string[]) {
  const text = logLines.join("");
  expect(text).not.toMatch(SECRET_RE);
  for (const s of extra) expect(text).not.toContain(s);
}

describe("F1 sign-in", () => {
  it("signs in: PKCE S256, built-in client, loopback redirect, resource, device; tokens and credential stored", async () => {
    const b = browser();
    const links: string[] = [];
    const result = await signIn(profile(), deployment, {}, { keychain, log, onLink: (l) => links.push(l), openBrowser: b.open, hostname: () => "Build-Box-01.local", nowSeconds: () => as.clock });

    expect(links).toEqual(b.opened);
    const q = as.authorizeParams[0]!;
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("client_id")).toBe(clientIdOf(deployment));
    expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("resource")).toBe(E2E_MCP);
    expect(q.get("scope")).toBe("assay:agent offline_access");
    expect(q.get("assay_device")).toBe("Build-Box-01");
    expect(q.get("assay_replaces")).toBeNull();
    expect(q.get("state")!.length).toBeGreaterThanOrEqual(43);

    const exchange = as.tokenCalls("authorization_code");
    expect(exchange).toHaveLength(1);
    expect(exchange[0]!.form!.get("redirect_uri")).toBe(q.get("redirect_uri"));
    expect(exchange[0]!.authorization).toBeUndefined();

    const grant = as.grants[0]!;
    expect(result.credentialId).toBe(grant.credentialId);
    expect(readProfile(profile())!.credentialId).toBe(grant.credentialId);
    expect(await keychain.get("refresh_token")).toMatch(/^assay_rt_/);
    expect((await keychain.getAccessToken())!.expiresAt).toBe(NOW + 3600);
    // Every keychain write carried the lock's signal.
    expect(keyring.writeSignals.length).toBeGreaterThan(0);
    for (const s of keyring.writeSignals) expect(s).toBeInstanceOf(AbortSignal);
    expectNoSecretsLogged(q.get("state")!);
  });

  it("state mismatch callback ignored (flow continues)", async () => {
    const answers: { status: number; body: string }[] = [];
    const b = browser(async (url) => {
      const good = new URL(as.approve(url));
      const bad = new URL(good);
      bad.searchParams.set("state", "x".repeat(43));
      bad.searchParams.set("error", "access_denied");
      bad.searchParams.delete("code");
      const r1 = await realFetch(bad);
      answers.push({ status: r1.status, body: await r1.text() });
      const missing = new URL(good);
      missing.searchParams.delete("state");
      const r2 = await realFetch(missing);
      answers.push({ status: r2.status, body: await r2.text() });
      return good.href;
    });
    const result = await signIn(profile(), deployment, {}, { keychain, log, openBrowser: b.open, nowSeconds: () => as.clock });
    expect(answers.map((a) => a.status)).toEqual([400, 400]);
    for (const a of answers) {
      expect(a.body).toBe(PAGES.invalid);
      expect(a.body).not.toMatch(SECRET_RE);
    }
    expect(result.credentialId).toBe(as.grants[0]!.credentialId);
  });

  it("iss mismatch → refused", async () => {
    const b = browser((url) => {
      const back = new URL(as.approve(url));
      back.searchParams.set("iss", "https://evil.example");
      return back.href;
    });
    const err = await signIn(profile(), deployment, {}, { keychain, log, openBrowser: b.open }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignInError);
    expect((err as SignInError).reason).toBe("refused");
    expect(as.tokenCalls()).toHaveLength(0);
    expect(await keychain.get("refresh_token")).toBeNull();
    // A missing iss is refused too.
    expect(() => codeFrom({ kind: "code", code: "c", iss: null }, issuerOf(deployment))).toThrow(SignInError);
    expect(() => codeFrom({ kind: "code", code: "c", iss: `${E2E_MCP}/` }, issuerOf(deployment))).toThrow(SignInError);
  });

  it("error callback with the right state ends the flow", async () => {
    let redirect = "";
    const b = browser((url) => (redirect = as.approve(url, "deny")));
    const err = await signIn(profile(), deployment, {}, { keychain, log, openBrowser: b.open }).catch((e: unknown) => e);
    expect((err as SignInError).reason).toBe("denied");
    expect(as.tokenCalls()).toHaveLength(0);
    // The listener is closed: the same callback is not answered again.
    await expect(realFetch(redirect)).rejects.toThrow();
  });

  it("browser opened with execFile and the built URL only", async () => {
    const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
    const execFile: ExecFile = (file, args, options, cb) => {
      calls.push({ file, args, options });
      cb(null);
    };
    const { challenge } = pkcePair();
    const link = authorizeUrl(deployment, { redirectUri: "http://127.0.0.1:5000/callback", state: "s".repeat(43), challenge, device: null, replaces: null });
    expect(new URL(link).origin).toBe(E2E_MCP);
    expect(link).not.toMatch(SECRET_RE);

    expect(await openBrowser(deployment, link, { execFile, platform: "darwin" })).toBe(true);
    expect(calls).toEqual([{ file: "open", args: [link], options: { shell: false, windowsHide: true, timeout: 15_000 } }]);
    expect(browserCommand("win32", link)).toEqual({ file: "rundll32", args: ["url.dll,FileProtocolHandler", link] });
    expect(browserCommand("linux", link)).toEqual({ file: "xdg-open", args: [link] });

    // Anything not built from the built-in origins is never launched.
    for (const bad of ["https://evil.example/oauth/authorize", "file:///etc/passwd", "javascript:alert(1)", `http://user:pw@localhost:3200/x`, "not a url"]) {
      expect(await openBrowser(deployment, bad, { execFile, platform: "darwin" })).toBe(false);
    }
    expect(calls).toHaveLength(1);

    // signIn hands the browser exactly the URL it built (and announced), nothing else.
    const b = browser();
    const links: string[] = [];
    await signIn(profile(), deployment, {}, { keychain, log, onLink: (l) => links.push(l), openBrowser: b.open });
    expect(b.opened).toEqual(links);
    expect(new URL(b.opened[0]!).pathname).toBe("/oauth/authorize");
  });

  it("a browser that cannot open still leaves the link (onLink) and the flow waiting", async () => {
    const links: string[] = [];
    const done = signIn(profile(), deployment, {}, {
      keychain,
      log,
      onLink: (l) => links.push(l),
      openBrowser: async () => false,
    });
    await vi.waitFor(() => expect(links).toHaveLength(1));
    // The person opens the printed link by hand.
    await realFetch(as.approve(links[0]!));
    const result = await done;
    expect(result.credentialId).toBe(as.grants[0]!.credentialId);
  });

  it("F5: a profile with a credential signs in again with assay_replaces; the delegate key is kept", async () => {
    await signIn(profile(), deployment, {}, { keychain, log, openBrowser: browser().open });
    const first = readProfile(profile())!.credentialId;
    await withLock(profile(), (lock) => keychain.set(lock, "delegate_key", "0x" + "11".repeat(32)));
    await signIn(profile(), deployment, { device: "Laptop‮\u0007 two" }, { keychain, log, openBrowser: browser().open });
    const q = as.authorizeParams[1]!;
    expect(q.get("assay_replaces")).toBe(first);
    expect(q.get("assay_device")).toBe("Laptop two");
    expect(readProfile(profile())!.credentialId).toBe(as.grants[1]!.credentialId);
    expect(await keychain.get("delegate_key")).toBe("0x" + "11".repeat(32));
    expectNoSecretsLogged("11".repeat(32));
  });

  it("device labels are sanitised to 32 printable characters", () => {
    expect(deviceLabel("a".repeat(80))).toHaveLength(32);
    expect(deviceLabel("\u0000‮")).toBeNull();
    expect(deviceLabel("Desk <script>")).toBe("Desk script");
  });
});

describe("loopback listener", () => {
  it("binds 127.0.0.1 only; refuses other paths, methods and hosts; static pages with no-referrer and no-store", async () => {
    const state = "S".repeat(43);
    const lb = await startLoopback({ state });
    try {
      const base = `http://127.0.0.1:${lb.port}`;
      const r404 = await realFetch(`${base}/other?state=${state}&code=c&iss=x`);
      expect(r404.status).toBe(404);
      const post = await realFetch(`${base}/callback?state=${state}&code=c`, { method: "POST" });
      expect(post.status).toBe(404);
      const { request } = await import("node:http");
      const rebound = await new Promise<number>((resolve) => {
        request({ host: "127.0.0.1", port: lb.port, path: `/callback?state=${state}&code=c`, headers: { host: `attacker.example:${lb.port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).end();
      });
      expect(rebound).toBe(404);
      const repeated = await realFetch(`${base}/callback?state=${state}&state=${state}&code=c`);
      expect(repeated.status).toBe(400);

      const ok = await realFetch(`${base}/callback?state=${state}&code=assay_ac_abc&iss=${encodeURIComponent(E2E_MCP)}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(ok.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await ok.text();
      expect(html).toBe(PAGES.done);
      expect(html).not.toContain("assay_ac_abc");
      expect(html).not.toContain(state);
      expect(html).not.toMatch(/src=|href=/);
      expect(await lb.result).toEqual({ kind: "code", code: "assay_ac_abc", iss: E2E_MCP });
      // One callback only: the listener is gone.
      await expect(realFetch(`${base}/callback?state=${state}&code=x`)).rejects.toThrow();
    } finally {
      lb.close();
    }
  });

  it("is not reachable on other interfaces", async () => {
    const lb = await startLoopback({ state: "S".repeat(43) });
    try {
      await expect(realFetch(`http://[::1]:${lb.port}/callback`)).rejects.toThrow();
    } finally {
      lb.close();
    }
  });

  it("tries another port when one is busy", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const busy = (blocker.address() as { port: number }).port;
    const lb = await startLoopback({ state: "S".repeat(43), ports: [busy, 0] });
    try {
      expect(lb.port).not.toBe(busy);
      expect(lb.redirectUri).toBe(`http://127.0.0.1:${lb.port}/callback`);
    } finally {
      lb.close();
      await new Promise((r) => blocker.close(r));
    }
  });

  it("callback server closes after 5 min", async () => {
    expect(LOOPBACK_TIMEOUT_MS).toBe(300_000);
    const { connect } = await import("node:net");
    const reachable = (port: number) =>
      new Promise<boolean>((resolve) => {
        const s = connect(port, "127.0.0.1");
        s.once("connect", () => (s.destroy(), resolve(true)));
        s.once("error", () => resolve(false));
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const lb = await startLoopback({ state: "S".repeat(43) });
    let outcome: string | null = null;
    lb.result.then(
      () => (outcome = "resolved"),
      (e: { reason?: string }) => (outcome = e.reason ?? "error"),
    );
    vi.advanceTimersByTime(LOOPBACK_TIMEOUT_MS - 1);
    await new Promise((r) => setImmediate(r));
    expect(outcome).toBeNull();
    expect(await reachable(lb.port)).toBe(true);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));
    expect(outcome).toBe("timeout");
    await new Promise((r) => setTimeout(r, 20));
    expect(await reachable(lb.port)).toBe(false);
  });
});

describe("tokens (F2, §8.4)", () => {
  it("currentAccess returns the stored token while usable, without any request", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    expect(await currentAccess(ctx())).toBe(pair.accessToken);
    expect(as.requests).toHaveLength(0);
  });

  it("an expired access token is refreshed under the lock and the new pair stored", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    as.clock = pair.expiresAt;
    const fresh = await currentAccess(ctx());
    expect(fresh).toMatch(/^assay_at_/);
    expect(fresh).not.toBe(pair.accessToken);
    expect(await keychain.get("refresh_token")).not.toBe(pair.refreshToken);
    const call = as.tokenCalls("refresh_token")[0]!;
    expect(call.form!.get("client_id")).toBe(CLIENT_ID);
    expect(call.authorization).toBeUndefined();
    expectNoSecretsLogged();
  });

  it("another process already refreshed: the stored token differs from the failed one and is used", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    expect(await refreshUnderLock(ctx(), "assay_at_somethingthatfailed00000000000")).toBe(pair.accessToken);
    expect(as.requests).toHaveLength(0);
  });

  it("10 processes hit 401 → exactly one /oauth/token call", async () => {
    const keyringFile = join(base, "keyring.json");
    const shared = new Keychain(new FileKeyring(keyringFile), { profile: "default", environment: deployment.environment });
    const pair = as.seedGrant();
    await withLock(profile(), (lock) => shared.storeTokens(lock, { refreshToken: pair.refreshToken, accessToken: { token: pair.accessToken, expiresAt: pair.expiresAt } }));
    as.tokenDelayMs = 300;

    const bundle = await bundleFixture(join(here, "fixtures/refresh-child.ts"));
    const children: ChildProcess[] = [];
    try {
      const ready: Promise<void>[] = [];
      const results: Promise<{ token?: string | null; error?: string }>[] = [];
      for (let i = 0; i < 10; i++) {
        const child = fork(bundle.file, [base, keyringFile, String(as.port), pair.accessToken], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
        children.push(child);
        ready.push(new Promise((r) => child.once("message", () => r())));
        results.push(
          new Promise((resolve) =>
            child.on("message", (m) => {
              if (typeof m === "object" && m !== null) resolve(m as { token?: string | null });
            }),
          ),
        );
      }
      await Promise.all(ready);
      for (const c of children) c.send("go");
      const answers = await Promise.all(results);
      expect(as.tokenCalls("refresh_token")).toHaveLength(1);
      const tokens = new Set(answers.map((a) => a.token));
      expect(tokens.size).toBe(1);
      const [token] = [...tokens];
      expect(token).toMatch(/^assay_at_/);
      expect(token).not.toBe(pair.accessToken);
      expect((await shared.getAccessToken())!.token).toBe(token);
    } finally {
      for (const c of children) c.kill();
      rmSync(bundle.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("invalid_grant → tokens deleted, key kept, mode pre-sign-in; the next sign-in replaces the old credential (F5)", async () => {
    await signIn(profile(), deployment, {}, { keychain, log, openBrowser: browser().open, nowSeconds: () => as.clock });
    const oldCredential = readProfile(profile())!.credentialId;
    await withLock(profile(), (lock) => keychain.set(lock, "delegate_key", "0x" + "22".repeat(32)));
    expect(await authMode(ctx(), {})).toBe("oauth");
    for (const g of as.grants) g.revoked = true; // revoked from the UI (F3)

    const failed = (await keychain.getAccessToken())!.token;
    expect(await refreshUnderLock(ctx(), failed)).toBeNull();
    expect(await keychain.get("refresh_token")).toBeNull();
    expect(await keychain.getAccessToken()).toBeNull();
    expect(await keychain.get("delegate_key")).toBe("0x" + "22".repeat(32));
    expect(await authMode(ctx(), {})).toBe("pre-sign-in");
    expect(await currentAccess(ctx())).toBeNull();
    expect(readProfile(profile())!.credentialId).toBe(oldCredential);

    await signIn(profile(), deployment, {}, { keychain, log, openBrowser: browser().open, nowSeconds: () => as.clock });
    expect(as.authorizeParams[1]!.get("assay_replaces")).toBe(oldCredential);
  });

  it("refresh-token reuse after the grace window revokes the grant: the stale holder is signed out", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    // A copy of the old pair elsewhere (or a process that died after rotating) …
    as.clock = pair.expiresAt;
    const fresh = await refreshUnderLock(ctx(), pair.accessToken);
    expect(as.use(fresh!)).toBe(true); // … and the new access token is used.
    // The old refresh token comes back after 30 s: the server revokes the whole grant.
    const other = new Keychain(new MemoryKeyring(), { profile: "default", environment: deployment.environment });
    await withLock(profile(), (lock) => other.storeTokens(lock, { refreshToken: pair.refreshToken, accessToken: { token: pair.accessToken, expiresAt: pair.expiresAt } }));
    as.clock += 31;
    expect(await refreshUnderLock(ctx({ keychain: other }), pair.accessToken)).toBeNull();
    expect(as.grants[0]!.revoked).toBe(true);
    // The holder of the newest pair is signed out too, on its next refresh.
    as.clock += 3600;
    expect(await currentAccess(ctx())).toBeNull();
    expect(await keychain.get("refresh_token")).toBeNull();
  });

  it("a late refresh answer (lock lost) is dropped; the next run gets the grace pair and stores one generation", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    as.clock = pair.expiresAt;
    let release!: () => void;
    as.tokenGate = new Promise((r) => (release = r));
    let wall = Date.now();
    const lockOptions = { now: () => wall };
    const pending = refreshUnderLock(ctx({ lockOptions }), pair.accessToken);
    await vi.waitFor(() => expect(as.tokenCalls("refresh_token")).toHaveLength(1));
    wall += 16_000; // a stall: the lock is no longer fresh
    keyring.writeSignals.length = 0;
    release();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockError);
    expect((err as LockError).code).toBe("LOCK_LOST");
    expect(keyring.writeSignals).toHaveLength(0); // nothing was written
    expect(await keychain.get("refresh_token")).toBe(pair.refreshToken);
    expect((await keychain.getAccessToken())!.token).toBe(pair.accessToken);

    // The next run (within 30 s) sends the same refresh token and gets the same pair.
    as.tokenGate = null;
    as.clock += 10;
    const token = await refreshUnderLock(ctx(), pair.accessToken);
    expect(as.tokenCalls("refresh_token")).toHaveLength(2);
    const stored = (await keychain.getAccessToken())!.token;
    expect(stored).toBe(token);
    expect(as.grants[0]!.revoked).toBe(false);
  });

  it("a keychain write that finishes after the lock is lost is not reported as stored", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    as.clock = pair.expiresAt;
    let wall = Date.now();
    keyring.beforeWrite = async () => {
      wall += 16_000;
    };
    const err = await refreshUnderLock(ctx({ lockOptions: { now: () => wall } }), pair.accessToken).catch((e: unknown) => e);
    expect((err as LockError).code).toBe("LOCK_LOST");
  });

  it("503 temporarily_unavailable and network failures keep the tokens", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    as.clock = pair.expiresAt;
    as.forceTokenError = { status: 503, error: "temporarily_unavailable" };
    await expect(refreshUnderLock(ctx(), pair.accessToken)).rejects.toBeInstanceOf(RefreshError);
    expect(await keychain.get("refresh_token")).toBe(pair.refreshToken);
    as.forceTokenError = null;
    await as.stop();
    await expect(refreshUnderLock(ctx(), pair.accessToken)).rejects.toBeInstanceOf(RefreshError);
    expect(await keychain.get("refresh_token")).toBe(pair.refreshToken);
  });

  it("revoke sends the refresh token to {mcp}/oauth/revoke only", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    await withLock(profile(), (lock) => keychain.set(lock, "delegate_key", "0x" + "33".repeat(32)));
    expect(await revoke(ctx())).toEqual({ revoked: true });
    expect(as.requests).toHaveLength(1);
    const [r] = as.requests;
    expect(r!.method).toBe("POST");
    expect(r!.path).toBe("/oauth/revoke");
    expect(r!.form!.get("token")).toBe(pair.refreshToken);
    expect(r!.form!.get("token_type_hint")).toBe("refresh_token");
    expect(r!.form!.get("client_id")).toBe(CLIENT_ID);
    expect(r!.authorization).toBeUndefined();
    expect([...r!.form!.values()].join(" ")).not.toContain(pair.accessToken);
    expect(as.grants[0]!.revoked).toBe(true);
    expect(await keychain.get("refresh_token")).toBeNull();
    expect(await keychain.getAccessToken()).toBeNull();
    expect(await keychain.get("delegate_key")).toBe("0x" + "33".repeat(32));
    expectNoSecretsLogged();
  });
});

describe("API-key mode", () => {
  const key = `assay_sk_live_${"A".repeat(40)}`;
  it("reads ASSAY_API_KEY outside dev mode and ASSAY_DEV_API_KEY in dev mode only", () => {
    expect(apiKey({ dev: false }, { ASSAY_API_KEY: key })).toBe(key);
    expect(apiKey({ dev: true }, { ASSAY_API_KEY: key })).toBeNull();
    expect(apiKey({ dev: true }, { ASSAY_DEV_API_KEY: key })).toBe(key);
    expect(apiKey({ dev: false }, {})).toBeNull();
    expect(() => apiKey({ dev: false }, { ASSAY_API_KEY: "x402_sk_live_old" })).toThrow(ApiKeyError);
    expect(() => apiKey({ dev: false }, { ASSAY_API_KEY: `${key} extra` })).toThrow(ApiKeyError);
  });

  it("an env key wins over a stored grant", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    expect(await authMode(ctx(), { ASSAY_DEV_API_KEY: key })).toBe("api-key");
    expect(await authMode(ctx(), {})).toBe("oauth");
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});
