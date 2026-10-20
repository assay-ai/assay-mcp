import { RUN } from "../src/version.js";
import { describe, expect, it } from "vitest";
import { parseServeArgs } from "../src/commands/serve.js";
import { AliasTable } from "../src/proxy/aliases.js";
import { CallRegistry, CONFIRMATION_TTL_MS, TOMBSTONE_MS } from "../src/proxy/calls.js";
import { checkEnvironment } from "../src/proxy/environment.js";
import { Forwarder, reasonOf } from "../src/proxy/forwarder.js";
import { answerSignedOut, appName, loginCommand, SIGN_IN_AGAIN_DESCRIPTION, SIGN_IN_DESCRIPTION, SignInController, signInEndedText } from "../src/proxy/presignin.js";
import { classify, negotiateVersion, SUPPORTED_PROTOCOL_VERSIONS } from "../src/proxy/protocol.js";
import { LineSplitter } from "../src/proxy/stdio.js";
import { apiGet, apiRequest, BIND_TEXTS, BindError } from "../src/proxy/delegate-bind.js";
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
    const t4 = r.issueConfirmation(call);
    r.end(call);
    // A "Pay" after the call ended is told apart from an unknown token, once (review M11).
    expect(r.consumeConfirmation(t3)).toEqual({ kind: "expired", call });
    expect(r.consumeConfirmation(t3)).toEqual({ kind: "unknown" });
    now += TOMBSTONE_MS;
    expect(r.consumeConfirmation(t4)).toEqual({ kind: "unknown" });
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
  it("the env-proxy refusal points to the TTY command that writes the opt-in", () => {
    expect(checkEnvironment({ HTTPS_PROXY: "x" }, [], none, "default").refusals[0]).toContain(`run in a terminal: ${RUN} settings set --allow-env-proxy on`);
    expect(checkEnvironment({ HTTPS_PROXY: "x" }, [], none, "work").refusals[0]).toMatch(/settings set --allow-env-proxy on --profile work$/);
  });

  it("reads the settings only when a proxy is set, and warns on extra CAs", () => {
    let reads = 0;
    const v = checkEnvironment({ NODE_EXTRA_CA_CERTS: "/x.pem" }, [], () => (reads++, { allowEnvProxy: false }), "s");
    expect(reads).toBe(0);
    expect(v).toEqual({ refusals: [], warnings: [expect.stringContaining("NODE_EXTRA_CA_CERTS")] });
    expect(checkEnvironment({}, ["--use-env-proxy"], none, "s").refusals).toHaveLength(1);
  });
});

describe("sign-in controller", () => {
  const busy = () => new Error("busy");

  it("prints first, opens the browser on the first call only, and runs one sign-in at a time", async () => {
    const opened: string[] = [];
    let starts = 0;
    let activations = 0;
    let finish!: () => void;
    const c = new SignInController(
      async (hooks) => {
        starts++;
        expect(hooks.passive).toBe(true);
        hooks.onMarker(async () => (activations++, true));
        hooks.onLink("http://localhost:3200/oauth/authorize?x=1");
        await hooks.openBrowser("http://localhost:3200/oauth/authorize?x=1");
        await new Promise<void>((r) => (finish = r));
      },
      async (u) => (opened.push(u), true),
      busy,
    );
    expect(await c.begin(false)).toContain("authorize");
    expect(opened).toEqual([]);
    await c.begin(true);
    await c.begin(true);
    expect(opened).toHaveLength(1);
    expect(activations).toBe(1);
    expect(starts).toBe(1);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.active).toBe(false);
  });

  it("a passive sign-in taken over elsewhere opens nothing and is cancelled", async () => {
    const opened: string[] = [];
    let signal!: AbortSignal;
    const c = new SignInController(
      async (hooks) => {
        signal = hooks.signal;
        hooks.onMarker(async () => false);
        hooks.onLink("http://localhost:3200/oauth/authorize?x=1");
        await new Promise((r) => hooks.signal.addEventListener("abort", r));
      },
      async (u) => (opened.push(u), true),
      busy,
    );
    await c.begin(false);
    await expect(c.begin(true)).rejects.toThrow("busy");
    expect(opened).toEqual([]);
    expect(signal.aborted).toBe(true);
  });

  it("an active sign-in opens the browser at once", async () => {
    const opened: string[] = [];
    const c = new SignInController(
      async (hooks) => {
        expect(hooks.passive).toBe(false);
        hooks.onLink("http://localhost:3200/oauth/authorize?x=2");
        await hooks.openBrowser("http://localhost:3200/oauth/authorize?x=2");
      },
      async (u) => (opened.push(u), true),
      busy,
    );
    await c.begin(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toHaveLength(1);
  });

  it("rejects when the sign-in cannot start", async () => {
    const c = new SignInController(
      async () => {
        throw new Error("LOCK_TIMEOUT");
      },
      async () => true,
      busy,
    );
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

describe("sign-in ended texts (owner decision 2026-10-21)", () => {
  it("names the login command, with --profile only for a named profile", () => {
    expect(loginCommand("default")).toBe(`${RUN} login`);
    expect(loginCommand("work")).toBe(`${RUN} login --profile work`);
  });

  it("puts the command and the link on their own lines; no link line without a link", () => {
    expect(signInEndedText("https://x.example/a", "Cursor", "work").split("\n")).toEqual([
      "Your Assay sign-in was ended on the web, or it expired. To sign in again, run in a terminal:",
      `${RUN} login --profile work`,
      "or open this link in your browser:",
      "https://x.example/a",
      "Assay tools appear here when you're done (if they don't, restart Cursor).",
    ]);
    expect(signInEndedText(null, "Cursor", "default")).not.toContain("open this link");
  });

  it("tools/list describes the sign-in tool by state", () => {
    const description = (ended: boolean) => ((answerSignedOut("tools/list", ended) as { result: { tools: { description: string }[] } }).result.tools[0]!.description);
    expect(description(false)).toBe(SIGN_IN_DESCRIPTION);
    expect(description(true)).toBe(SIGN_IN_AGAIN_DESCRIPTION);
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

describe("delegate binding API refusals (M9)", () => {
  const answer = (status: number, body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  const call = (fetch: () => Promise<Response>) => apiRequest(fetch, "http://localhost:3000/api/v1", "assay_at_x", "POST", "/agents/me/delegate", {});

  it("a key still bound to another credential gets its own text", async () => {
    const refused = answer(409, { success: false, error: { code: "ACCOUNT_DELEGATE_ALREADY_BOUND", message: "already bound" } });
    await expect(call(refused)).rejects.toBeInstanceOf(BindError);
    await expect(call(refused)).rejects.toThrow(BIND_TEXTS.alreadyBound);
    expect(BIND_TEXTS.alreadyBound).toMatch(/still bound to another Assay connection\. Run logout, then login/);
  });

  it("any other refusal stays a generic failure", async () => {
    expect(await call(answer(409, { error: { code: "SOMETHING_ELSE" } }))).toBeNull();
    expect(await call(() => Promise.resolve(new Response("not json", { status: 409 })))).toBeNull();
    expect(await call(answer(400, { error: { code: "ACCOUNT_DELEGATE_ALREADY_BOUND" } }))).toBeNull();
    expect(await call(answer(200, { data: { ok: true } }))).toMatchObject({ body: { data: { ok: true } } });
  });

  it("apiGet tells a 404 (a route an older backend lacks) from a failure; apiRequest does not", async () => {
    const get = (fetch: () => Promise<Response>) => apiGet(fetch, "http://localhost:3000/api/v1", "assay_at_x", "/agents/me/delegate/status");
    expect(await get(answer(404, { message: "Cannot GET" }))).toBe("not-found");
    expect(await get(answer(500, {}))).toBeNull();
    expect(await get(answer(409, { error: { code: "ACCOUNT_DELEGATE_ALREADY_BOUND" } }))).toBeNull();
    expect(await get(() => Promise.reject(new Error("down")))).toBeNull();
    expect(await get(answer(200, { data: { bound: true } }))).toMatchObject({ body: { data: { bound: true } } });
    expect(await call(answer(404, {}))).toBeNull();
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

  it("refuses a repeated flag, like every other command", () => {
    expect(parseServeArgs(["--url", "/a", "--url", "/b"])).toEqual({ error: "--url is given more than once" });
    expect(parseServeArgs(["--name=a", "--name", "b"])).toEqual({ error: "--name is given more than once" });
    expect(parseServeArgs(["--no-paid", "--no-paid"])).toEqual({ error: "--no-paid is given more than once" });
    expect(parseServeArgs(["--profile", "a", "--log-level", "info", "--profile", "a"])).toEqual({ error: "--profile is given more than once" });
  });

  it("gives a short reason for -32003", () => {
    expect(reasonOf(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }))).toBe("ECONNREFUSED");
    expect(reasonOf(new PinnedFetchError("x"))).toBe("blocked: not an Assay address");
    expect(reasonOf(new Error("assay_at_secret"))).toBe("network error");
  });
});

describe("forwarder concurrency (re-review R1-M2, R1-M3)", () => {
  function held() {
    let open = 0;
    let peak = 0;
    const pending: (() => void)[] = [];
    const fetch = async (_url: string, init: { body?: unknown }) => {
      open++;
      peak = Math.max(peak, open);
      const id = (JSON.parse(String(init.body)) as { id: number }).id;
      await new Promise<void>((r) => pending.push(r));
      open--;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), { headers: { "content-type": "application/json" } });
    };
    return { fetch, pending, peak: () => peak, open: () => open };
  }
  const send = (f: Forwarder, id: number) => f.send({ id, body: JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }), bearer: "t", version: "2025-06-18" });
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it("at most 4 requests in flight; a fifth waits, then gets -32002 after the queue wait", async () => {
    const h = held();
    const f = new Forwarder({ url: "http://localhost:3200/", fetch: h.fetch, queueWaitMs: 100 });
    const first = [1, 2, 3, 4].map((i) => send(f, i));
    const fifth = send(f, 5);
    await tick();
    expect(h.open()).toBe(4);
    expect(await fifth).toEqual({ kind: "error", code: -32002, message: "Assay is busy with other calls from this app. Try again." });
    for (const r of h.pending.splice(0)) r();
    expect((await Promise.all(first)).every((o) => o.kind === "response")).toBe(true);
    expect(h.peak()).toBe(4);
  });

  it("a queued request runs when a slot frees", async () => {
    const h = held();
    const f = new Forwarder({ url: "http://localhost:3200/", fetch: h.fetch, queueWaitMs: 5_000 });
    const all = [1, 2, 3, 4, 5, 6].map((i) => send(f, i));
    await tick();
    expect(h.open()).toBe(4);
    while (h.pending.length > 0 || h.open() > 0) {
      for (const r of h.pending.splice(0)) r();
      await tick();
    }
    expect((await Promise.all(all)).every((o) => o.kind === "response")).toBe(true);
    expect(h.peak()).toBe(4);
  });

  it("beyond 32 waiting, a request gets -32002 at once", async () => {
    const h = held();
    const f = new Forwarder({ url: "http://localhost:3200/", fetch: h.fetch, queueWaitMs: 60_000 });
    const running = Array.from({ length: 4 + 32 }, (_, i) => send(f, i + 1));
    await tick();
    const started = Date.now();
    expect(await send(f, 99)).toMatchObject({ kind: "error", code: -32002 });
    expect(Date.now() - started).toBeLessThan(50);
    while (h.pending.length > 0 || h.open() > 0) {
      for (const r of h.pending.splice(0)) r();
      await tick();
    }
    expect((await Promise.all(running)).every((o) => o.kind === "response")).toBe(true);
  });
});
