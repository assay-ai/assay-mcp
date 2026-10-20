/**
 * Task 2.12: the profile commands. Temp `{dir}`/home/project, a memory keyring, a fake AS and
 * a fake MCP server (e2e origins rerouted at the transport, after `pinnedFetch`'s checks), a
 * fake chain. Never the real keychain, real client configs or the real profile directory.
 */
import { createServer, type Server } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, lutimesSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegationResult } from "../src/chain/reads.js";
import { CLIENTS } from "../src/clients/registry.js";
import { invocationFor, makeRunner, NO_CWD_EXE_SEARCH, which, windowsCmdExe } from "../src/clients/client.js";
import { printable } from "../src/commands/format.js";
import { guard } from "./setup/global-guard.js";
import { fingerprintDir } from "./setup/real-profile.js";
import { checkProjectEntry, runDoctor, T13_RISK_TEXT } from "../src/commands/doctor.js";
import { enablePaidLink, runEnablePaid } from "../src/commands/enable-paid.js";
import { unitsToUsd, usd, utcDate } from "../src/commands/format.js";
import { runLimits } from "../src/commands/limits.js";
import { runLogin } from "../src/commands/login.js";
import { onChainHint, runLogout, signsOutText } from "../src/commands/logout.js";
import { measureLongestTool, pickResponse } from "../src/commands/measure-tools.js";
import { runPaidUrlChange } from "../src/commands/paid-urls.js";
import { LOCK_TIMEOUT_TEXT, reportFailure, type ProfileDeps } from "../src/commands/profile-context.js";
import { runDevAllow } from "../src/commands/dev-allow.js";
import { runSettings } from "../src/commands/settings.js";
import { runStatus, statusText } from "../src/commands/status.js";
import { tokenLongestTool } from "../src/commands/wiring.js";
import { main } from "../src/cli.js";
import { getAddress } from "viem";
import { TOKEN_PATTERN as TOKEN_G, HEX32_PATTERN as HEX32_G } from "../src/log/redact.js";
import { clearDeadMarker } from "../src/oauth/signin-marker.js";
import { RefreshError } from "../src/oauth/tokens.js";
import { resolveDeployment } from "../src/profile/deployments.js";
import { addDevOrigin, readDevOrigins } from "../src/profile/dev-origins.js";
import { fingerprint } from "../src/profile/fingerprint.js";
import { Keychain, KeychainError, KEYCHAIN_SERVICE, type OsKeychain } from "../src/profile/keychain.js";
import { LockError, withLock, type ProfileRef } from "../src/profile/lock.js";
import { configDir, profileFile, writePrivateFile } from "../src/profile/paths.js";
import { testHome } from "./setup/temp-home.js";
import { addPaidUrl, createProfile, readLimits, readPaidUrls, readProfile, updateProfile } from "../src/profile/profile.js";
import { readSettings } from "../src/profile/settings.js";
import { checkEnvironment, readProfileSettings } from "../src/proxy/environment.js";
import { RUN } from "../src/version.js";
import { spawnSync } from "node:child_process";
import { isInteractive, requireTty, TtyRequired } from "../src/tty.js";
import { E2E_MCP, FakeAs } from "./helpers/fake-as.js";
import { MemoryKeyring } from "./helpers/memory-keyring.js";

const NOW = Math.floor(Date.UTC(2026, 9, 19, 12, 0, 0) / 1000);
const UNTIL = Math.floor(Date.UTC(2026, 10, 18, 0, 0, 0) / 1000);
const DELEGATE = `0x${"0".repeat(32)}1a2b9f3c`;
const PAYER = `0x${"11".repeat(20)}`;
const PRIVATE_KEY = `0x${"ab".repeat(32)}`;
const CRED = "3f2a1b9c-0000-4000-8000-000000000001";
const E2E_ENV = { ASSAY_MCP_DEV_ORIGINS: E2E_MCP };

let base: string;
let dir: string;
let home: string;
let cwd: string;
let keyring: MemoryKeyring;
let printed: string[];
let opened: string[];
let confirmAnswer: boolean;
let typedAnswer: string | null;
let confirmAsked: string[];
let chainResult: DelegationResult;
const realFetch = globalThis.fetch;
const TOKEN_PATTERN = new RegExp(TOKEN_G.source);
const HEX32_PATTERN = new RegExp(HEX32_G.source, "i");

function deps(overrides: Partial<ProfileDeps> = {}): ProfileDeps {
  const os: OsKeychain = { probe: async () => {}, forScope: (scope) => new Keychain(keyring, scope) };
  return {
    dir,
    home,
    cwd,
    platform: "darwin",
    env: {},
    isTTY: false,
    print: (t) => void printed.push(t),
    confirm: async (q) => {
      confirmAsked.push(q);
      return confirmAnswer;
    },
    // A typed confirmation: the profile name when the test says yes, a plain "y" otherwise
    // (which must not be enough).
    prompt: async (q) => {
      confirmAsked.push(q);
      return confirmAnswer ? (typedAnswer ?? "default") : "y";
    },
    openKeychain: async () => os,
    openBrowser: async (_d, url) => {
      opened.push(url);
      return true;
    },
    chain: () => ({ readDelegation: async () => chainResult }),
    nowSeconds: () => NOW,
    log: { error() {}, warn() {}, info() {}, debug() {}, child() { return this; } } as unknown as ProfileDeps["log"],
    clients: CLIENTS,
    lockOptions: { timeoutMs: 2000 },
    requestTimeoutMs: 2000,
    ...overrides,
  };
}

const ref = (name = "default"): ProfileRef => ({ dir, name });
const output = () => printed.join("");

function seedSecret(profile: string, environment: string, kind: string, value: string) {
  keyring.entries.set(`${KEYCHAIN_SERVICE}\u0000${profile}@${environment}/${kind}`, value);
}

/** Every file under `base` with its mode and content: a "nothing changed" check. */
function snapshot(root = base): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        out[`${p}/`] = (st.mode & 0o777).toString(8);
        walk(p);
      } else out[p] = `${(st.mode & 0o777).toString(8)}:${readFileSync(p, "utf8")}`;
    }
  };
  walk(root);
  return out;
}

async function seedProfile(environment: "production" | "e2e", extra: { delegate?: boolean; payer?: boolean; paid?: string[] } = {}) {
  await withLock(ref(), (lock) => {
    createProfile(ref(), lock, {
      environment,
      credentialId: CRED,
      agentLabel: "research-bot",
      createdAt: "2026-10-01T00:00:00.000Z",
      ...(extra.delegate ? { delegateAddress: DELEGATE, network: "eip155:46630" } : {}),
    });
    if (extra.payer) updateProfile(ref(), lock, (p) => ({ ...p, payer: PAYER }));
    for (const u of extra.paid ?? []) addPaidUrl(ref(), lock, u);
  });
}

function seedInstalls(records: { name: string; url: string; scope?: string; profile?: string; client?: string }[]) {
  writePrivateFile(
    dir,
    "installs.json",
    JSON.stringify(
      records.map((r) => ({
        client: r.client ?? "claude-code",
        scope: r.scope ?? "user",
        name: r.name,
        url: r.url,
        profile: r.profile ?? "default",
        configPath: join(home, ".claude.json"),
      })),
    ),
  );
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "assay-mcp-cmd-"));
  dir = join(base, "cfg");
  home = join(base, "home");
  cwd = join(base, "proj");
  mkdirSync(home);
  mkdirSync(cwd);
  keyring = new MemoryKeyring();
  printed = [];
  opened = [];
  confirmAnswer = false;
  typedAnswer = null;
  confirmAsked = [];
  chainResult = { ok: false, code: "CHAIN_UNCONFIRMED", reason: "not set" };
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

describe("tty", () => {
  it("isInteractive needs both stdin and stdout", () => {
    expect(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true } })).toBe(true);
    expect(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: false } })).toBe(false);
    expect(isInteractive({ stdin: {}, stdout: { isTTY: true } })).toBe(false);
    expect(() => requireTty("limits set", false)).toThrow(TtyRequired);
    expect(() => requireTty("limits set", true)).not.toThrow();
  });
});

describe("TTY-only commands", () => {
  const cases: [string, (d: ProfileDeps) => Promise<number>][] = [
    ["limits set", (d) => runLimits(["set", "--per-call", "9", "--per-day", "90"], d)],
    ["allow-paid", (d) => runPaidUrlChange("allow-paid", ["/c/weather"], d)],
    ["disallow-paid", (d) => runPaidUrlChange("disallow-paid", ["/"], d)],
    ["dev allow", (d) => runDevAllow([E2E_MCP], d)],
    ["settings set", (d) => runSettings(["set", "--allow-env-proxy", "on"], d)],
  ];

  it.each(cases)("%s without a TTY exits 2 and changes no file", async (name, run) => {
    await seedProfile("production");
    confirmAnswer = true;
    const before = snapshot();
    const stdout = vi.spyOn(process.stdout, "write");
    expect(await run(deps({ isTTY: false }))).toBe(2);
    expect(snapshot()).toEqual(before);
    expect(stdout).not.toHaveBeenCalled();
    expect(confirmAsked).toEqual([]);
    expect(output()).toContain(`"${name}" changes local safety settings`);
  });

  it.each(cases)("%s without a TTY changes nothing even before any profile exists", async (_name, run) => {
    const before = snapshot();
    expect(await run(deps({ isTTY: false }))).toBe(2);
    expect(snapshot()).toEqual(before);
    expect(existsSync(dir)).toBe(false);
  });

  // The CLI entry builds its own deps from `configDir()`, which test/setup/temp-home.ts points
  // at a temporary home (review I2); the global guard fails the run if the real one changes.
  it("the CLI entry refuses them too, in a temporary home", async () => {
    expect(configDir().startsWith(testHome())).toBe(true);
    const tempDir = configDir();
    const before = existsSync(tempDir) ? readdirSync(tempDir, { recursive: true }) : null;
    const stdin = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    // Even when the test runner itself sits in a terminal, the entry must see no TTY.
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const err: string[] = [];
    const out = vi.spyOn(process.stdout, "write");
    vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
    // requireTty runs before any file or profile is read, so the real {dir} is never touched.
    expect(await main(["limits", "set", "--per-call", "1", "--per-day", "2"])).toBe(2);
    expect(await main(["allow-paid", "/c/weather"])).toBe(2);
    expect(await main(["disallow-paid", "/"])).toBe(2);
    expect(await main(["dev", "allow", E2E_MCP])).toBe(2);
    expect(await main(["settings", "set", "--allow-env-proxy", "on"])).toBe(2);
    expect(out).not.toHaveBeenCalled();
    expect(err.join("").match(/changes local safety settings/g)).toHaveLength(5);
    Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: stdoutTty, configurable: true });
    expect(existsSync(tempDir) ? readdirSync(tempDir, { recursive: true }) : null).toEqual(before);
  });
});

describe("status", () => {
  it("status output matches the §7.3 golden with fake data", async () => {
    await seedProfile("production", { delegate: true, payer: true, paid: ["/c/weather"] });
    seedSecret("default", "production", "refresh_token", "assay_rt_seed");
    await withLock(ref(), (lock) => {
      writePrivateFile(dir, profileFile("default", "state"), JSON.stringify({ version: 1, signed: [{ at: NOW - 3600, amount: "1200000" }, { at: NOW - 90_000, amount: "999" }], lastBrowserOpen: null }));
      lock.assertHeld();
    });
    seedInstalls([
      { name: "assay", url: "https://mcp.assay.ai/" },
      { name: "weather", url: "https://mcp.assay.ai/c/weather" },
    ]);
    chainResult = {
      ok: true,
      value: {
        payer: PAYER,
        delegate: DELEGATE,
        active: true,
        validUntil: String(UNTIL),
        maxVoucherAmount: "9000000",
        maxPerWindow: "90000000",
        delegateMaxVoucherAmount: "500000",
        delegateMaxPerWindow: "5000000",
        readAt: NOW,
      },
    };
    const stdout = vi.spyOn(process.stdout, "write");
    expect(await runStatus([], deps())).toBe(0);
    expect(stdout).not.toHaveBeenCalled();
    expect(output()).toBe(
      [
        "Profile     default  (https://mcp.assay.ai)",
        "Signed in   yes · Assay app on this Mac · credential 3f2a1b9c (OAuth)",
        "Agent       research-bot",
        "Payment key 1A2B 9F3C · on (read from chain) · $0.50 a call · $5 per 24 h · until 2026-11-18",
        "Local caps  $0.50 a call · $5 per 24 h · spent today $1.20 · confirm above: off · providers: any",
        "Paid URLs   /  ·  /c/weather",
        "Installs    assay (claude-code, user) → /    weather (claude-code, user) → /c/weather",
        "",
      ].join("\n"),
    );
  });

  it("the payment-key line follows the chain, not the files", async () => {
    await seedProfile("production", { delegate: true, payer: true });
    const keyLine = async () => (await statusText([], deps())).split("\n")[3];
    chainResult = { ok: false, code: "CHAIN_UNCONFIRMED", reason: "RPCs disagree" };
    expect(await keyLine()).toBe("Payment key 1A2B 9F3C · can't confirm on chain right now");
    const v = { payer: PAYER, delegate: DELEGATE, maxVoucherAmount: "1", maxPerWindow: "1", delegateMaxVoucherAmount: "1", delegateMaxPerWindow: "1", readAt: NOW };
    chainResult = { ok: true, value: { ...v, active: false, validUntil: String(UNTIL) } };
    expect(await keyLine()).toBe(`Payment key 1A2B 9F3C · stopped (read from chain) · run \`${RUN} enable-paid\``);
    chainResult = { ok: true, value: { ...v, active: true, validUntil: String(NOW - 1) } };
    expect(await keyLine()).toBe(`Payment key 1A2B 9F3C · expired 2026-10-19 (read from chain) · run \`${RUN} enable-paid\``);
    chainResult = { ok: true, value: { ...v, active: false, validUntil: "0" } };
    expect(await keyLine()).toBe(`Payment key 1A2B 9F3C · off (read from chain) · run \`${RUN} enable-paid\``);
  });

  it("signed out, with no profile: defaults and no key", async () => {
    expect(await runStatus([], deps({ platform: "linux" }))).toBe(0);
    const lines = output().split("\n");
    expect(lines[0]).toBe("Profile     default  (https://mcp.assay.ai)");
    expect(lines[1]).toBe(`Signed in   no · run \`${RUN} login\``);
    expect(lines[3]).toBe("Payment key none yet · made on the first paid call");
    expect(lines[4]).toBe("Local caps  $0.50 a call · $5 per 24 h · spent today $0 · confirm above: off · providers: any");
    expect(lines[5]).toBe("Paid URLs   /");
    expect(lines[6]).toBe("Installs    none");
    // Read only: status creates no file.
    expect(existsSync(dir)).toBe(false);
  });

  it("uses the API's paidCalls only before a payer is recorded, and says so", async () => {
    await seedProfile("e2e", { delegate: true });
    addDevOrigin(dir, E2E_MCP);
    seedSecret("default", "e2e", "refresh_token", "assay_rt_seed");
    seedSecret("default", "e2e", "access_token", JSON.stringify({ token: "assay_at_seed", expiresAt: NOW + 600 }));
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      seen.push(`${u.origin}${u.pathname} ${new Headers(init?.headers).get("authorization")}`);
      return new Response(JSON.stringify({ data: { credentialId: CRED, paidCalls: { status: "ACTIVE" } } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const text = await statusText([], deps({ env: E2E_ENV }));
    expect(text.split("\n")[3]).toBe("Payment key 1A2B 9F3C · on (reported by Assay, not yet read from chain)");
    expect(seen).toEqual(["http://localhost:3000/api/v1/agents/me/delegate Bearer assay_at_seed"]);
  });

  it("refuses a dev profile while dev mode is off", async () => {
    await seedProfile("e2e");
    expect(await runStatus([], deps())).toBe(2);
    expect(output()).toContain(`${RUN} status:`);
  });
});

describe("login and logout (fake AS)", () => {
  let as: FakeAs;

  beforeEach(async () => {
    as = new FakeAs();
    as.clock = NOW;
    await as.start();
    vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(input instanceof Request ? input.url : String(input instanceof URL ? input.href : input));
      if (u.origin === E2E_MCP || u.origin === "http://localhost:3000") return realFetch(`http://127.0.0.1:${as.port}${u.pathname}${u.search}`, init);
      return realFetch(input, init);
    }) as typeof fetch);
    addDevOrigin(dir, E2E_MCP);
  });

  afterEach(async () => {
    await as.stop();
  });

  const browser = (url: string) => {
    opened.push(url);
    const target = as.approve(url);
    setImmediate(() => void realFetch(target).then((r) => r.text()).catch(() => {}));
    return Promise.resolve(true);
  };

  it("login prints the link on stderr, signs in under the lock and records the profile", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const code = await runLogin(["--url", `${E2E_MCP}/`], deps({ env: E2E_ENV, signIn: { openBrowser: browser, hostname: () => "box" } }));
    expect(code).toBe(0);
    expect(stdout).not.toHaveBeenCalled();
    const link = opened[0]!;
    expect(output()).toContain(`Approve in your browser: ${link}\n`);
    const grant = as.grants[0]!;
    expect(output()).toContain(`Signed in (credential ${grant.credentialId.slice(0, 8)}).`);
    expect(readProfile(ref())!.credentialId).toBe(grant.credentialId);
    expect(keyring.writeSignals.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(output()).not.toMatch(TOKEN_PATTERN);

    // An explicit login while signed in signs in again and replaces the grant (F5).
    printed = [];
    expect(await runLogin([], deps({ env: E2E_ENV, signIn: { openBrowser: browser } }))).toBe(0);
    expect(output()).toContain(`Signing in again; this replaces the current sign-in (credential ${grant.credentialId.slice(0, 8)}).`);
    expect(as.authorizeParams).toHaveLength(2);
    expect(as.authorizeParams[1]!.get("assay_replaces")).toBe(grant.credentialId);
    expect(readProfile(ref())!.credentialId).toBe(as.grants[1]!.credentialId);
  });

  it("R1-M4: a forced login completes even when a sibling's refresh rotates the token meanwhile", async () => {
    const old = as.seedGrant();
    await seedProfile("e2e");
    seedSecret("default", "e2e", "refresh_token", old.refreshToken);
    seedSecret("default", "e2e", "access_token", JSON.stringify({ token: old.accessToken, expiresAt: old.expiresAt }));
    const rotating = (url: string) => {
      // A sibling process refreshes while the browser is open: the stored pair changes.
      seedSecret("default", "e2e", "refresh_token", "assay_rt_rotated_by_a_sibling");
      return browser(url);
    };
    expect(await runLogin([], deps({ env: E2E_ENV, signIn: { openBrowser: rotating } }))).toBe(0);
    expect(as.tokenCalls("authorization_code")).toHaveLength(1);
    expect(as.authorizeParams[0]!.get("assay_replaces")).toBe(CRED);
    const fresh = as.grants.at(-1)!;
    expect(output()).toContain(`Signed in (credential ${fresh.credentialId.slice(0, 8)}).`);
    expect(readProfile(ref())!.credentialId).toBe(fresh.credentialId);
    expect(keyring.entries.get(`${KEYCHAIN_SERVICE}\u0000default@e2e/refresh_token`)).not.toBe("assay_rt_rotated_by_a_sibling");
  });

  it("login maps LOCK_TIMEOUT to the -32001 text and exits 1", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = withLock(ref(), () => held);
    await new Promise((r) => setTimeout(r, 50));
    const code = await runLogin(["--url", `${E2E_MCP}/`], deps({ env: E2E_ENV, lockOptions: { timeoutMs: 300 }, signIn: { openBrowser: browser } }));
    release();
    await holder;
    expect(code).toBe(1);
    expect(output()).toContain(LOCK_TIMEOUT_TEXT);
    expect(as.authorizeParams).toHaveLength(0);
  });

  it("logout keeps limits.json and paid-urls.json, deletes delegate_key, prints both texts", async () => {
    const pair = as.seedGrant();
    await seedProfile("e2e", { delegate: true, paid: ["/c/weather"] });
    await withLock(ref(), (lock) => {
      writePrivateFile(dir, profileFile("default", "state"), JSON.stringify({ version: 1, signed: [], lastBrowserOpen: null }));
      writePrivateFile(dir, profileFile("default", "settings"), JSON.stringify({ version: 1, allowEnvProxy: true }));
      lock.assertHeld();
    });
    const limitsBefore = readFileSync(join(dir, profileFile("default", "limits")), "utf8");
    seedSecret("default", "e2e", "refresh_token", pair.refreshToken);
    seedSecret("default", "e2e", "access_token", JSON.stringify({ token: pair.accessToken, expiresAt: pair.expiresAt }));
    seedSecret("default", "e2e", "delegate_key", PRIVATE_KEY);
    seedInstalls([
      { name: "assay", url: `${E2E_MCP}/` },
      { name: "assay-weather", url: `${E2E_MCP}/c/weather` },
      { name: "other", url: `${E2E_MCP}/`, profile: "work" },
    ]);

    const stdout = vi.spyOn(process.stdout, "write");
    expect(await runLogout([], deps({ env: E2E_ENV }))).toBe(0);
    expect(stdout).not.toHaveBeenCalled();

    // Revoked on the server with the refresh token, once, without Authorization.
    const revokes = as.requests.filter((r) => r.path === "/oauth/revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.form!.get("token")).toBe(pair.refreshToken);
    expect(revokes[0]!.form!.get("token_type_hint")).toBe("refresh_token");
    expect(revokes[0]!.authorization).toBeUndefined();
    expect(as.grants[0]!.revoked).toBe(true);

    // Keychain: tokens and the delegate key gone; every delete carried the lock signal.
    expect([...keyring.entries.keys()].filter((k) => k.includes("default@e2e"))).toEqual([]);
    expect(keyring.writeSignals.every((s) => s instanceof AbortSignal)).toBe(true);

    // Files: limits and paid URLs kept (unchanged), the others deleted.
    expect(readFileSync(join(dir, profileFile("default", "limits")), "utf8")).toBe(limitsBefore);
    expect(readPaidUrls(ref())).toEqual(["/", "/c/weather"]);
    for (const kind of ["profile", "state", "settings"] as const) expect(existsSync(join(dir, profileFile("default", kind)))).toBe(false);
    expect(existsSync(join(dir, profileFile("default", "lock")))).toBe(false);

    expect(output()).toContain(`${signsOutText(2)}\n`);
    expect(output()).toContain("This signs out all 2 Assay servers on this computer.");
    expect(output()).toContain(`${onChainHint("http://localhost:4000")}\n`);
    expect(output()).toContain(
      "Your payment key was deleted from this computer. To also cancel its on-chain permission, open http://localhost:4000/agents and click Stop it (one signature).",
    );
    expect(output()).not.toContain(PRIVATE_KEY.slice(2));
    expect(output()).not.toMatch(TOKEN_PATTERN);
  });

  it("logout without a payment key prints no on-chain hint", async () => {
    await seedProfile("e2e");
    seedSecret("default", "e2e", "refresh_token", "assay_rt_unknown_to_the_server");
    expect(await runLogout([], deps({ env: E2E_ENV }))).toBe(0);
    expect(output()).not.toContain("Assay servers on this computer");
    expect(output()).not.toContain("payment key was deleted");
    expect(keyring.entries.size).toBe(0);
    expect(readProfile(ref())).toBeNull();
  });

  it("R1-N3: logout removes a sign-in marker of a dead pid, and leaves a live one (another process's or this process's own, by token)", async () => {
    const markerPath = join(dir, profileFile("default", "signin"));
    const writeMarker = (pid: number) =>
      withLock(ref(), (lock) => {
        lock.assertHeld();
        writePrivateFile(dir, profileFile("default", "signin"), `${JSON.stringify({ version: 1, pid, startedAt: Date.now(), token: "marker-token", passive: false })}\n`);
      });
    // A child that has already exited: its pid no longer runs.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    await seedFull();
    await writeMarker(dead);
    expect(await runLogout([], deps({ env: E2E_ENV }))).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
    // M1: a live marker of this very pid is kept too (ownership is by token, not pid).
    await seedFull();
    await writeMarker(process.pid);
    expect(await runLogout([], deps({ env: E2E_ENV }))).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    // ... and it is removed only when the caller names its token.
    await withLock(ref(), (lock) => {
      expect(clearDeadMarker(ref(), lock, undefined, "other-token")).toBe(false);
      expect(clearDeadMarker(ref(), lock, undefined, "marker-token")).toBe(true);
    });
    expect(existsSync(markerPath)).toBe(false);
    // The parent process is alive and is not this process: its pending sign-in is left alone.
    await seedFull();
    await writeMarker(process.ppid);
    expect(await runLogout([], deps({ env: E2E_ENV }))).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    expect(readProfile(ref())).toBeNull();
  });

  /** A signed-in profile with a payment key and every profile file. */
  async function seedFull(refreshToken = "assay_rt_seeded_token_value", accessToken = "assay_at_seeded_token_value") {
    await seedProfile("e2e", { delegate: true, paid: ["/c/weather"] });
    await withLock(ref(), (lock) => {
      writePrivateFile(dir, profileFile("default", "state"), JSON.stringify({ version: 1, signed: [], lastBrowserOpen: null }));
      writePrivateFile(dir, profileFile("default", "settings"), JSON.stringify({ version: 1, allowEnvProxy: true }));
      lock.assertHeld();
    });
    seedSecret("default", "e2e", "refresh_token", refreshToken);
    seedSecret("default", "e2e", "access_token", JSON.stringify({ token: accessToken, expiresAt: NOW + 600 }));
    seedSecret("default", "e2e", "delegate_key", PRIVATE_KEY);
    return readFileSync(join(dir, profileFile("default", "limits")), "utf8");
  }

  function expectCleared(limitsBefore: string, web: string | null = "http://localhost:4000") {
    expect([...keyring.entries.keys()]).toEqual([]);
    for (const kind of ["profile", "state", "settings"] as const) expect(existsSync(join(dir, profileFile("default", kind)))).toBe(false);
    expect(readFileSync(join(dir, profileFile("default", "limits")), "utf8")).toBe(limitsBefore);
    expect(readPaidUrls(ref())).toEqual(["/", "/c/weather"]);
    expect(output()).toContain(web !== null ? `${onChainHint(web)}\n` : "Your payment key was deleted from this computer. To also cancel its on-chain permission, open Agents & keys");
  }

  it.each(["stall", "reset"] as const)("logout deletes the payment key and the files even when the revoke fails (%s)", async (mode) => {
    const limitsBefore = await seedFull();
    as.misbehave["/oauth/revoke"] = mode;
    expect(await runLogout([], deps({ env: E2E_ENV, requestTimeoutMs: 200 }))).toBe(0);
    // A reset after a 200 status line counts as answered; a stall is not confirmed.
    if (mode === "stall") expect(output()).toContain("Assay did not confirm the sign-out");
    expectCleared(limitsBefore);
  });

  it("logout deletes the payment key and the files when the server refuses the connection", async () => {
    const limitsBefore = await seedFull();
    await as.stop(); // nothing listens on the port any more: connection refused
    expect(await runLogout([], deps({ env: E2E_ENV }))).toBe(0);
    expect(output()).toContain("Assay did not confirm the sign-out");
    expectCleared(limitsBefore);
    await as.start();
  });

  it("logout clears locally, without a request, for an unreadable profile or a dev profile without dev mode (M2)", async () => {
    const limitsBefore = await seedFull();
    // Dev mode off: no revoke is sent, the local data still goes.
    expect(await runLogout([], deps({ env: {} }))).toBe(0);
    expect(as.requests).toEqual([]);
    expect(output()).toContain("Signed out on this computer only");
    expectCleared(limitsBefore, null);

    // An unreadable (loose) profile file is a POSIX mode check; on Windows the file stays readable.
    if (process.platform === "win32") return;
    printed = [];
    const limits2 = await seedFull();
    // An unreadable (loose) profile file: every environment's entries of the profile are cleared.
    const { chmodSync } = await import("node:fs");
    chmodSync(join(dir, profileFile("default", "profile")), 0o644);
    seedSecret("default", "production", "delegate_key", PRIVATE_KEY);
    expect(await runLogout([], deps({ env: E2E_ENV }))).toBe(0);
    expect(as.requests).toEqual([]);
    expectCleared(limits2, null);
  });

  it("logout keeps 2.7's lost-lock fallback: the local clear runs under a new lock (M1)", async () => {
    const limitsBefore = await seedFull();
    let stalled = false;
    // The first keychain delete stalls past the lock's freshness (a 15 s heartbeat stall,
    // shortened by a fake clock), so the hold ends with LOCK_LOST.
    let clock = Date.now();
    keyring.beforeWrite = async () => {
      if (!stalled) {
        stalled = true;
        clock += 20_000;
      }
    };
    expect(await runLogout([], deps({ env: E2E_ENV, lockOptions: { timeoutMs: 2000, now: () => clock } }))).toBe(0);
    expect(stalled).toBe(true);
    expectCleared(limitsBefore);
  });

  it("prints nothing about signing out when the lock cannot be taken (M9)", async () => {
    await seedFull();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = withLock(ref(), () => held);
    await new Promise((r) => setTimeout(r, 50));
    expect(await runLogout([], deps({ env: E2E_ENV, lockOptions: { timeoutMs: 300 } }))).toBe(1);
    release();
    await holder;
    expect(output()).not.toContain("This signs out all");
    expect(output()).toContain(LOCK_TIMEOUT_TEXT);
  });

  it("an invalid profile name is a usage error", async () => {
    expect(await runLogout(["--profile", "../x"], deps())).toBe(2);
    expect(await runLogin(["--bogus"], deps())).toBe(2);
  });
});

describe("enable-paid", () => {
  it("prints and opens the link with the fingerprint", async () => {
    await seedProfile("e2e", { delegate: true });
    addDevOrigin(dir, E2E_MCP);
    expect(await runEnablePaid([], deps({ env: E2E_ENV }))).toBe(0);
    const link = `http://localhost:4000/agents/enable-paid?credential=${CRED}#key=${DELEGATE}`;
    expect(opened).toEqual([link]);
    expect(output()).toContain(`Open ${link} to turn on paid calls. The page must show this payment key: 1A2B 9F3C.`);
  });

  it("refuses without a profile or a key, and builds only checked links", async () => {
    expect(await runEnablePaid([], deps())).toBe(1);
    await seedProfile("production");
    printed = [];
    expect(await runEnablePaid([], deps())).toBe(1);
    expect(output()).toContain("no payment key");
    expect(opened).toEqual([]);
    expect(enablePaidLink("<WEB from ops config>", CRED, DELEGATE)).toBeNull();
    expect(enablePaidLink("https://app.example", "not-a-uuid", DELEGATE)).toBeNull();
    expect(enablePaidLink("https://app.example", CRED, "0x12")).toBeNull();
    expect(enablePaidLink("javascript:alert(1)", CRED, DELEGATE)).toBeNull();
    expect(enablePaidLink("https://app.example/x?y", CRED, DELEGATE)).toBe(`https://app.example/agents/enable-paid?credential=${CRED}#key=${DELEGATE}`);
  });
});

describe("limits", () => {
  it("shows the caps without a TTY", async () => {
    expect(await runLimits([], deps())).toBe(0);
    expect(output()).toBe("Local caps  $0.50 a call · $5 per 24 h · confirm above: off · providers: any\n");
  });

  it("limits set on a TTY writes under the lock and keeps unspecified options", async () => {
    const t = deps({ isTTY: true });
    const provider = `0x${"ab".repeat(20)}`;
    expect(await runLimits(["set", "--per-call", "1", "--per-day", "$10", "--confirm-above", "0.75", "--providers", provider], t)).toBe(0);
    expect(readLimits(ref())).toMatchObject({ perCall: "1", perDay: "10", confirmAbove: "0.75", providers: [getAddress(provider)] });
    expect(await runLimits(["set", "--per-call", "0.5", "--per-day", "5"], t)).toBe(0);
    expect(readLimits(ref())).toMatchObject({ perCall: "0.5", perDay: "5", confirmAbove: "0.75" });
    expect(await runLimits(["set", "--per-call", "0.5", "--per-day", "5", "--confirm-above", "off", "--providers", "off"], t)).toBe(0);
    expect(readLimits(ref())).toMatchObject({ confirmAbove: null, providers: null });
    const st = lstatSync(join(dir, profileFile("default", "limits")));
    if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o600);
  });

  it.each([
    [["set", "--per-call", "1"]],
    [["set", "--per-call", "abc", "--per-day", "5"]],
    [["set", "--per-call", "6", "--per-day", "5"]],
    [["set", "--per-call", "1", "--per-day", "5", "--providers", "evil"]],
    [["set", "--per-call", "1", "--per-day", "5", "--confirm-above", "-1"]],
    [["set", "--per-call", "1", "--per-day", "5", "--per-day", "6"]],
  ])("refuses bad input %j without writing", async (args) => {
    expect(await runLimits(args, deps({ isTTY: true }))).toBe(2);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("allow-paid / disallow-paid", () => {
  it("adds and removes the canonical path on a TTY, after the profile name is typed", async () => {
    await seedProfile("production");
    confirmAnswer = true;
    const t = deps({ isTTY: true });
    expect(await runPaidUrlChange("allow-paid", ["https://mcp.assay.ai/c/weather"], t)).toBe(0);
    expect(readPaidUrls(ref())).toEqual(["/", "/c/weather"]);
    expect(await runPaidUrlChange("allow-paid", ["/c/weather"], t)).toBe(0);
    expect(output()).toContain("were already allowed");
    expect(await runPaidUrlChange("disallow-paid", ["/c/weather"], t)).toBe(0);
    expect(readPaidUrls(ref())).toEqual(["/"]);
    expect(readFileSync(join(dir, profileFile("default", "paid-urls")), "utf8")).not.toContain("mcp.assay.ai");
    // Asked once: allowing a URL already allowed, and disallowing, ask nothing.
    expect(confirmAsked).toHaveLength(1);
    expect(confirmAsked[0]).toContain('Type the profile name (default)');
  });

  it("a plain yes is not enough: nothing changes and the exit code is 0", async () => {
    await seedProfile("production");
    confirmAnswer = false; // the prompt answers "y"
    const before = snapshot();
    expect(await runPaidUrlChange("allow-paid", ["/c/weather"], deps({ isTTY: true }))).toBe(0);
    expect(output()).toContain("Nothing changed.");
    expect(snapshot()).toEqual(before);
    confirmAnswer = true;
    typedAnswer = "Default";
    expect(await runPaidUrlChange("allow-paid", ["/c/weather"], deps({ isTTY: true }))).toBe(0);
    expect(readPaidUrls(ref())).toEqual(["/"]);
  });

  it("refuses another origin, a dev origin without dev mode, and a profile of another environment", async () => {
    const t = deps({ isTTY: true });
    expect(await runPaidUrlChange("allow-paid", ["https://evil.example/c/weather"], t)).toBe(2);
    expect(await runPaidUrlChange("allow-paid", [`${E2E_MCP}/c/weather`], t)).toBe(2);
    expect(existsSync(dir)).toBe(false);
    await seedProfile("production");
    addDevOrigin(dir, E2E_MCP);
    expect(await runPaidUrlChange("allow-paid", [`${E2E_MCP}/c/weather`], deps({ isTTY: true, env: E2E_ENV }))).toBe(1);
    expect(readPaidUrls(ref())).toEqual(["/"]);
  });
});

describe("dev allow", () => {
  it("writes dev-origins.json on a TTY after a yes", async () => {
    confirmAnswer = true;
    expect(await runDevAllow([E2E_MCP], deps({ isTTY: true }))).toBe(0);
    expect(confirmAsked).toHaveLength(1);
    expect(readDevOrigins(dir)).toEqual([E2E_MCP]);
    if (process.platform !== "win32") expect(lstatSync(join(dir, "dev-origins.json")).mode & 0o777).toBe(0o600);
  });

  it("writes nothing on a no (exit 0), and refuses origins of no built-in dev entry", async () => {
    confirmAnswer = false;
    expect(await runDevAllow([E2E_MCP], deps({ isTTY: true }))).toBe(0);
    expect(output()).toContain("Nothing changed.");
    expect(existsSync(dir)).toBe(false);
    confirmAnswer = true;
    expect(await runDevAllow(["https://evil.example"], deps({ isTTY: true }))).toBe(2);
    expect(await runDevAllow(["http://localhost:3200/path"], deps({ isTTY: true }))).toBe(2);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("dev allow (lock and unreadable file, review M7)", () => {
  it("writes under the dev-origins lock and refuses to replace an unreadable file", async () => {
    confirmAnswer = true;
    // A held dev-origins lock blocks the write until the timeout.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = withLock({ dir, name: "dev-origins" }, () => held);
    await new Promise((r) => setTimeout(r, 50));
    expect(await runDevAllow([E2E_MCP], deps({ isTTY: true, lockOptions: { timeoutMs: 300 } }))).toBe(1);
    release();
    await holder;
    expect(readDevOrigins(dir)).toEqual([]);

    writePrivateFile(dir, "dev-origins.json", "{not json");
    printed = [];
    expect(await runDevAllow([E2E_MCP], deps({ isTTY: true }))).toBe(1);
    expect(output()).toContain("not valid JSON");
    expect(readFileSync(join(dir, "dev-origins.json"), "utf8")).toBe("{not json");
  });
});

describe("settings (env-proxy opt-in)", () => {
  it("settings set on a TTY asks, then writes a 0600 file the serve check reads", async () => {
    confirmAnswer = true;
    expect(await runSettings(["set", "--allow-env-proxy", "on"], deps({ isTTY: true }))).toBe(0);
    expect(confirmAsked).toHaveLength(1);
    const path = join(dir, profileFile("default", "settings"));
    if (process.platform !== "win32") expect(lstatSync(path).mode & 0o777).toBe(0o600);
    // The exact shape `serve` reads (Task 2.8 environment.ts): {"version":1,"allowEnvProxy":true}.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, allowEnvProxy: true });
    expect(readSettings(ref()).allowEnvProxy).toBe(true);
    // R1-N2: serve's reader accepts exactly what settings set wrote, and the check then passes.
    expect(readProfileSettings(ref()).allowEnvProxy).toBe(true);
    expect(checkEnvironment({ HTTPS_PROXY: "http://proxy.example.com:8080" }, [], () => readProfileSettings(ref()), "default").refusals).toEqual([]);
    printed = [];
    expect(await runSettings([], deps())).toBe(0);
    expect(output()).toContain("allowed");

    confirmAsked = [];
    expect(await runSettings(["set", "--allow-env-proxy", "off"], deps({ isTTY: true }))).toBe(0);
    expect(confirmAsked).toEqual([]);
    expect(readSettings(ref()).allowEnvProxy).toBe(false);
    expect(readProfileSettings(ref()).allowEnvProxy).toBe(false);
    expect(checkEnvironment({ HTTPS_PROXY: "http://proxy.example.com:8080" }, [], () => readProfileSettings(ref()), "default").refusals).toHaveLength(1);
  });

  it("R1-N2: settings and serve share one parser; serve fails closed where settings refuses", async () => {
    const cases: [string, boolean | "refused"][] = [
      ['{"version":1,"allowEnvProxy":true}', true],
      ['{"version":1,"allowEnvProxy":false}', false],
      ['{"version":1,"allowEnvProxy":"true"}', "refused"],
      ['{"version":1,"allowEnvProxy":1}', "refused"],
      ['{"version":2,"allowEnvProxy":true}', "refused"],
      ['{"allowEnvProxy":true}', "refused"],
      ["[true]", "refused"],
      ["null", "refused"],
      ["{not json", "refused"],
    ];
    for (const [text, want] of cases) {
      await withLock(ref(), (lock) => {
        lock.assertHeld();
        writePrivateFile(dir, profileFile("default", "settings"), text);
      });
      if (want === "refused") expect(() => readSettings(ref()), text).toThrow();
      else expect(readSettings(ref()).allowEnvProxy, text).toBe(want);
      expect(readProfileSettings(ref()).allowEnvProxy, text).toBe(want === true);
    }
  });

  it("a declined confirmation (a plain yes) or a bad value writes nothing", async () => {
    confirmAnswer = false;
    expect(await runSettings(["set", "--allow-env-proxy", "on"], deps({ isTTY: true }))).toBe(0);
    expect(output()).toContain("Nothing changed.");
    expect(confirmAsked[0]).toContain("Type the profile name (default)");
    expect(await runSettings(["set", "--allow-env-proxy", "yes"], deps({ isTTY: true }))).toBe(2);
    expect(await runSettings(["set"], deps({ isTTY: true }))).toBe(2);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("doctor", () => {
  const pinned = { command: "npx", args: ["-y", "@goassay-ai/mcp@1.2.3", "--url", "https://mcp.assay.ai/c/weather"] };

  it("flags env keys other than ASSAY_* on project-scope assay entries", async () => {
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          assay: { ...pinned, env: { NODE_OPTIONS: "--require ./x.js", ASSAY_MCP_DEV_ORIGINS: "http://localhost:3200" } },
          "assay-ok": { type: "stdio", ...pinned, env: {} },
          unrelated: { command: "other", env: { NODE_OPTIONS: "--require ./y.js" } },
        },
      }),
    );
    mkdirSync(join(cwd, ".vscode"));
    writeFileSync(join(cwd, ".vscode", "mcp.json"), JSON.stringify({ servers: { "assay-x": { type: "stdio", command: "node", args: ["./local.js"], envFile: ".env" } } }));
    const code = await runDoctor([], deps());
    expect(code).toBe(1);
    const text = output();
    expect(text).toContain('server "assay" sets NODE_OPTIONS in its environment');
    expect(text).toContain('server "assay" asks for dev mode (ASSAY_MCP_DEV_ORIGINS)');
    expect(text).toContain('server "assay-ok" has nothing unexpected');
    expect(text).not.toContain('"unrelated"');
    expect(text).toContain('server "assay-x" loads its environment from a file (envFile)');
    expect(text).toContain('server "assay-x" does not run the pinned @goassay-ai/mcp package');
    expect(text).toContain(T13_RISK_TEXT);
  });

  it("checks this terminal's environment and local opt-ins; clean is exit 0", async () => {
    expect(await runDoctor([], deps())).toBe(0);
    expect(output()).toContain("No problems found.");
    printed = [];
    expect(await runDoctor([], deps({ env: { NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_OPTIONS: "--require /tmp/a.js", HTTPS_PROXY: "http://p" } }))).toBe(1);
    expect(output()).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
    expect(output()).toContain("NODE_OPTIONS in this terminal preloads code");
    expect(output()).toContain("HTTPS_PROXY set in this terminal");
    printed = [];
    const failing: OsKeychain = { probe: () => Promise.reject(new KeychainError("unavailable")), forScope: () => { throw new Error("no"); } };
    expect(await runDoctor([], deps({ openKeychain: async () => failing }))).toBe(1);
    expect(output()).toContain("No OS keychain is available.");
  });

  it("checkProjectEntry flags an API key in a project file", () => {
    const f = checkProjectEntry("/p/.mcp.json", "assay", { ...pinned, env: { ASSAY_API_KEY: "x" } });
    expect(f.map((x) => x.text).join("\n")).toContain("carries ASSAY_API_KEY in a project file");
  });
});

describe("failure mapping (CARRY 2.7)", () => {
  it("LOCK_TIMEOUT → the -32001 text; RefreshError → retry later; keychain → its text; exit 1", () => {
    const p = { print: (t: string) => void printed.push(t) };
    expect(reportFailure("x", new LockError("LOCK_TIMEOUT", "timeout"), p)).toBe(1);
    expect(reportFailure("x", new RefreshError(503), p)).toBe(1);
    expect(reportFailure("x", new KeychainError("locked"), p)).toBe(1);
    expect(reportFailure("x", new Error("assay_rt_secretvalue leaked"), p)).toBe(1);
    expect(output()).toContain(`${LOCK_TIMEOUT_TEXT}\n`);
    expect(output()).toContain("Can't reach Assay to renew the sign-in right now. Try again later.");
    expect(output()).toContain("Unlock your keychain, then try again.");
    expect(output()).not.toContain("assay_rt_secretvalue");
  });
});

describe("R-MCP-7: no command emits the delegate key or a token", () => {
  it("every command's output channels and files are clean", async () => {
    const as = new FakeAs();
    as.clock = NOW;
    await as.start();
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(input instanceof Request ? input.url : String(input instanceof URL ? input.href : input));
        return realFetch(`http://127.0.0.1:${as.port}${u.pathname}${u.search}`, init);
      }) as typeof fetch);
      const pair = as.seedGrant();
      addDevOrigin(dir, E2E_MCP);
      await seedProfile("e2e", { delegate: true, payer: true });
      seedSecret("default", "e2e", "refresh_token", pair.refreshToken);
      seedSecret("default", "e2e", "access_token", JSON.stringify({ token: pair.accessToken, expiresAt: pair.expiresAt }));
      seedSecret("default", "e2e", "delegate_key", PRIVATE_KEY);
      chainResult = { ok: false, code: "CHAIN_UNCONFIRMED", reason: "x" };
      writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { assay: { command: "npx", args: ["-y", "@goassay-ai/mcp@1.2.3"], env: { ASSAY_API_KEY: "assay_sk_live_projectsecret0000" } } } }));
      const stdout = vi.spyOn(process.stdout, "write");
      confirmAnswer = true;
      const tty = deps({ isTTY: true, env: E2E_ENV });
      const plain = deps({ env: E2E_ENV });
      await runStatus([], plain);
      await runLimits([], plain);
      await runLimits(["set", "--per-call", "1", "--per-day", "5"], tty);
      await runPaidUrlChange("allow-paid", [`${E2E_MCP}/c/weather`], tty);
      await runPaidUrlChange("disallow-paid", [`${E2E_MCP}/c/weather`], tty);
      await runSettings(["set", "--allow-env-proxy", "on"], tty);
      await runSettings([], plain);
      await runDevAllow([E2E_MCP], tty);
      await runEnablePaid([], plain);
      await runDoctor([], plain);
      await runLogin([], {
        ...plain,
        signIn: {
          openBrowser: (url) => {
            opened.push(url);
            const target = as.approve(url);
            setImmediate(() => void realFetch(target).then((r) => r.text()).catch(() => {}));
            return Promise.resolve(true);
          },
        },
      });
      await runLogout([], plain);
      expect(stdout).not.toHaveBeenCalled();

      const channels = [output(), ...opened, ...Object.keys(snapshot(dir)), ...Object.values(snapshot(dir))].join("\n");
      expect(channels).not.toContain(PRIVATE_KEY.slice(2));
      expect(channels).not.toContain(pair.refreshToken);
      expect(channels).not.toContain(pair.accessToken);
      expect(channels).not.toContain("projectsecret");
      expect(channels).not.toMatch(TOKEN_PATTERN);
      expect(channels).not.toMatch(HEX32_PATTERN);
      // Network: the delegate key never left the process.
      for (const r of as.requests) expect(JSON.stringify(r)).not.toContain(PRIVATE_KEY.slice(2));
    } finally {
      await as.stop();
    }
  });
});

describe("format helpers", () => {
  it("dollars, dates and fingerprints", () => {
    expect(unitsToUsd(500000n, 6)).toBe("$0.50");
    expect(unitsToUsd("5000000", 6)).toBe("$5");
    expect(unitsToUsd(1_200_000n, 6)).toBe("$1.20");
    expect(unitsToUsd(1n, 6)).toBe("$0.000001");
    expect(unitsToUsd(0n, 6)).toBe("$0");
    expect(usd("0.50")).toBe("$0.50");
    expect(usd("5")).toBe("$5");
    expect(usd("5.00")).toBe("$5");
    expect(utcDate(UNTIL)).toBe("2026-11-18");
    expect(utcDate("18446744073709551615")).toBe("never");
    expect(fingerprint(DELEGATE)).toBe("1A2B 9F3C");
    expect(() => fingerprint("0x12")).toThrow();
  });
});

describe("Windows .cmd shims (CARRY 2.11)", () => {
  const exists = (p: string) => p === "C:\\Windows\\System32\\cmd.exe";
  it("runs an .exe directly and a .cmd through the absolute cmd.exe with strict quoting", () => {
    expect(invocationFor("C:\\Tools\\claude.exe", ["mcp", "add"], "win32", {}, exists)).toEqual({ file: "C:\\Tools\\claude.exe", args: ["mcp", "add"], windowsVerbatimArguments: false });
    const inv = invocationFor("C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd", ["mcp", "add", "--url", "https://mcp.assay.ai/?tools=a&free=1"], "win32", {}, exists);
    expect(inv.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(inv.windowsVerbatimArguments).toBe(true);
    expect(inv.args).toEqual(["/d", "/s", "/c", '""C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd" "mcp" "add" "--url" "https://mcp.assay.ai/?tools=a&free=1""']);
  });

  it.each(['a"b', "%PATH%", "!x!", "a^b", "a\nb", "trail\\", "a\u0000b", "$(x)", "a;b", "a|b"])("refuses %j through cmd.exe", (word) => {
    expect(() => invocationFor("C:\\npm\\claude.cmd", ["mcp", word], "win32", {}, exists)).toThrow(/refusing/);
  });

  it("refuses relative paths, other extensions, and a cmd.exe outside the system directory", () => {
    expect(() => invocationFor("claude.cmd", [], "win32", {}, exists)).toThrow(/absolute/);
    expect(() => invocationFor("C:\\npm\\claude", [], "win32", {}, exists)).toThrow(/\.exe or \.cmd/);
    expect(() => invocationFor("C:\\npm\\claude.ps1", [], "win32", {}, exists)).toThrow();
    expect(windowsCmdExe({ SystemRoot: "D:\\Windows" }, (p) => p === "D:\\Windows\\System32\\cmd.exe")).toBe("D:\\Windows\\System32\\cmd.exe");
    for (const root of [".\\repo", "\\\\server\\share\\Windows", "C:\\repo\\..\\Windows", "C:\\proj"]) {
      expect(windowsCmdExe({ SystemRoot: root }, () => false)).toBeNull();
    }
    expect(invocationFor("/usr/local/bin/claude", ["mcp"], "darwin")).toEqual({ file: "/usr/local/bin/claude", args: ["mcp"], windowsVerbatimArguments: false });
  });
});

describe("L(u) from tools/list (CARRY 2.11)", () => {
  let server: Server;
  let port: number;
  let tools: string[];
  let seenAuth: (string | undefined)[];
  let sse: boolean;

  beforeEach(async () => {
    tools = ["search_tools", "get_tool", "call_tool"];
    seenAuth = [];
    sse = false;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        seenAuth.push(req.headers.authorization);
        if (req.headers.authorization !== "Bearer assay_at_good") return void res.writeHead(401).end();
        const msg = JSON.parse(body) as { id?: number; method: string; params?: { cursor?: string } };
        if (msg.id === undefined) return void res.writeHead(202).end();
        let result: unknown = {};
        if (msg.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "assay", version: "x" } };
        if (msg.method === "tools/list") {
          const page = msg.params?.cursor === "p2" ? tools.slice(2) : tools.slice(0, 2);
          result = { tools: page.map((name) => ({ name, inputSchema: {} })), ...(msg.params?.cursor === "p2" ? {} : { nextCursor: "p2" }) };
        }
        const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
        if (sse) res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${payload}\n\n`);
        else res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(payload);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(input instanceof Request ? input.url : String(input instanceof URL ? input.href : input));
      return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
    }) as typeof fetch);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const e2e = () => resolveDeployment({ url: `${E2E_MCP}/c/weather`, env: E2E_ENV, devOrigins: [E2E_MCP], warn: () => {} });

  it("measures the longest tool over every page (JSON and SSE); assay_sign_in counts", async () => {
    expect(await measureLongestTool(e2e(), `${E2E_MCP}/c/weather`, "assay_at_good")).toBe(13);
    tools = ["a", "b", "weather_forecast_hourly_x"];
    expect(await measureLongestTool(e2e(), `${E2E_MCP}/c/weather`, "assay_at_good")).toBe(25);
    sse = true;
    expect(await measureLongestTool(e2e(), `${E2E_MCP}/c/weather`, "assay_at_good")).toBe(25);
    expect(await measureLongestTool(e2e(), `${E2E_MCP}/c/weather`, "assay_at_bad")).toBeNull();
    expect(pickResponse("application/json", "not json", 1)).toBeNull();
  });

  it("tokenLongestTool uses the profile's token; signed out gives null (L = 48)", async () => {
    addDevOrigin(dir, E2E_MCP);
    tools = ["x", "y", "a".repeat(20)];
    const os: OsKeychain = { probe: async () => {}, forScope: (scope) => new Keychain(keyring, scope) };
    const measure = tokenLongestTool({ dir, env: E2E_ENV, openKeychain: async () => os });
    const url = { url: `${E2E_MCP}/c/weather`, pathAndQuery: "/c/weather", kind: "CATEGORY" as const, slugWords: ["weather"], dev: true, environment: "e2e" as const };
    expect(await measure("default", url)).toBeNull();
    expect(seenAuth).toEqual([]);
    seedSecret("default", "e2e", "access_token", JSON.stringify({ token: "assay_at_good", expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
    seedSecret("default", "e2e", "refresh_token", "assay_rt_x");
    expect(await measure("default", url)).toBe(20);
    expect(seenAuth.every((a) => a === "Bearer assay_at_good")).toBe(true);
    // In dev mode only ASSAY_DEV_API_KEY is used, never ASSAY_API_KEY.
    const withKey = tokenLongestTool({ dir, env: { ...E2E_ENV, ASSAY_API_KEY: "assay_sk_live_aaaaaaaaaaaaaaaaaaaa" }, openKeychain: async () => os });
    seenAuth = [];
    expect(await withKey("default", url)).toBe(20);
    expect(seenAuth.every((a) => a === "Bearer assay_at_good")).toBe(true);
  });
});

describe("client CLI runner (review I1, M4)", () => {
  type Call = { file: string; args: readonly string[]; options: Record<string, unknown> };
  function fakeExec(calls: Call[]) {
    return ((file: string, args: readonly string[], options: Record<string, unknown>, cb: (e: Error | null, out: string, err: string) => void) => {
      calls.push({ file, args, options });
      cb(null, "", "");
    }) as unknown as typeof import("node:child_process").execFile;
  }
  const winExists = (p: string) => p === "C:\\Windows\\System32\\cmd.exe";

  it("POSIX: spawns the absolute path from which(), never the bare name, and refuses a relative result", async () => {
    const calls: Call[] = [];
    const run = makeRunner({ platform: "darwin", env: {}, which: () => "/opt/bin/claude", execFile: fakeExec(calls), exists: () => true, safeCwds: [] });
    await run("claude", ["mcp", "list"], { cwd: home });
    expect(calls[0]!.file).toBe("/opt/bin/claude");
    expect(calls[0]!.options).toMatchObject({ shell: false, cwd: home });
    expect(calls[0]!.options.env).toBeUndefined();
    for (const bad of ["claude", "./claude", null]) {
      const r = makeRunner({ platform: "darwin", env: {}, which: () => bad, execFile: fakeExec(calls), exists: () => true, safeCwds: [] });
      await expect(r("claude", [], { cwd: home })).rejects.toThrow(/not found/);
    }
    expect(calls).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("POSIX, real execFile: the program started is the absolute path in an absolute PATH entry", async () => {
    const bin = join(base, "bin");
    mkdirSync(bin);
    const record = join(base, "argv0");
    writeFileSync(join(bin, "fakecli"), `#!/bin/sh\nprintf '%s' "$0" > '${record}'\n`, { mode: 0o755 });
    const { execFile } = await import("node:child_process");
    const run = makeRunner({ platform: process.platform, env: {}, which: (b) => which(b, `relative:${bin}`), execFile, exists: () => true, safeCwds: [] });
    await run("fakecli", [], { cwd: home });
    expect(readFileSync(record, "utf8")).toBe(join(bin, "fakecli"));
  });

  it("Windows: every child gets NoDefaultCurrentDirectoryInExePath=1 and runs only in the home directory", async () => {
    const calls: Call[] = [];
    const winHome = "C:\\Users\\u";
    const mk = (path: string) => makeRunner({ platform: "win32", env: { PATH: "x" }, which: () => path, execFile: fakeExec(calls), exists: winExists, safeCwds: [winHome] });
    await mk("C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd")("claude", ["mcp", "list"], { cwd: winHome });
    await mk("C:\\Tools\\claude.exe")("claude", ["mcp", "list"], { cwd: "c:\\users\\U\\" });
    expect(calls).toHaveLength(2);
    for (const c of calls) expect((c.options.env as Record<string, string>)[NO_CWD_EXE_SEARCH]).toBe("1");
    expect(calls[0]!.file).toBe("C:\\Windows\\System32\\cmd.exe");
    await expect(mk("C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd")("claude", ["mcp", "add"], { cwd: "C:\\code\\project" })).rejects.toThrow(/only from your home directory/);
    expect(calls).toHaveLength(2);
  });

  it("the Windows browser launcher env also sets it", async () => {
    const { launcherEnv } = await import("../src/oauth/flow.js");
    expect(launcherEnv("win32", { BROWSER: "x" })).toEqual({ NoDefaultCurrentDirectoryInExePath: "1" });
    expect(launcherEnv("darwin", {}).NoDefaultCurrentDirectoryInExePath).toBeUndefined();
  });
});

describe("doctor escapes hostile names (review M3)", () => {
  it("control characters in server names and env keys are printed as \\uXXXX", async () => {
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { "assay\u001b[2K": { command: "npx", args: ["-y", "@goassay-ai/mcp@1.2.3"], env: { "X\u001b]8;;http://evil\u0007": "1" } } } }),
    );
    expect(await runDoctor([], deps())).toBe(1);
    expect(output()).not.toContain("\u001b");
    expect(output()).not.toContain("\u0007");
    expect(output()).toContain("assay\\u001b[2K");
    expect(output()).toContain("X\\u001b]8;;http://evil\\u0007");
    expect(printable("a\u202eb\u2028c")).toBe("a\\u202eb\\u2028c");
  });
});

describe("global guard (review I2)", () => {
  it("fingerprints a directory and throws when it changes", () => {
    const watched = join(base, "watched");
    const teardown = guard(watched);
    expect(() => teardown()).not.toThrow();
    const again = guard(watched);
    mkdirSync(watched);
    expect(() => again()).toThrow(/changed the real profile directory/);
    expect(fingerprintDir(watched)).toContain("watched d");
  });

  it("R1-N1: catches a write through a profile directory that is itself a symlink", () => {
    const target = join(base, "real-target");
    mkdirSync(target);
    const link = join(base, "linked-profile");
    symlinkSync(target, link);
    const teardown = guard(link);
    writeFileSync(join(link, "default.json"), "{}");
    expect(() => teardown()).toThrow(/changed the real profile directory/);
    // The resolved path is part of the fingerprint: re-pointing the link is a change too.
    const other = join(base, "other-target");
    mkdirSync(other);
    const repoint = guard(link);
    const before = statSync(link, { bigint: false }).mtimeMs;
    unlinkSync(link);
    symlinkSync(other, link);
    // Same link mtime as before, so only the resolved path tells the two apart.
    lutimesSync(link, new Date(before), new Date(before));
    const fp = fingerprintDir(link);
    expect(fp).toContain(`resolves to ${realpathSync(other)}`);
    expect(() => repoint()).toThrow(/changed the real profile directory/);
  });

  it("F4 M4: catches a write through a symlink below the profile directory, and survives a cycle", () => {
    const root = join(base, "m4-root");
    const elsewhere = join(base, "m4-elsewhere");
    mkdirSync(root);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "profiles"));
    symlinkSync(root, join(root, "loop"));
    const teardown = guard(root);
    writeFileSync(join(elsewhere, "default.json"), "{}");
    expect(() => teardown()).toThrow(/changed the real profile directory/);
  });

  it("every default dependency points at the temporary home", async () => {
    const { defaultProfileDeps } = await import("../src/commands/profile-context.js");
    expect(defaultProfileDeps().dir).toBe(configDir());
    expect(configDir().startsWith(testHome())).toBe(true);
  });
});

describe("signsOutText", () => {
  it("says nothing when add installed no server, and reads naturally for one", () => {
    expect(signsOutText(0)).toBeNull();
    expect(signsOutText(1)).toBe("This signs out the Assay server on this computer.");
    expect(signsOutText(3)).toBe("This signs out all 3 Assay servers on this computer.");
  });
});
