import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveDeployment, type ResolvedDeployment } from "@assay-core/profile/deployments.js";
import { normaliseOrigin, DEV_ORIGINS_ENV } from "@assay-core/profile/dev-origins.js";
import { pinnedFetch } from "@assay-core/net/fetch.js";
import { ERROR_META, REFUSED_META } from "@assay-core/proxy/meta.js";
import { usdToAtomic } from "@assay-core/guards/guards.js";
import pkg from "../package.json" with { type: "json" };
import type { AssayClientOptions, AssayTool, CallResult, Refusal } from "./types.js";

const RECEIPT_META = "x402/receipt";
/** Dollar caps are parsed with the guards' own parser; the built-in asset has 6 decimals. */
const CAP_DECIMALS = 6;

export class AssayConfigError extends Error {
  override readonly name = "AssayConfigError";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkCap(name: string, value: unknown): void {
  if (typeof value !== "string" || usdToAtomic(value, CAP_DECIMALS) === null || usdToAtomic(value, CAP_DECIMALS) === 0n) {
    throw new AssayConfigError(`${name} must be a positive dollar amount such as "0.50"`);
  }
}

/**
 * Assay over Streamable HTTP with an API key (spec §10).
 *
 * Every request goes through the proxy's `pinnedFetch`: only the built-in origin (or one the
 * caller listed in `dev.origins`) is reachable, redirects are an error, and the key is sent to
 * pinned origins only. The signer and guards are the proxy's own modules, reached through the
 * `@assay-core/*` alias and bundled by esbuild, never copied.
 */
export class AssayClient {
  private readonly deployment: ResolvedDeployment;
  private readonly apiKey: string;
  private client: Client | null = null;

  constructor(options: AssayClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
      throw new AssayConfigError("apiKey is required: the SDK authenticates with an API key only");
    }
    if (/\s/.test(options.apiKey.trim())) throw new AssayConfigError("apiKey is not valid");
    if (options.signer !== undefined) {
      checkCap("maxPerCall", options.maxPerCall);
      checkCap("maxPerDay", options.maxPerDay);
    }
    const origins: string[] = [];
    for (const raw of options.dev?.origins ?? []) {
      const o = normaliseOrigin(raw);
      if (o === null) throw new AssayConfigError("dev.origins entries must be bare http(s) origins");
      origins.push(o);
    }
    try {
      // Dev origins come from `dev.origins` in code only: both inputs of the proxy's dev-mode
      // decision are fed from it, and the process environment is not read.
      this.deployment = resolveDeployment({
        url: options.url,
        env: origins.length > 0 ? { [DEV_ORIGINS_ENV]: origins.join(",") } : {},
        devOrigins: origins,
      });
    } catch (err) {
      throw new AssayConfigError(err instanceof Error ? err.message : "invalid url");
    }
    this.apiKey = options.apiKey.trim();
  }

  /** Opens the MCP session. */
  async connect(): Promise<void> {
    if (this.client) return;
    const deployment = this.deployment;
    const bearer = this.apiKey;
    const pinned = (input: string | URL, init?: RequestInit): Promise<Response> => {
      // The transport must not pick the redirect mode or set credentials of its own.
      const { redirect: _redirect, ...rest } = init ?? {};
      void _redirect;
      return pinnedFetch(deployment, input, { ...rest, bearer });
    };
    const client = new Client({ name: "assay-sdk", version: pkg.version });
    const transport = new StreamableHTTPClientTransport(new URL(deployment.url), { fetch: pinned as typeof fetch });
    await client.connect(transport as Transport);
    this.client = client;
  }

  /** The tools visible at the URL. */
  async listTools(): Promise<AssayTool[]> {
    const client = this.requireClient();
    const tools: AssayTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * Calls a tool. Free calls only in this version: a result that asks for payment comes back
   * as `ok: false` with a `refused` entry, and nothing is signed.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const client = this.requireClient();
    const result = await client.callTool({ name, arguments: args });
    const meta = isObject(result._meta) ? result._meta : {};
    const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
    const out: CallResult = { ok: result.isError !== true, content };
    if (isObject(result.structuredContent)) out.structuredContent = result.structuredContent;
    if (meta[RECEIPT_META] !== undefined && meta[RECEIPT_META] !== null) out.receipt = meta[RECEIPT_META];
    if (isObject(meta[REFUSED_META])) {
      const r = meta[REFUSED_META];
      const refused: Refusal = { guard: String(r.guard ?? ""), reason: String(r.reason ?? "") };
      out.refused = refused;
    }
    if (!out.ok) {
      const e = isObject(meta[ERROR_META]) ? meta[ERROR_META] : {};
      const text = content.find((c): c is { text: string } => isObject(c) && c.type === "text" && typeof c.text === "string")?.text;
      const message = typeof e.message === "string" ? e.message : (text ?? "The call failed.");
      out.error = typeof e.code === "string" ? { code: e.code, message } : { message };
    }
    return out;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.close();
  }

  private requireClient(): Client {
    if (!this.client) throw new AssayConfigError("call connect() first");
    return this.client;
  }
}
