import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { AssayClient, AssayConfigError, Signers } from "../src/index.js";

/** A local in-process MCP server over Streamable HTTP (JSON answers). No network beyond loopback. */
class LocalMcp {
  port = 0;
  readonly seen: { path: string; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  respondTool: (name: string) => Record<string, unknown> = (name) => ({ content: [{ type: "text", text: `ok ${name}` }] });
  private server: Server | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }
  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((r) => this.server?.close(r));
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.method !== "POST") return void res.writeHead(405).end();
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    this.seen.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
    if (body.id === undefined) return void res.writeHead(202).end();
    const params = (body.params ?? {}) as Record<string, unknown>;
    let result: Record<string, unknown> = {};
    if (body.method === "initialize") {
      result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local", version: "1" } };
    } else if (body.method === "tools/list") {
      result = { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { a: { type: "string" } } } }, { name: "bare", inputSchema: { type: "object" } }] };
    } else if (body.method === "tools/call") {
      result = this.respondTool(String(params.name));
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }
}

/** The built-in dev origin the proxy's deployments table has for the local stack. */
const DEV_ORIGIN = "http://localhost:3200";
const realFetch = globalThis.fetch;
const KEY = "assay_sk_live_testkey";
let mcp: LocalMcp;
let client: AssayClient | null = null;

beforeEach(async () => {
  mcp = new LocalMcp();
  await mcp.start();
  // Reroute the dev origin to the in-process server at the transport, after pinnedFetch's checks.
  vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.origin !== DEV_ORIGIN) throw new Error(`unexpected request to ${u.origin}`);
    return realFetch(`http://127.0.0.1:${mcp.port}${u.pathname}${u.search}`, init);
  }) as typeof fetch);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await client?.close();
  client = null;
  await mcp.stop();
});

describe("construction", () => {
  it("non-builtin origin refused without dev.origins", () => {
    expect(() => new AssayClient({ url: `${DEV_ORIGIN}/`, apiKey: KEY })).toThrow(AssayConfigError);
    expect(() => new AssayClient({ url: "https://evil.example/", apiKey: KEY })).toThrow(/refusing/);
    expect(mcp.seen).toEqual([]);
  });

  it("a dev origin must be listed in code; the environment alone does not allow it", () => {
    process.env.ASSAY_MCP_DEV_ORIGINS = DEV_ORIGIN;
    try {
      expect(() => new AssayClient({ url: `${DEV_ORIGIN}/`, apiKey: KEY })).toThrow(AssayConfigError);
    } finally {
      delete process.env.ASSAY_MCP_DEV_ORIGINS;
    }
  });

  it("4.1 M5: the refusal for a dev origin names dev.origins, not the CLI", () => {
    let message = "";
    try {
      new AssayClient({ url: `${DEV_ORIGIN}/`, apiKey: KEY });
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toContain("dev.origins");
    expect(message).not.toContain(["assay", "mcp"].join("-") + " dev allow");
    expect(message).not.toContain("ASSAY_MCP_DEV_ORIGINS");
  });

  it("apiKey missing → throws", () => {
    // @ts-expect-error apiKey is required
    expect(() => new AssayClient({ url: "https://mcp.assay.ai/" })).toThrow(/apiKey is required/);
    expect(() => new AssayClient({ url: "https://mcp.assay.ai/", apiKey: "  " })).toThrow(/apiKey is required/);
    // A control byte never reaches a request (whose error would echo the key), and the refusal never shows it.
    for (const bad of ["assay_sk_live_SECRET\u0000x", "assay_sk_live_SECRET\u001fx", "assay_sk_live_SECRETé"]) {
      let message = "";
      try {
        new AssayClient({ url: "https://mcp.assay.ai/", apiKey: bad });
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message).toBe("apiKey is not valid");
    }
  });

  it("the production origin needs no dev.origins", () => {
    expect(() => new AssayClient({ url: "https://mcp.assay.ai/?tools=get_weather", apiKey: KEY })).not.toThrow();
  });
});

describe("free calls", () => {
  const make = () => new AssayClient({ url: `${DEV_ORIGIN}/`, apiKey: KEY, dev: { origins: [DEV_ORIGIN] } });

  it("listTools maps {name, description, inputSchema}", async () => {
    client = make();
    await client.connect();
    expect(await client.listTools()).toEqual([
      { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
      { name: "bare", description: "", inputSchema: { type: "object" } },
    ]);
  });

  it("free call returns ok:true", async () => {
    client = make();
    await client.connect();
    mcp.respondTool = () => ({ content: [{ type: "text", text: "hi" }], structuredContent: { n: 1 }, _meta: { "assay/receipt": "r-1" } });
    expect(await client.callTool("echo", { a: "b" })).toEqual({ ok: true, content: [{ type: "text", text: "hi" }], structuredContent: { n: 1 }, receipt: "r-1" });
  });

  it("a failed call is ok:false with the server error; a refusal is surfaced", async () => {
    client = make();
    await client.connect();
    mcp.respondTool = () => ({ isError: true, content: [{ type: "text", text: "nope" }], _meta: { "assay/error": { code: "BOOM", message: "bad" }, "assay-mcp/refused": { guard: "G7", reason: "cap" } } });
    const r = await client.callTool("echo");
    expect(r.ok).toBe(false);
    expect(r.error).toEqual({ code: "BOOM", message: "bad" });
    expect(r.refused).toEqual({ guard: "G7", reason: "cap" });
  });

  it("sends the key as the bearer to the pinned origin, and no other credential", async () => {
    client = make();
    await client.connect();
    await client.listTools();
    expect(mcp.seen.length).toBeGreaterThan(1);
    for (const s of mcp.seen) expect(s.authorization).toBe(`Bearer ${KEY}`);
  });

  it("4.1 M9: concurrent connect() calls open one session", async () => {
    client = new AssayClient({ url: `${DEV_ORIGIN}/`, apiKey: KEY, dev: { origins: [DEV_ORIGIN] } });
    await Promise.all([client.connect(), client.connect(), client.connect()]);
    expect(mcp.seen.filter((r) => r.body.method === "initialize")).toHaveLength(1);
  });

  it("calls before connect throw", async () => {
    client = make();
    await expect(client.listTools()).rejects.toThrow(/connect/);
  });

  it("a signer needs maxPerCall and maxPerDay", () => {
    const signer = Signers.fromPrivateKey(generatePrivateKey());
    expect(() => new AssayClient({ url: "https://mcp.assay.ai/", apiKey: KEY, signer })).toThrow(/maxPerCall/);
    expect(() => new AssayClient({ url: "https://mcp.assay.ai/", apiKey: KEY, signer, maxPerCall: "0.50" })).toThrow(/maxPerDay/);
    expect(() => new AssayClient({ url: "https://mcp.assay.ai/", apiKey: KEY, signer, maxPerCall: "0.50", maxPerDay: "5" })).not.toThrow();
  });
});
