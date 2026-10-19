import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aliasTool } from "../src/clients/server-name.js";
import { addDevOrigin } from "../src/profile/dev-origins.js";
import { Keychain } from "../src/profile/keychain.js";
import { withLock } from "../src/profile/lock.js";
import { bundleFixture } from "./helpers/bundle.js";
import { E2E_MCP, FakeAs } from "./helpers/fake-as.js";
import { FakeMcp } from "./helpers/fake-mcp.js";
import { FileKeyring } from "./helpers/file-keyring.js";

/**
 * Task 2.8: the proxy driven over stdio, by the real MCP SDK client (and by a raw line driver
 * where exact bytes matter), against a local fake Assay (AS + MCP). No real network, no real
 * keychain: the forked `serve` uses a keyring file and reroutes the e2e origins to the fakes.
 */

const SECRET_RE = /assay_(at|rt|ac|sk_live)_[A-Za-z0-9_-]+/;
let fixture: { dir: string; file: string };
let as: FakeAs;
let mcp: FakeMcp;
let dir: string;
let keyringFile: string;
const children: ChildProcessWithoutNullStreams[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  fixture = await bundleFixture(join(__dirname, "fixtures/serve-child.ts"));
}, 60_000);

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

beforeEach(async () => {
  as = new FakeAs();
  as.clock = Math.floor(Date.now() / 1000);
  await as.start();
  mcp = new FakeMcp(as);
  await mcp.start();
  dir = mkdtempSync(join(tmpdir(), "assay-mcp-proxy-"));
  keyringFile = join(dir, "..", `${dir.split("/").pop()}-keyring.json`);
  addDevOrigin(dir, E2E_MCP);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await mcp.stop();
  await as.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(keyringFile, { force: true });
});

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ASSAY_MCP_DEV_ORIGINS: E2E_MCP,
    TEST_DIR: dir,
    TEST_KEYRING: keyringFile,
    TEST_AS_PORT: String(as.port),
    TEST_MCP_PORT: String(mcp.port),
    ...extra,
  };
}

async function until<T>(check: () => T | undefined | null | false, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stored grant, as an earlier sign-in would have left it. */
async function signedIn() {
  const pair = as.seedGrant();
  const keychain = new Keychain(new FileKeyring(keyringFile), { profile: "default", environment: "e2e" });
  await withLock({ dir, name: "default" }, (lock) =>
    keychain.storeTokens(lock, { refreshToken: pair.refreshToken, accessToken: { token: pair.accessToken, expiresAt: Math.floor(Date.now() / 1000) + 3600 } }),
  );
  return pair;
}

async function connect(args: string[] = [], extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture.file, "--url", `${E2E_MCP}/`, ...args],
    env: childEnv(extraEnv),
    stderr: "pipe",
  });
  const err: string[] = [];
  transport.stderr?.on("data", (c: Buffer) => err.push(c.toString("utf8")));
  const client = new Client({ name: "test-host", version: "1.0.0" });
  const changed: number[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changed.push(Date.now());
  });
  clients.push(client);
  await client.connect(transport);
  return { client, stderr: () => err.join(""), changed };
}

/** A raw stdio driver: exact lines in, every stdout line kept. */
function spawnRaw(args: string[] = [], extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [fixture.file, "--url", `${E2E_MCP}/`, ...args], { env: { PATH: process.env.PATH ?? "", ...childEnv(extraEnv) } });
  children.push(child);
  let out = "";
  let err = "";
  let newlines = 0;
  child.stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
    for (const b of c) if (b === 0x0a) newlines++;
  });
  child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
  const lines = () => out.split("\n").filter((l) => l !== "");
  const messages = () => lines().map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    child,
    send: (line: string) => child.stdin.write(`${line}\n`),
    lines,
    messages,
    stdout: () => out,
    lineCount: () => newlines,
    stderr: () => err,
    answer: (id: unknown) => until(() => messages().find((m) => m.id === id && !("method" in m))),
  };
}

const INIT = (v = "2025-06-18") =>
  JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "raw-host", version: "1" } } });

describe("pre-sign-in mode", () => {
  it("initialize answered without any network", async () => {
    const { client, stderr } = await connect();
    expect(client.getServerVersion()).toEqual({ name: "assay", version: "0.1.0" });
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
    expect(client.getInstructions()).toBe("If Assay tools are missing, call assay_sign_in.");
    // The startup link goes to stderr; the browser is not opened.
    const line = await until(() => /assay-mcp: sign in to Assay: (\S+)/.exec(stderr()));
    expect(line[1]).toMatch(/^http:\/\/localhost:3200\/oauth\/authorize\?/);
    await sleep(200);
    expect(mcp.opened).toEqual([]);
    expect(mcp.requests).toEqual([]);
    expect(mcp.fetched).toEqual([]);
    expect(as.requests).toEqual([]);
  });

  it("negotiates the host's version, else the newest supported", async () => {
    const raw = spawnRaw();
    raw.send(INIT("2025-03-26"));
    expect(((await raw.answer(0)).result as Record<string, unknown>).protocolVersion).toBe("2025-03-26");
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "h", version: "1" } } }));
    expect(((await raw.answer(1)).result as Record<string, unknown>).protocolVersion).toBe("2026-07-28");
  });

  it("tools/list → [assay_sign_in] only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      { name: "assay_sign_in", description: "Connect Assay. Opens your browser to approve, and returns the link.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    ]);
    expect((await client.listResources()).resources).toEqual([]);
    expect((await client.listPrompts()).prompts).toEqual([]);
  });

  it("sign-in → list_changed then the proxied list", async () => {
    const { client, changed } = await connect();
    const res = await client.callTool({ name: "assay_sign_in", arguments: {} });
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/^Approve in your browser: http:\/\/localhost:3200\/oauth\/authorize\?\S+\. Assay tools appear here when you're done \(if they don't, restart test-host\)\.$/);
    expect(res.isError).toBeUndefined();
    await until(() => changed.length > 0, 10_000);
    expect(mcp.opened).toHaveLength(1);
    expect(text).toContain(mcp.opened[0]!);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(changed).toHaveLength(1);
    // The credential id is read back and recorded in the profile.
    await until(() => existsSync(join(dir, "profiles", "default.json")));
  });

  it("invalid_grant → back to assay_sign_in", async () => {
    await signedIn();
    const { client, changed } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    as.grants[0]!.revoked = true; // the grant ends: 401, then the refresh gets invalid_grant
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["assay_sign_in"]);
    await until(() => changed.length === 1);
    expect(as.tokenCalls("refresh_token")).toHaveLength(1);
    expect(readFileSync(keyringFile, "utf8")).not.toMatch(/refresh_token|access_token/);
  });

  it("lock wait over the limit → -32001", async () => {
    let release!: () => void;
    const held = withLock({ dir, name: "default" }, () => new Promise<void>((r) => (release = r)));
    try {
      const { client } = await connect([], { TEST_LOCK_TIMEOUT_MS: "300" });
      const err = await client.callTool({ name: "assay_sign_in", arguments: {} }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(-32001);
      expect((err as McpError).message).toContain("Assay sign-in in progress in another window.");
    } finally {
      release();
      await held;
    }
  });
});

describe("signed-in forwarding", () => {
  it("each forwarded method byte-for-byte", async () => {
    const pair = await signedIn();
    const raw = spawnRaw();
    raw.send(INIT("2025-06-18"));
    await raw.answer(0);
    raw.send(`{"method":"notifications/initialized","jsonrpc":"2.0"}`);
    const lines = [
      `{"id":1,"jsonrpc":"2.0","method":"tools/list","params":{ }}`,
      `{"jsonrpc":"2.0","id":"c-2","method":"tools/call","params":{"name":"echo","arguments":{"q":"café \\u00e9","n":1.50}}}`,
      `{"jsonrpc":"2.0","id":3,"method":"resources/list"}`,
      `{"jsonrpc":"2.0","id":4,"method":"resources/templates/list","params":{}}`,
      `{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"assay://fake/r"}}`,
      `{"jsonrpc":"2.0","id":6,"method":"prompts/list"}`,
      `{"jsonrpc":"2.0","id":7,"method":"prompts/get","params":{"name":"p"}}`,
      `{"jsonrpc":"2.0","id":8,"method":"completion/complete","params":{"ref":{"type":"ref/prompt","name":"p"},"argument":{"name":"a","value":""}}}`,
      `{"jsonrpc":"2.0","id":9,"method":"logging/setLevel","params":{"level":"info"}}`,
      `{"jsonrpc":"2.0","id":10,"method":"ping"}`,
      `{"jsonrpc":"2.0","id":11,"method":"vendor/brand-new","params":{"x":[1,2,3]}}`,
    ];
    const notes = [
      `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":99,"reason":"x"}}`,
      `{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"t","progress":1}}`,
      `{"jsonrpc":"2.0","method":"notifications/roots/list_changed"}`,
    ];
    for (const l of lines) raw.send(l);
    for (const l of notes) raw.send(l);
    for (const l of lines) await raw.answer((JSON.parse(l) as { id: unknown }).id);
    await until(() => mcp.requests.length >= 2 + lines.length + notes.length);

    const bodies = mcp.requests.map((r) => r.raw);
    // The proxy's own lazy handshake first, then the host's bytes unchanged.
    expect(mcp.methods().slice(0, 2)).toEqual(["initialize", "notifications/initialized"]);
    expect(bodies[1]).toBe(`{"jsonrpc":"2.0","method":"notifications/initialized"}`);
    for (const l of [...lines, ...notes]) expect(bodies).toContain(l);
    expect(bodies.filter((b) => b.includes("initialized"))).toHaveLength(1);
    for (const r of mcp.requests) {
      expect(r.path).toBe("/");
      expect(r.headers["content-type"]).toBe("application/json");
      expect(r.headers.accept).toBe("application/json, text/event-stream");
      expect(r.headers["mcp-protocol-version"]).toBe("2025-06-18");
      expect(r.headers.authorization).toBe(`Bearer ${pair.accessToken}`);
      expect(r.headers["user-agent"]).toBe("assay-mcp/0.1.0");
    }
    expect(((await raw.answer(11)).result as Record<string, unknown>).echoed).toBe("vendor/brand-new");
    expect(raw.stderr()).not.toMatch(SECRET_RE);
  });

  it("SSE two events → two messages", async () => {
    await signedIn();
    mcp.respond = (msg, res) => {
      if (msg.method !== "tools/call") return false;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p", progress: 1 } })}\n\n`);
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "done" }] } })}\n\n`);
      return true;
    };
    const raw = spawnRaw();
    raw.send(INIT());
    await raw.answer(0);
    const before = raw.lines().length;
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } }));
    await raw.answer(1);
    const got = raw.messages().slice(before);
    expect(got).toEqual([
      { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p", progress: 1 } },
      { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "done" }] } },
    ]);
  });

  it("202 → nothing on stdout", async () => {
    await signedIn();
    const raw = spawnRaw();
    raw.send(INIT());
    await raw.answer(0);
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    await raw.answer(1);
    const before = raw.stdout();
    raw.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }));
    await until(() => mcp.methods().includes("notifications/cancelled"));
    await sleep(300);
    expect(raw.stdout()).toBe(before);
  });

  it("server request → -32601 to server, nothing to host", async () => {
    await signedIn();
    mcp.respond = (msg, res) => {
      if (msg.method !== "tools/call") return false;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "sampling/createMessage", params: { messages: [] } })}\n\n`);
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [] } })}\n\n`);
      return true;
    };
    const raw = spawnRaw();
    raw.send(INIT());
    await raw.answer(0);
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } }));
    await raw.answer(1);
    const reply = await until(() => mcp.messages().find((m) => m.id === "srv-1"));
    expect(reply).toEqual({ jsonrpc: "2.0", id: "srv-1", error: { code: -32601, message: "Method not found" } });
    expect(raw.stdout()).not.toContain("sampling/createMessage");
    // A host response to a server request is dropped: not forwarded, nothing written.
    const count = mcp.requests.length;
    const before = raw.stdout();
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: "srv-1", result: {} }));
    await sleep(300);
    expect(mcp.requests.length).toBe(count);
    expect(raw.stdout()).toBe(before);
  });

  it("stdout contains only JSON-RPC (parse every line), whatever the remote sends", async () => {
    await signedIn();
    const hostile: Record<string, (id: unknown, res: import("node:http").ServerResponse) => void> = {
      garbage: (_id, res) => res.writeHead(200, { "content-type": "application/json" }).end("not json\n{\n"),
      text: (_id, res) => res.writeHead(200, { "content-type": "text/plain" }).end("hello\nworld\n"),
      newlines: (id, res) => res.writeHead(200, { "content-type": "application/json" }).end(`{\n"jsonrpc":"2.0",\n"id":${JSON.stringify(id)},\n"result":{"content":[{"type":"text","text":"a\\nb\\u2028c\\r\\n"}]}\n}`),
      wrongId: (_id, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ jsonrpc: "2.0", id: "other", result: {} }, { jsonrpc: "2.0", id: 12345, result: {} }])),
      error500: (_id, res) => res.writeHead(500, { "content-type": "text/html" }).end("<html>\noops\n</html>"),
      sseJunk: (id, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {broken\n\n: comment\n\nevent: other\ndata: {}\n\n");
        res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } })}\n\n`);
      },
      noteExtra: (id, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "n" }, result: { evil: 1 }, extra: 2 })}\n\n`);
        res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: 2 } })}\n\n`);
      },
      notObject: (id, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: "string result" })),
      huge: (_id, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        const chunk = "x".repeat(1024 * 1024);
        let n = 0;
        const pump = () => {
          while (n < 20 && res.write(chunk)) n++;
          if (n < 20) res.once("drain", pump);
          else res.end();
        };
        pump();
      },
    };
    mcp.respond = (msg, res) => {
      const name = (msg.params as { name?: string } | undefined)?.name;
      const h = name ? hostile[name] : undefined;
      if (!h) return false;
      h(msg.id, res);
      return true;
    };
    const raw = spawnRaw();
    raw.send(INIT());
    await raw.answer(0);
    raw.send("this is not json");
    raw.send("[]");
    raw.send(`{"jsonrpc":"2.0","id":{"bad":1},"method":"x"}`);
    let id = 1;
    for (const name of Object.keys(hostile)) raw.send(JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name } }));
    for (let i = 1; i < id; i++) await raw.answer(i);
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "ping" }));
    await raw.answer(100);
    expect(raw.child.exitCode).toBeNull();
    for (const line of raw.lines()) {
      const m = JSON.parse(line) as Record<string, unknown>;
      expect(m.jsonrpc).toBe("2.0");
      expect("method" in m || "result" in m || "error" in m).toBe(true);
    }
    const byId = (n: number) => raw.messages().find((m) => m.id === n)!;
    expect(byId(3)).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "a\nb c\r\n" }] } });
    expect((byId(5).error as { message: string }).message).toBe("Assay refused the request (HTTP 500).");
    expect(byId(6)).toEqual({ jsonrpc: "2.0", id: 6, result: { ok: true } });
    expect((byId(9).error as { message: string }).message).toBe("Assay's answer was too large.");
    // A server notification reaches the host stripped to its JSON-RPC members (review M8).
    expect(raw.messages().filter((m) => m.method === "notifications/message")).toEqual([{ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "n" } }]);
    expect(byId(7)).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: 2 } });
    expect(raw.messages().some((m) => m.id === "other" || m.id === 12345)).toBe(false);
    // Answers for other ids are never paired with this call.
    expect(byId(4)).toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32000, message: "Assay's answer had no result for this request." } });
    expect((byId(1).error as { code: number }).code).toBe(-32000);
  });

  it("remote down → -32003 then recovers next request", async () => {
    await signedIn();
    const { client } = await connect();
    expect((await client.listTools()).tools).toHaveLength(1);
    mcp.down = true;
    const err = await client.listTools().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(-32003);
    expect((err as McpError).message).toMatch(/Can't reach Assay \([A-Za-z_ ]+\)\./);
    mcp.down = false;
    expect((await client.listTools()).tools).toHaveLength(1);
  });

  it("no answer in time → -32002", async () => {
    await signedIn();
    mcp.respond = (msg) => msg.method === "tools/call"; // never answers
    const { client } = await connect([], { TEST_TIMEOUT_MS: "400" });
    const err = await client.callTool({ name: "echo", arguments: {} }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as McpError).code).toBe(-32002);
    expect((err as McpError).message).toContain("Assay did not answer in time.");
    expect((await client.listTools()).tools).toHaveLength(1);
  });

  it("a second request with an id still in flight is refused", async () => {
    await signedIn();
    let first = true;
    mcp.respond = (msg, res) => {
      if (msg.method !== "tools/call") return false;
      if (first) {
        first = false;
        setTimeout(() => mcp.answer(res, msg.id, { content: [] }), 400);
        return true;
      }
      return false;
    };
    const raw = spawnRaw();
    raw.send(INIT());
    await raw.answer(0);
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo" } }));
    await until(() => mcp.methods().includes("tools/call"));
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo" } }));
    await until(() => raw.messages().filter((m) => m.id === 7).length === 2);
    const answers = raw.messages().filter((m) => m.id === 7);
    expect(answers[0]).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32600, message: "A request with this id is already in flight." } });
    expect(answers[1]).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [] } });
  });

  it("an edited profile has no effect: every request goes to the built-in origins (2.4 M6)", async () => {
    const pair = await signedIn();
    mkdirSync(join(dir, "profiles"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, "profiles", "default.json"),
      JSON.stringify({
        version: 1,
        environment: "e2e",
        credentialId: pair.credentialId,
        agentLabel: "agent",
        delegateAddress: null,
        payer: null,
        network: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        mcp: "http://evil.example",
        api: "http://evil.example/api",
        issuer: "http://evil.example",
        web: "http://evil.example",
        rpc: ["http://evil.example"],
      }),
      { mode: 0o600 },
    );
    const { client } = await connect();
    await client.listTools();
    await client.callTool({ name: "echo", arguments: {} });
    as.grants[0]!.revoked = true;
    await client.listTools(); // 401 → refresh → signed out
    await until(() => mcp.fetched.some((u) => u.includes("/oauth/token")));
    expect(mcp.fetched.length).toBeGreaterThan(3);
    for (const u of mcp.fetched) expect(u).toMatch(/^http:\/\/localhost:3(200|000)\//);
    expect(mcp.fetched.join(" ")).not.toContain("evil");
  });
});

describe("aliases", () => {
  const LONG = `weather_hourly_forecast_${"detail".repeat(6)}`; // 60 characters

  it("tool name of 60 chars with --name assay-weather → alias length ≤ 57 and a call on it reaches the original name exactly", async () => {
    expect(LONG).toHaveLength(60);
    await signedIn();
    mcp.tools = [{ name: LONG, description: "Hourly forecast", inputSchema: { type: "object" } }, { name: "short", inputSchema: { type: "object" } }];
    const { client, stderr } = await connect(["--name", "assay-weather"]);
    const { tools } = await client.listTools();
    const alias = tools[0]!.name;
    expect(alias).toBe(aliasTool("assay-weather", LONG));
    expect(alias.length).toBeLessThanOrEqual(57);
    expect(7 + "assay-weather".length + alias.length).toBeLessThanOrEqual(64);
    expect(tools[0]!.description).toBe(`(Assay tool ${LONG}) Hourly forecast`);
    expect(tools[1]!.name).toBe("short");
    const res = await client.callTool({ name: alias, arguments: { city: "x" } });
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toEqual({ name: LONG, arguments: { city: "x" } });
    const call = mcp.messages().find((m) => m.method === "tools/call")!;
    expect((call.params as { name: string }).name).toBe(LONG);
    await client.listTools();
    await until(() => stderr().includes("alias"));
    expect(stderr().match(/listed under an alias/g)).toHaveLength(1);
  });

  it("alias stable across two processes (and 16 characters budgeted without --name)", async () => {
    await signedIn();
    mcp.tools = [{ name: LONG, inputSchema: { type: "object" } }];
    const a = await connect();
    const b = await connect();
    const [la, lb] = await Promise.all([a.client.listTools(), b.client.listTools()]);
    expect(la.tools[0]!.name).toBe(lb.tools[0]!.name);
    expect(la.tools[0]!.name).toBe(aliasTool("x".repeat(16), LONG));
    expect(la.tools[0]!.name).not.toBe(LONG);
  });
});

describe("serve start", () => {
  async function exitOf(raw: ReturnType<typeof spawnRaw>): Promise<number | null> {
    return new Promise((r) => (raw.child.exitCode !== null ? r(raw.child.exitCode) : raw.child.on("exit", (code) => r(code))));
  }

  it.each([
    [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, "NODE_TLS_REJECT_UNAUTHORIZED=0"],
    [{ HTTPS_PROXY: "http://127.0.0.1:9" }, "HTTPS_PROXY"],
    [{ http_proxy: "http://127.0.0.1:9" }, "http_proxy"],
    [{ NODE_USE_ENV_PROXY: "1" }, "NODE_USE_ENV_PROXY"],
  ])("refuses %o: exit 1, nothing on stdout", async (env, word) => {
    const raw = spawnRaw([], env);
    expect(await exitOf(raw)).toBe(1);
    expect(raw.stdout()).toBe("");
    expect(raw.stderr()).toContain(word);
  });

  it("allows an env proxy only through the 0600 profile setting", async () => {
    mkdirSync(join(dir, "profiles"), { recursive: true, mode: 0o700 });
    const settings = join(dir, "profiles", "default.settings.json");
    writeFileSync(settings, JSON.stringify({ version: 1, allowEnvProxy: true }), { mode: 0o644 });
    const loose = spawnRaw([], { HTTPS_PROXY: "http://127.0.0.1:9" });
    expect(await exitOf(loose)).toBe(1);

    rmSync(settings);
    writeFileSync(settings, JSON.stringify({ version: 1, allowEnvProxy: true }), { mode: 0o600 });
    const raw = spawnRaw([], { HTTPS_PROXY: "http://127.0.0.1:9" });
    raw.send(INIT());
    await raw.answer(0);
  });

  it("warns on NODE_EXTRA_CA_CERTS and starts", async () => {
    const raw = spawnRaw([], { NODE_EXTRA_CA_CERTS: join(dir, "none.pem") });
    raw.send(INIT());
    await raw.answer(0);
    expect(raw.stderr()).toContain("warning: NODE_EXTRA_CA_CERTS");
  });

  it("refuses a foreign origin and a relative --log-file; exits 0 at the end of stdin", async () => {
    const foreign = spawnRaw(["--url", "https://evil.example/"]);
    expect(await exitOf(foreign)).toBe(1);
    expect(foreign.stdout()).toBe("");
    const rel = spawnRaw(["--log-file", "assay.log"]);
    expect(await exitOf(rel)).toBe(2);
    const ok = spawnRaw();
    ok.send(INIT());
    await ok.answer(0);
    ok.child.stdin.end();
    expect(await exitOf(ok)).toBe(0);
  });
});

describe("sign-in across processes (fix round 1, I1)", () => {
  const SIGN_IN = { name: "assay_sign_in", arguments: {} };
  const textOf = (r: Record<string, unknown>) => (r.content as { text: string }[])[0]!.text;

  it("two processes start sign-in at the same moment: one browser flow, one grant", async () => {
    const [a, b] = await Promise.all([connect(), connect()]);
    const [ra, rb] = await Promise.all([a.client.callTool(SIGN_IN), b.client.callTool(SIGN_IN)]);
    const texts = [textOf(ra), textOf(rb)];
    // One process runs the browser flow; the other is told it is in progress, or (when the
    // first finished before its call arrived) is already connected.
    expect(texts.filter((t) => t.startsWith("Approve in your browser: "))).toHaveLength(1);
    const other = texts.find((t) => !t.startsWith("Approve in your browser: "))!;
    expect([
      "Assay sign-in is already in progress in another window. Approve it there; Assay tools appear here when you're done (if they don't, restart test-host).",
      "Assay is connected. Its tools are listed here.",
    ]).toContain(other);
    await until(() => a.changed.length > 0 && b.changed.length > 0, 10_000);
    expect(mcp.opened).toHaveLength(1);
    expect(as.tokenCalls("authorization_code")).toHaveLength(1);
    expect(as.grants).toHaveLength(1);
    expect((await a.client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    expect((await b.client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("the profile lock stays free while a sign-in waits for the browser; others answer at once", async () => {
    mcp.autoApprove = false;
    const a = await connect();
    expect(textOf(await a.client.callTool(SIGN_IN))).toMatch(/^Approve in your browser: /);
    await until(() => mcp.opened.length === 1);
    // What status, remove, limits and refresh do: take the profile lock. No waiting.
    const t0 = Date.now();
    await withLock({ dir, name: "default" }, () => {});
    expect(Date.now() - t0).toBeLessThan(1_000);
    const b = await connect();
    const t1 = Date.now();
    expect(textOf(await b.client.callTool(SIGN_IN))).toMatch(/^Assay sign-in is already in progress in another window\./);
    expect(Date.now() - t1).toBeLessThan(3_000);
    // The pending flow still completes, and both processes pick the grant up.
    await fetch(as.approve(mcp.opened[0]!)).then((r) => r.text());
    await until(() => a.changed.length > 0 && b.changed.length > 0, 10_000);
    expect(as.grants).toHaveLength(1);
    expect(mcp.opened).toHaveLength(1);
  });

  it("a process whose passive sign-in is pending picks up a sibling's grant (re-review R1-M1)", async () => {
    const a = await connect();
    await until(() => /sign in to Assay: /.test(a.stderr())); // A holds a passive marker
    const b = await connect();
    expect(textOf(await b.client.callTool(SIGN_IN))).toMatch(/^Approve in your browser: /); // B takes it over
    await until(() => b.changed.length > 0, 10_000);
    // A's own flow is still waiting for a browser nobody opened; its keychain poll finds B's grant.
    await until(() => a.changed.length > 0, 3_000);
    expect((await a.client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    expect(mcp.opened).toHaveLength(1);
    expect(as.grants).toHaveLength(1);
  });

  it("a stale marker from a dead pid is ignored", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    mkdirSync(join(dir, "profiles"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "profiles", "default.signin.json"), JSON.stringify({ version: 1, pid: dead, startedAt: Date.now(), token: "old", passive: false }), { mode: 0o600 });
    const a = await connect();
    expect(textOf(await a.client.callTool(SIGN_IN))).toMatch(/^Approve in your browser: /);
    await until(() => a.changed.length > 0, 10_000);
    expect(mcp.opened).toHaveLength(1);
    expect(existsSync(join(dir, "profiles", "default.signin.json"))).toBe(false);
  });
});

describe("bounds and secrets (fix round 1, I2 and I3)", () => {
  it("12 parallel hostile 16 MiB answers: the proxy stays alive and its memory bounded", async () => {
    await signedIn();
    const head = (id: unknown) => `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"x":[`;
    const inner = `${"{},".repeat(Math.floor((16 * 1024 * 1024 - 100) / 3) - 1)}{}`;
    mcp.respond = (msg, res) => {
      if ((msg.params as { name?: string } | undefined)?.name !== "big") return false;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`${head(msg.id)}${inner}]}}`);
      return true;
    };
    const raw = spawnRaw([], { TEST_HEAP: "1" });
    raw.send(INIT());
    await raw.answer(0);
    const base = raw.lineCount();
    for (let i = 1; i <= 12; i++) raw.send(JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "big" } }));
    await until(() => raw.lineCount() >= base + 12, 90_000);
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "ping" }));
    await until(() => raw.lineCount() >= base + 13, 10_000);
    expect(raw.child.exitCode).toBeNull();
    const answered = raw
      .stdout()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { id?: number; result?: unknown; error?: { message: string } });
    for (let i = 1; i <= 12; i++) expect(answered.some((m) => m.id === i && ("result" in m || "error" in m))).toBe(true);
    expect(mcp.peakHeap).toBeGreaterThan(0);
    expect(mcp.peakHeap).toBeLessThan(1_536 * 1024 * 1024);
  }, 120_000);

  it("401 → refresh → retry succeeds, and the retry carries the new access token", async () => {
    const pair = await signedIn();
    const { client } = await connect();
    mcp.refuseOnce.add(pair.accessToken);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    expect(as.tokenCalls("refresh_token")).toHaveLength(1);
    const last = mcp.requests.at(-1)!.headers.authorization!;
    expect(last).toMatch(/^Bearer assay_at_/);
    expect(last).not.toBe(`Bearer ${pair.accessToken}`);
    for (const r of mcp.requests) expect(JSON.stringify(r.headers) + r.raw).not.toContain(pair.refreshToken);
  });

  it("no secret leaves except the access token: sign-in, forwarding, 401 → refresh, tools/call", async () => {
    const KEY = `0x${"5a".repeat(32)}`;
    const store = new Keychain(new FileKeyring(keyringFile), { profile: "default", environment: "e2e" });
    await withLock({ dir, name: "default" }, (lock) => store.set(lock, "delegate_key", KEY));
    const { client, changed } = await connect();
    await client.callTool({ name: "assay_sign_in", arguments: {} });
    await until(() => changed.length > 0, 10_000);
    await client.listTools();
    await client.callTool({ name: "echo", arguments: { a: 1 } });
    const access = (JSON.parse((await store.getAccessToken()) ? JSON.stringify(await store.getAccessToken()) : "null") as { token: string }).token;
    mcp.refuseOnce.add(access);
    await client.callTool({ name: "echo", arguments: { a: 2 } });
    expect(as.tokenCalls("refresh_token")).toHaveLength(1);

    const keyHex = "5a".repeat(32);
    for (const r of mcp.requests) {
      const all = JSON.stringify(r.headers) + r.raw;
      expect(all).not.toMatch(/assay_(rt|ac|sk_live)_/);
      expect(all).not.toContain(keyHex);
      expect(r.headers.authorization).toMatch(/^Bearer assay_at_[A-Za-z0-9_-]+$/);
    }
    for (const r of as.requests) {
      if (r.authorization !== undefined) expect(r.authorization).toMatch(/^Bearer assay_at_[A-Za-z0-9_-]+$/);
      expect(r.form?.toString() ?? "").not.toContain(keyHex);
      if (r.path !== "/oauth/token" && r.path !== "/oauth/revoke") expect(r.form?.toString() ?? "").not.toMatch(/assay_rt_/);
    }
    for (const u of mcp.fetched) expect(u).not.toMatch(/assay_(at|rt|ac)_|5a5a5a/);
  });

  it("a later duplicate-id response is ignored (JSON and SSE), and SSE reading stops at the answer", async () => {
    await signedIn();
    let closedEarly = false;
    mcp.respond = (msg, res) => {
      const name = (msg.params as { name?: string } | undefined)?.name;
      const answer = (v: string) => JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { v } });
      if (name === "dupJson") {
        res.writeHead(200, { "content-type": "application/json" }).end(`[${answer("A")},${answer("B")}]`);
        return true;
      }
      if (name === "dupSse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${answer("A")}\n\n`);
        res.on("close", () => {
          if (!res.writableEnded) closedEarly = true;
        });
        setTimeout(() => {
          if (!res.destroyed) res.end(`data: ${answer("B")}\n\n`);
        }, 500);
        return true;
      }
      return false;
    };
    const raw = spawnRaw();
    raw.send(INIT());
    await raw.answer(0);
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dupJson" } }));
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dupSse" } }));
    await raw.answer(1);
    await raw.answer(2);
    await sleep(800);
    expect(raw.messages().filter((m) => m.id === 1)).toEqual([{ jsonrpc: "2.0", id: 1, result: { v: "A" } }]);
    expect(raw.messages().filter((m) => m.id === 2)).toEqual([{ jsonrpc: "2.0", id: 2, result: { v: "A" } }]);
    expect(closedEarly).toBe(true);
  });
});
