import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { FakeAs } from "./fake-as.js";

/**
 * A local fake of the Assay MCP endpoint (backend `McpController` + `McpHttpBridge`), for
 * tests only. Bearer tokens are checked against the fake AS (`FakeAs.use`); a bad one gets
 * 401 with the `WWW-Authenticate` challenge. Requests are answered as JSON (or SSE when
 * `sse` is set); notifications and posted responses get 202. Tests hook `respond` to send
 * hostile or unusual answers.
 *
 * It also serves two test-only routes for the forked proxy: `/__test/browser` (the proxy's
 * "browser": records the link and, with `autoApprove`, follows the consent redirect to the
 * loopback) and `/__test/fetch` (every outbound URL the proxy fetched).
 */

export interface SeenMcpRequest {
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly raw: string;
  readonly json: unknown;
}

export type Responder = (msg: Record<string, unknown>, res: ServerResponse) => boolean;

export class FakeMcp {
  port = 0;
  tools: Record<string, unknown>[] = [{ name: "echo", description: "Echo the arguments", inputSchema: { type: "object" } }];
  readonly requests: SeenMcpRequest[] = [];
  readonly opened: string[] = [];
  readonly fetched: string[] = [];
  autoApprove = true;
  sse = false;
  /** Destroys every MCP connection (the remote is down). */
  down = false;
  respond: Responder | null = null;
  private server: Server | null = null;

  constructor(private readonly as: FakeAs) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((r) => this.server!.close(r));
  }

  /** The MCP messages received (initialize and notifications included), in order. */
  messages(): Record<string, unknown>[] {
    return this.requests.map((r) => r.json).filter((j): j is Record<string, unknown> => typeof j === "object" && j !== null);
  }

  methods(): string[] {
    return this.messages().map((m) => String(m.method ?? (m.error ? "<error>" : "<response>")));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = new URL(req.url ?? "/", "http://x").pathname;

    if (path === "/__test/browser") {
      this.opened.push(raw);
      res.writeHead(200).end();
      if (this.autoApprove) {
        const target = this.as.approve(raw);
        void fetch(target).then((r) => r.text()).catch(() => {});
      }
      return;
    }
    if (path === "/__test/fetch") {
      this.fetched.push(raw);
      res.writeHead(200).end();
      return;
    }

    if (this.down) {
      req.socket.destroy();
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    this.requests.push({ path, headers: req.headers, raw, json });
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!this.as.use(bearer)) {
      res
        .writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": `Bearer resource_metadata="http://localhost:3200/.well-known/oauth-protected-resource", scope="assay:agent", error="invalid_token"`,
        })
        .end(JSON.stringify({ statusCode: 401, message: "MCP_CREDENTIAL_INVALID" }));
      return;
    }
    const msg = (json ?? {}) as Record<string, unknown>;
    if (typeof msg.method !== "string" || msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (this.respond?.(msg, res)) return;
    this.answer(res, msg.id, this.result(msg));
  }

  answer(res: ServerResponse, id: unknown, result: unknown): void {
    const body = { jsonrpc: "2.0", id, result };
    if (this.sse) {
      res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    }
  }

  private result(msg: Record<string, unknown>): Record<string, unknown> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case "initialize":
        return { protocolVersion: params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake-assay", version: "1" } };
      case "tools/list":
        return { tools: this.tools };
      case "tools/call":
        return { content: [{ type: "text", text: JSON.stringify({ name: params.name, arguments: params.arguments ?? null }) }] };
      case "resources/list":
        return { resources: [{ uri: "assay://fake/r", name: "r" }] };
      case "prompts/list":
        return { prompts: [{ name: "p" }] };
      case "completion/complete":
        return { completion: { values: ["a"], hasMore: false } };
      default:
        return { echoed: msg.method };
    }
  }
}
