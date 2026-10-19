import { describe, expect, it } from "vitest";
import { parseServeArgs } from "../src/commands/serve.js";
import { AliasTable } from "../src/proxy/aliases.js";
import { CallRegistry, CONFIRMATION_TTL_MS } from "../src/proxy/calls.js";
import { checkEnvironment } from "../src/proxy/environment.js";
import { reasonOf } from "../src/proxy/forwarder.js";
import { appName, SignInController } from "../src/proxy/presignin.js";
import { classify, negotiateVersion, SUPPORTED_PROTOCOL_VERSIONS } from "../src/proxy/protocol.js";
import { LineSplitter } from "../src/proxy/stdio.js";
import { createLogger } from "../src/log/logger.js";
import { PinnedFetchError } from "../src/net/fetch.js";

describe("protocol", () => {
  it("supports the backend bridge's versions, newest first", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]);
    expect(negotiateVersion("2025-06-18")).toBe("2025-06-18");
    expect(negotiateVersion("2024-11-05")).toBe("2026-07-28");
    expect(negotiateVersion(undefined)).toBe("2026-07-28");
  });

  it("keeps only JSON-RPC members and refuses bad shapes", () => {
    expect(classify({ jsonrpc: "2.0", id: 1, method: "m", extra: 1 })).toEqual({ kind: "request", message: { jsonrpc: "2.0", id: 1, method: "m" } });
    expect(classify({ jsonrpc: "2.0", id: 1, result: {}, evil: true })).toEqual({ kind: "response", message: { jsonrpc: "2.0", id: 1, result: {} } });
    expect(classify({ jsonrpc: "2.0", id: 1, result: "x" }).kind).toBe("invalid");
    expect(classify({ jsonrpc: "2.0", id: {}, method: "m" }).kind).toBe("invalid");
    expect(classify({ jsonrpc: "2.0", method: "m", params: [1] }).kind).toBe("invalid");
    expect(classify({ jsonrpc: "1.0", method: "m" }).kind).toBe("invalid");
    expect(classify({ jsonrpc: "2.0", id: 2, error: { code: 1.5, message: "x" } }).kind).toBe("invalid");
  });
});

describe("stdio line splitter", () => {
  it("splits lines across chunks, strips CR, skips blank lines", () => {
    const s = new LineSplitter(100);
    expect(s.push(Buffer.from('{"a":1}\r\n\n{"b"'))).toEqual([{ kind: "line", text: '{"a":1}' }]);
    expect(s.push(Buffer.from(':2}\n'))).toEqual([{ kind: "line", text: '{"b":2}' }]);
    expect(s.push(Buffer.from("tail"))).toEqual([]);
    expect(s.end()).toEqual([{ kind: "line", text: "tail" }]);
  });

  it("drops an oversized line whole and reports it once", () => {
    const s = new LineSplitter(8);
    expect(s.push(Buffer.from("123456"))).toEqual([]);
    expect(s.push(Buffer.from("789012345"))).toEqual([{ kind: "oversized" }]);
    expect(s.push(Buffer.from("more\nok\n"))).toEqual([{ kind: "line", text: "ok" }]);
  });
});

describe("call records (pairing, one voucher, single-use confirmation)", () => {
  it("refuses a second record for an id in flight; 1 and '1' are different ids", () => {
    const r = new CallRegistry();
    const a = r.begin(1, "t", {})!;
    expect(r.begin(1, "t", {})).toBeNull();
    expect(r.begin("1", "t", {})).not.toBeNull();
    r.end(a);
    expect(r.begin(1, "t", {})).not.toBeNull();
  });

  it("allows one voucher per call", () => {
    const call = new CallRegistry().begin(1, "t", {})!;
    expect(call.claimVoucher()).toBe(true);
    expect(call.claimVoucher()).toBe(false);
    expect(call.vouchers).toBe(1);
  });

  it("confirmation tokens are single use, die with the call, and expire after 120 s", () => {
    let now = 1_000;
    const r = new CallRegistry(() => now);
    const call = r.begin(1, "t", {})!;
    const t1 = r.issueConfirmation(call);
    expect(r.consumeConfirmation(t1)).toEqual({ kind: "ok", call });
    expect(r.consumeConfirmation(t1)).toEqual({ kind: "unknown" });
    const t2 = r.issueConfirmation(call);
    now += CONFIRMATION_TTL_MS + 1;
    expect(r.consumeConfirmation(t2)).toEqual({ kind: "expired", call });
    const t3 = r.issueConfirmation(call);
    r.end(call);
    expect(r.consumeConfirmation(t3)).toEqual({ kind: "unknown" });
    expect(() => r.issueConfirmation(call)).toThrow();
  });
});

describe("environment checks (2.4-N1)", () => {
  const none = () => ({ allowEnvProxy: false });
  const yes = () => ({ allowEnvProxy: true });
  it("refuses TLS off whatever the settings", () => {
    expect(checkEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, [], yes, "s").refusals).toHaveLength(1);
    expect(checkEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "1" }, [], none, "s").refusals).toHaveLength(0);
  });
  it.each([{ HTTPS_PROXY: "x" }, { HTTP_PROXY: "x" }, { https_proxy: "x" }, { NODE_USE_ENV_PROXY: "1" }, { NODE_OPTIONS: "--max-old-space-size=1 --use-env-proxy" }])(
    "refuses an env proxy %o unless the profile allows it",
    (env) => {
      expect(checkEnvironment(env, [], none, "s").refusals).toHaveLength(1);
      expect(checkEnvironment(env, [], yes, "s").refusals).toHaveLength(0);
    },
  );
  it("reads the settings only when a proxy is set, and warns on extra CAs", () => {
    let reads = 0;
    const v = checkEnvironment({ NODE_EXTRA_CA_CERTS: "/x.pem" }, [], () => (reads++, { allowEnvProxy: false }), "s");
    expect(reads).toBe(0);
    expect(v).toEqual({ refusals: [], warnings: [expect.stringContaining("NODE_EXTRA_CA_CERTS")] });
    expect(checkEnvironment({}, ["--use-env-proxy"], none, "s").refusals).toHaveLength(1);
  });
});

describe("sign-in controller", () => {
  it("prints first, opens the browser on the first call only, and runs one sign-in at a time", async () => {
    const opened: string[] = [];
    let starts = 0;
    let finish!: () => void;
    const c = new SignInController(
      async (hooks) => {
        starts++;
        hooks.onLink("http://localhost:3200/oauth/authorize?x=1");
        await hooks.openBrowser("http://localhost:3200/oauth/authorize?x=1");
        await new Promise<void>((r) => (finish = r));
      },
      async (u) => (opened.push(u), true),
    );
    expect(await c.begin(false)).toContain("authorize");
    expect(opened).toEqual([]);
    await c.begin(true);
    await c.begin(true);
    expect(opened).toHaveLength(1);
    expect(starts).toBe(1);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.active).toBe(false);
  });

  it("rejects when the sign-in cannot start", async () => {
    const c = new SignInController(async () => {
      throw new Error("LOCK_TIMEOUT");
    }, async () => true);
    await expect(c.begin(true)).rejects.toThrow("LOCK_TIMEOUT");
  });

  it("names the app from clientInfo, safely", () => {
    expect(appName({ name: "claude-code" })).toBe("claude-code");
    expect(appName({ name: "x", title: "Claude Desktop" })).toBe("Claude Desktop");
    expect(appName({ name: "\u001b[31mHost\n" })).toBe("31mHost");
    expect(appName({ name: "\u001b\n" })).toBe("your app");
    expect(appName(null)).toBe("your app");
  });
});

describe("alias table", () => {
  it("rebuilds per list, maps back, and warns once per tool", () => {
    const lines: string[] = [];
    const t = new AliasTable("assay-weather", createLogger({ level: "warn", stderr: (l) => lines.push(l) }));
    const long = "a".repeat(60);
    const first = t.rewriteList({ tools: [{ name: long }, { name: "b" }] }, true);
    const alias = (first.tools as { name: string }[])[0]!.name;
    expect(alias).not.toBe(long);
    expect(t.original(alias)).toBe(long);
    expect(t.original("b")).toBe("b");
    t.rewriteList({ tools: [{ name: long }] }, true);
    expect(lines).toHaveLength(1);
    t.rewriteList({ tools: [{ name: "c" }] }, true);
    expect(t.original(alias)).toBe(alias);
  });
});

describe("serve flags", () => {
  it("parses and refuses", () => {
    expect(parseServeArgs(["--url", "/c/weather", "--name=assay-weather", "--no-paid", "--log-level", "debug"])).toMatchObject({ url: "/c/weather", name: "assay-weather", noPaid: true, logLevel: "debug" });
    expect(parseServeArgs(["--log-file", "rel.log"])).toEqual({ error: "--log-file must be an absolute path" });
    expect(parseServeArgs(["--name", "Bad_Name"])).toHaveProperty("error");
    expect(parseServeArgs(["--profile", "../x"])).toHaveProperty("error");
    expect(parseServeArgs(["--bogus"])).toHaveProperty("error");
  });

  it("gives a short reason for -32003", () => {
    expect(reasonOf(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }))).toBe("ECONNREFUSED");
    expect(reasonOf(new PinnedFetchError("x"))).toBe("blocked: not an Assay address");
    expect(reasonOf(new Error("assay_at_secret"))).toBe("network error");
  });
});
