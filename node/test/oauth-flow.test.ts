import { fork, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "../src/log/logger.js";
import { apiKey, ApiKeyError, authMode } from "../src/oauth/api-key.js";
import { clientIdOf, issuerOf } from "../src/oauth/endpoints.js";
import { authorizeUrl, browserCommand, codeFrom, deviceLabel, displayAgentLabel, openBrowser, pkcePair, signIn, SignInError, type ExecFile } from "../src/oauth/flow.js";
import { LOOPBACK_TIMEOUT_MS, PAGES, startLoopback } from "../src/oauth/loopback.js";
import { currentAccess, refreshUnderLock, RefreshError, revoke, type TokenContext } from "../src/oauth/tokens.js";
import { MAX_BODY_BYTES, MIN_EXPIRES_IN, readCapped, REQUEST_TIMEOUT_MS } from "../src/oauth/endpoints.js";
import { resolveDeployment, type ResolvedDeployment } from "../src/profile/deployments.js";
import { Keychain } from "../src/profile/keychain.js";
import { LockError, withLock } from "../src/profile/lock.js";
import { readProfile } from "../src/profile/profile.js";
import { claimMarker, readMarker } from "../src/oauth/signin-marker.js";
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
    expect(readProfile(profile())!.agentLabel).toBe("research-bot");
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

    const env = { PATH: "/project/bin:.", BROWSER: "/project/evil", HOME: "/home/user" };
    const everywhere = () => true;
    expect(await openBrowser(deployment, link, { execFile, platform: "darwin", env, exists: everywhere, cwd: "/profile/dir" })).toBe(true);
    expect(calls).toEqual([
      {
        file: "/usr/bin/open",
        args: [link],
        options: { shell: false, windowsHide: true, timeout: 15_000, cwd: "/profile/dir", env: { PATH: "/project/bin:.", HOME: "/home/user" } },
      },
    ]);
    // xdg-open: PATH=/usr/bin:/bin and the desktop-session variables only; cwd defaults to home.
    calls.length = 0;
    const linuxEnv = { PATH: "/project/bin:.", BROWSER: "/project/evil", DISPLAY: ":0", LD_PRELOAD: "/project/x.so", HOME: "/home/user" };
    expect(await openBrowser(deployment, link, { execFile, platform: "linux", env: linuxEnv, exists: everywhere })).toBe(true);
    expect(calls[0]).toEqual({
      file: "/usr/bin/xdg-open",
      args: [link],
      options: { shell: false, windowsHide: true, timeout: 15_000, cwd: userInfo().homedir, env: { PATH: "/usr/bin:/bin", HOME: "/home/user", DISPLAY: ":0" } },
    });
    calls.length = 1;

    // Anything not built from the built-in origins is never launched.
    for (const bad of ["https://evil.example/oauth/authorize", "file:///etc/passwd", "javascript:alert(1)", `http://user:pw@localhost:3200/x`, "not a url"]) {
      expect(await openBrowser(deployment, bad, { execFile, platform: "darwin", exists: everywhere })).toBe(false);
    }
    expect(calls).toHaveLength(1);

    // signIn hands the browser exactly the URL it built (and announced), nothing else.
    const b = browser();
    const links: string[] = [];
    await signIn(profile(), deployment, {}, { keychain, log, onLink: (l) => links.push(l), openBrowser: b.open });
    expect(b.opened).toEqual(links);
    expect(new URL(b.opened[0]!).pathname).toBe("/oauth/authorize");
  });

  it("the launcher is an absolute path, never found through PATH or the cwd", async () => {
    const link = `${E2E_MCP}/oauth/authorize?x=1`;
    const has = (...paths: string[]) => (p: string) => paths.includes(p);
    const cmd = (platform: NodeJS.Platform, env: Record<string, string>, exists: (p: string) => boolean) => browserCommand({ platform, env, exists }, link);
    expect(cmd("darwin", {}, has("/usr/bin/open"))).toEqual({ file: "/usr/bin/open", args: [link] });
    expect(cmd("darwin", {}, has())).toBeNull();
    expect(cmd("linux", {}, has("/usr/local/bin/xdg-open"))).toEqual({ file: "/usr/local/bin/xdg-open", args: [link] });
    expect(cmd("linux", { PATH: "/tmp/repo" }, has("/tmp/repo/xdg-open"))).toBeNull();
    expect(cmd("freebsd", {}, has("/usr/bin/xdg-open"))).toEqual({ file: "/usr/bin/xdg-open", args: [link] });
    const win = "C:\\Windows\\System32\\rundll32.exe";
    expect(cmd("win32", {}, has(win))).toEqual({ file: win, args: ["url.dll,FileProtocolHandler", link] });
    // C:\Windows first; SystemRoot only when that file is missing; windir is never read.
    const d = "D:\\Windows\\System32\\rundll32.exe";
    expect(cmd("win32", { SystemRoot: "D:\\Windows" }, has(d, win))!.file).toBe(win);
    expect(cmd("win32", { SystemRoot: "D:\\Windows" }, has(d))!.file).toBe(d);
    expect(cmd("win32", { windir: "D:\\Windows" }, has(d))).toBeNull();
    // A project config pointing SystemRoot at the repository is ignored.
    for (const root of ["C:\\work\\repo", ".", "\\\\host\\share\\Windows", "D:\\Windows\\..\\repo"]) {
      expect(cmd("win32", { SystemRoot: root }, has(`${root}\\System32\\rundll32.exe`, win))!.file).toBe(win);
    }
    expect(cmd("win32", {}, has())).toBeNull();

    // Windows launch: absolute rundll32 and the profile dir as cwd.
    const calls: { file: string; options: { cwd: string } }[] = [];
    const execFile: ExecFile = (file, _args, options, cb) => {
      calls.push({ file, options });
      cb(null);
    };
    expect(await openBrowser(deployment, link, { execFile, platform: "win32", env: {}, exists: has(win), cwd: "C:\\Users\\u\\AppData\\Roaming\\assay-mcp" })).toBe(true);
    expect(calls[0]!.file).toBe(win);
    expect(calls[0]!.options.cwd).toBe("C:\\Users\\u\\AppData\\Roaming\\assay-mcp");
    // No launcher: nothing runs, the caller prints the link.
    expect(await openBrowser(deployment, link, { execFile, platform: "linux", env: {}, exists: has() })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("a passive sign-in taken over, both links approved: one code exchange, one grant (re-review R1-I1)", async () => {
    const links: string[] = [];
    const passive = signIn(profile(), deployment, { passive: true }, { keychain, log, onLink: (l) => links.push(l), openBrowser: async () => true });
    await vi.waitFor(() => expect(links).toHaveLength(1));
    const active = signIn(profile(), deployment, {}, { keychain, log, onLink: (l) => links.push(l), openBrowser: async () => true });
    await vi.waitFor(() => expect(links).toHaveLength(2));
    await realFetch(as.approve(links[1]!));
    const second = await active;
    expect(second.existing).toBeUndefined();
    await realFetch(as.approve(links[0]!));
    const first = await passive;
    expect(first.existing).toBe(true);
    expect(as.tokenCalls("authorization_code")).toHaveLength(1);
    expect(as.grants).toHaveLength(1);
  });

  it("the marker is claimed only under the profile lock (re-review R1-M1)", async () => {
    let release!: () => void;
    const held = withLock(profile(), () => new Promise<void>((r) => (release = r)));
    const links: string[] = [];
    const err = await signIn(profile(), deployment, {}, { keychain, log, onLink: (l) => links.push(l), lockOptions: { timeoutMs: 300 } }).catch((e: unknown) => e);
    release();
    await held;
    expect(err).toBeInstanceOf(LockError);
    expect((err as LockError).code).toBe("LOCK_TIMEOUT");
    expect(links).toEqual([]);
    expect(readMarker(profile())).toBeNull();
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
    await signIn(profile(), deployment, { device: "Laptop‮\u0007 two", force: true }, { keychain, log, openBrowser: browser().open });
    const q = as.authorizeParams[1]!;
    expect(q.get("assay_replaces")).toBe(first);
    expect(q.get("assay_device")).toBe("Laptop two");
    expect(readProfile(profile())!.credentialId).toBe(as.grants[1]!.credentialId);
    expect(await keychain.get("delegate_key")).toBe("0x" + "11".repeat(32));
    expectNoSecretsLogged("11".repeat(32));
  });

  it("the agent label comes from the server, printable only; a missing or unusable one falls back to \"agent\"", async () => {
    expect(displayAgentLabel("  research-bot  ")).toBe("research-bot");
    expect(displayAgentLabel("evil\u001b[2Jbot\u202e")).toBe("evil[2Jbot");
    expect(displayAgentLabel("\u0007\n ")).toBeNull();
    expect(displayAgentLabel(42)).toBeNull();
    expect(displayAgentLabel("x".repeat(200))).toHaveLength(128);

    as.agentLabel = "\u001b]0;pwned\u0007";
    await signIn(profile(), deployment, {}, { keychain, log, openBrowser: browser().open, nowSeconds: () => as.clock });
    expect(readProfile(profile())!.agentLabel).toBe("]0;pwned");

    // No usable label: an existing profile keeps its label, a new one gets "agent".
    as.agentLabel = null;
    await signIn(profile(), deployment, {}, { keychain, log, openBrowser: browser().open, nowSeconds: () => as.clock });
    expect(readProfile(profile())!.agentLabel).toBe("]0;pwned");
    rmSync(base, { recursive: true, force: true });
    base = mkdtempSync(join(tmpdir(), "assay-mcp-oauth-"));
    keychain = new Keychain(new MemoryKeyring(), { profile: "default", environment: deployment.environment });
    const fresh = await signIn(profile(), deployment, {}, { keychain, log, openBrowser: browser().open, nowSeconds: () => as.clock });
    expect(fresh.credentialId).not.toBeNull();
    expect(readProfile(profile())!.agentLabel).toBe("agent");
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

describe("fix round 1: bounds, error types, keep-alive", () => {
  const short = { requestMs: 300, refreshBoundMs: 600 };

  it("constants: 15 s per request, 64 KiB bodies, expires_in above twice the skew", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(MAX_BODY_BYTES).toBe(64 * 1024);
    expect(MIN_EXPIRES_IN).toBeGreaterThan(120);
  });

  it("a plain node script awaiting the loopback result stays alive until the callback", async () => {
    const bundle = await bundleFixture(join(here, "fixtures/loopback-child.ts"));
    const state = "Z".repeat(43);
    try {
      const child = spawn(process.execPath, [bundle.file, state], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const port = await new Promise<number>((resolve, reject) => {
        child.stdout!.on("data", (d: Buffer) => {
          out += d.toString();
          const m = /port (\d+)/.exec(out);
          if (m) resolve(Number(m[1]));
        });
        child.once("exit", (code) => reject(new Error(`exited early with ${code}`)));
      });
      // Nothing else holds the child's event loop: it must still be waiting.
      await new Promise((r) => setTimeout(r, 300));
      expect(child.exitCode).toBeNull();
      const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
      const res = await realFetch(`http://127.0.0.1:${port}/callback?state=${state}&code=assay_ac_x&iss=${encodeURIComponent(E2E_MCP)}`);
      expect(res.status).toBe(200);
      expect(await exited).toBe(0);
      expect(out).toContain(`result {"kind":"code","code":"assay_ac_x","iss":"${E2E_MCP}"}`);
    } finally {
      rmSync(bundle.dir, { recursive: true, force: true });
    }
  }, 30_000);

  for (const mode of ["stall", "drip"] as const) {
    it(`a ${mode === "stall" ? "stalled" : "drip-fed"} token endpoint: RefreshError within the bound, tokens kept, a sibling gets the lock`, async () => {
      const pair = as.seedGrant();
      await seedTokens(pair);
      as.clock = pair.expiresAt;
      as.misbehave["/oauth/token"] = mode;
      const started = Date.now();
      const first = refreshUnderLock(ctx({ timeouts: short }), pair.accessToken).catch((e: unknown) => e);
      await vi.waitFor(() => expect(as.tokenCalls()).toHaveLength(1));
      // The sibling waits for the lock, then finds the endpoint healthy again.
      const sibling = refreshUnderLock(ctx({ timeouts: short, lockOptions: { timeoutMs: 5_000 } }), pair.accessToken);
      expect(await first).toBeInstanceOf(RefreshError);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await keychain.get("refresh_token")).toBe(pair.refreshToken);
      delete as.misbehave["/oauth/token"];
      expect(await sibling).toMatch(/^assay_at_/);
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  }

  // Task 2.17: this test hung in about one full run of four (vitest's 5 s, then 30 s): the bound
  // fired, but the abort did not always reach a body still being read once the headers were in.
  // `readCapped` now watches the request's signal itself; the next test pins that directly.
  it("the refresh bound aborts even when the per-request timeout is longer", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    as.clock = pair.expiresAt;
    as.misbehave["/oauth/token"] = "drip";
    const started = Date.now();
    await expect(refreshUnderLock(ctx({ timeouts: { requestMs: 60_000, refreshBoundMs: 400 } }), pair.accessToken)).rejects.toBeInstanceOf(RefreshError);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it("a body still being read stops when its signal aborts (never read as a complete answer)", async () => {
    as.misbehave["/oauth/token"] = "drip";
    // No signal on the fetch itself: only the read can honour the abort.
    const res = await realFetch(`http://127.0.0.1:${as.port}/oauth/token`, { method: "POST", body: "" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("bound")), 100);
    const started = Date.now();
    await expect(readCapped(res, MAX_BODY_BYTES, controller.signal)).rejects.toThrow("bound");
    expect(Date.now() - started).toBeLessThan(3_000);
    // Already aborted before the first read.
    const again = await realFetch(`http://127.0.0.1:${as.port}/oauth/token`, { method: "POST", body: "" });
    await expect(readCapped(again, MAX_BODY_BYTES, AbortSignal.abort(new Error("early")))).rejects.toThrow("early");
  }, 15_000);

  it("an oversized answer is refused (server_error), tokens kept", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    as.clock = pair.expiresAt;
    as.misbehave["/oauth/token"] = "huge";
    await expect(refreshUnderLock(ctx(), pair.accessToken)).rejects.toBeInstanceOf(RefreshError);
    expect(await keychain.get("refresh_token")).toBe(pair.refreshToken);
  });

  it("a connection reset mid-body is a RefreshError, never a raw TypeError", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    as.clock = pair.expiresAt;
    as.misbehave["/oauth/token"] = "reset";
    await expect(refreshUnderLock(ctx(), pair.accessToken)).rejects.toBeInstanceOf(RefreshError);
    expect(await keychain.get("refresh_token")).toBe(pair.refreshToken);
  });

  for (const mode of ["reset", "stall", "huge"] as const) {
    it(`the code exchange (${mode}) fails as SignInError("failed")`, async () => {
      as.misbehave["/oauth/token"] = mode;
      const err = await signIn(profile(), deployment, {}, { keychain, log, openBrowser: browser().open, requestTimeoutMs: 300 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SignInError);
      expect((err as SignInError).reason).toBe("failed");
      expect(await keychain.get("refresh_token")).toBeNull();
    });
  }

  it("a stalled credential read does not hold the sign-in: tokens stored, credentialId null", async () => {
    as.misbehave["/api/v1/agents/me/delegate"] = "stall";
    const started = Date.now();
    const result = await signIn(profile(), deployment, {}, { keychain, log, openBrowser: browser().open, requestTimeoutMs: 300 });
    expect(result.credentialId).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await keychain.get("refresh_token")).toMatch(/^assay_rt_/);
  });

  it("an error callback with a foreign iss is refused, not read as declined", async () => {
    const b = browser((url) => {
      const back = new URL(as.approve(url, "deny"));
      back.searchParams.set("iss", "https://evil.example");
      return back.href;
    });
    const err = await signIn(profile(), deployment, {}, { keychain, log, openBrowser: b.open }).catch((e: unknown) => e);
    expect((err as SignInError).reason).toBe("refused");
  });

  it("a short expires_in is refused instead of rotating on every request", async () => {
    const pair = as.seedGrant();
    await seedTokens(pair);
    as.clock = pair.expiresAt;
    as.expiresIn = 60;
    await expect(refreshUnderLock(ctx(), pair.accessToken)).rejects.toBeInstanceOf(RefreshError);
    expect(await keychain.get("refresh_token")).toBe(pair.refreshToken);
  });

  it("revoke with only an access token revokes that token; a stalled revoke still clears locally", async () => {
    const pair = as.seedGrant();
    await withLock(profile(), (lock) => keychain.set(lock, "access_token", JSON.stringify({ token: pair.accessToken, expiresAt: pair.expiresAt })));
    expect(await revoke(ctx())).toEqual({ revoked: true });
    const [r] = as.requests;
    expect(r!.form!.get("token")).toBe(pair.accessToken);
    expect(r!.form!.get("token_type_hint")).toBe("access_token");
    expect(await keychain.getAccessToken()).toBeNull();

    const other = as.seedGrant();
    await seedTokens(other);
    as.misbehave["/oauth/revoke"] = "stall";
    const started = Date.now();
    expect(await revoke(ctx({ timeouts: short }))).toEqual({ revoked: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await keychain.get("refresh_token")).toBeNull();
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

describe("sign-in marker claims (re-review R1-M1)", () => {
  const alive = () => true;
  const dead = () => false;
  async function claim(passive: boolean, at: number, isAlive = alive) {
    return withLock(profile(), (lock) => claimMarker(profile(), lock, passive, at, isAlive));
  }

  it("a live active marker refuses every claim; a live passive one refuses passive claims only", async () => {
    expect((await claim(false, 1_000)).kind).toBe("claimed");
    expect((await claim(false, 2_000)).kind).toBe("busy");
    expect((await claim(true, 2_000)).kind).toBe("busy");
    rmSync(join(base, "profiles", "default.signin.json"));
    expect((await claim(true, 3_000)).kind).toBe("claimed");
    expect((await claim(true, 4_000)).kind).toBe("busy");
    const takeover = await claim(false, 5_000);
    expect(takeover.kind).toBe("claimed");
    expect(readMarker(profile())).toMatchObject({ passive: false, startedAt: 5_000 });
  });

  it("a dead pid or an expired marker is free; a claim without the held lock throws", async () => {
    await claim(false, 1_000);
    expect((await claim(false, 2_000, dead)).kind).toBe("claimed");
    expect((await claim(false, 2_000 + 5 * 60_000)).kind).toBe("claimed");
    const notHeld = { profile: profile(), owner: { pid: 1, startedAt: "", token: "" }, signal: new AbortController().signal, assertHeld: () => { throw new LockError("LOCK_LOST", "lost"); } };
    expect(() => claimMarker(profile(), notHeld, false, 9e12, alive)).toThrow(LockError);
  });
});
