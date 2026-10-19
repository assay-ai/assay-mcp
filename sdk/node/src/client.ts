import { inspect } from "node:util";
import { getAddress } from "viem";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createChainReader } from "@assay-core/chain/reads.js";
import { isPlaceholder, parseCaip10 } from "@assay-core/deployments.js";
import { QuoteCache } from "@assay-core/guards/quote-cache.js";
import { usdToAtomic } from "@assay-core/guards/guards.js";
import { pinnedFetch } from "@assay-core/net/fetch.js";
import { assertSignerEnvironment, resolveDeployment, type ResolvedDeployment } from "@assay-core/profile/deployments.js";
import { normaliseOrigin, DEV_ORIGINS_ENV } from "@assay-core/profile/dev-origins.js";
import { apiRequest, BindError, bindDelegateKey, type ApiCall } from "@assay-core/proxy/delegate-bind.js";
import {
  appendText,
  debtSuffix,
  enablePaidLink,
  ERROR_META,
  GET_TOOL,
  paidToolOf,
  paymentState,
  prepareCallParams,
  quoteFromGetTool,
  quotesFromList,
  quotesFromSearch,
  REFUSED_META,
  refusedText,
  SEARCH_TOOLS,
} from "@assay-core/proxy/meta.js";
import { dateHeaderOffset } from "@assay-core/signer/clock.js";
import pkg from "../package.json" with { type: "json" };
import { PaidCalls } from "./paid.js";
import { isSigner, resolveSigner, type Signer } from "./signers.js";
import type { AssayClientOptions, AssayTool, CallResult, DelegateBinding, Refusal } from "./types.js";

const RECEIPT_META = "assay/receipt";
/** Dollar caps are parsed with the guards' own parser; the built-in asset has 6 decimals. */
const CAP_DECIMALS = 6;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class AssayConfigError extends Error {
  override readonly name = "AssayConfigError";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkCap(name: string, value: unknown): string {
  if (typeof value !== "string" || usdToAtomic(value, CAP_DECIMALS) === null || usdToAtomic(value, CAP_DECIMALS) === 0n) {
    throw new AssayConfigError(`${name} must be a positive dollar amount such as "0.50"`);
  }
  return value;
}

/**
 * Assay over Streamable HTTP with an API key (spec §10).
 *
 * Every request goes through the proxy's `pinnedFetch`: only the built-in origin (or one the
 * caller listed in `dev.origins`) is reachable, redirects are an error, and the key is sent to
 * pinned origins only. The signer and guards are the proxy's own modules, reached through the
 * `@assay-core/*` alias and bundled by esbuild, never copied.
 *
 * The API key is held in an ES private field, so `util.inspect`, `console.log`,
 * `JSON.stringify` and `String()` never show it.
 */
export class AssayClient {
  readonly #deployment: ResolvedDeployment;
  readonly #apiKey: string;
  readonly #signer: Signer | null;
  readonly #paid: PaidCalls | null;
  readonly #quotes = new QuoteCache();
  #client: Client | null = null;
  #dateOffset = 0;
  #credentialId: string | null = null;
  #boundAddress: string | null = null;

  constructor(options: AssayClientOptions) {
    if (typeof options?.apiKey !== "string" || options.apiKey.trim() === "") {
      throw new AssayConfigError("apiKey is required: the SDK authenticates with an API key only");
    }
    if (/\s/.test(options.apiKey.trim())) throw new AssayConfigError("apiKey is not valid");
    if (options.signer !== undefined && !isSigner(options.signer)) {
      throw new AssayConfigError("signer must come from Signers.fromAccount, Signers.fromKeychain or Signers.fromPrivateKey");
    }
    let maxPerCall = "";
    let maxPerDay = "";
    if (options.signer !== undefined) {
      maxPerCall = checkCap("maxPerCall", options.maxPerCall);
      maxPerDay = checkCap("maxPerDay", options.maxPerDay);
      if (usdToAtomic(maxPerCall, CAP_DECIMALS)! > usdToAtomic(maxPerDay, CAP_DECIMALS)!) {
        throw new AssayConfigError("maxPerCall must not be above maxPerDay");
      }
    }
    const origins: string[] = [];
    for (const raw of options.dev?.origins ?? []) {
      const o = normaliseOrigin(raw);
      if (o === null) throw new AssayConfigError("dev.origins entries must be bare http(s) origins");
      origins.push(o);
    }
    // Dev origins come from `dev.origins` in code only: both inputs of the proxy's dev-mode
    // decision are fed from it, and the process environment is not read.
    const resolve = (url: string, warn?: (line: string) => void): ResolvedDeployment => {
      try {
        return resolveDeployment({
          url,
          env: origins.length > 0 ? { [DEV_ORIGINS_ENV]: origins.join(",") } : {},
          devOrigins: origins,
          ...(warn ? { warn } : {}),
        });
      } catch (err) {
        throw new AssayConfigError(err instanceof Error ? err.message : "invalid url");
      }
    };
    this.#deployment = resolve(options.url);
    this.#apiKey = options.apiKey.trim();
    this.#signer = options.signer ?? null;

    if (this.#signer !== null) {
      // G11 is replaced by `urls`: canonicalised like the server, on this client's deployment.
      // Without `urls`, the one URL this client was built for (in code) is the allow list.
      const urls = (options.urls ?? [options.url]).map((u) => {
        const d = resolve(u, () => {});
        if (d.environment !== this.#deployment.environment) throw new AssayConfigError("urls must be on the same Assay deployment as url");
        return d.url;
      });
      const signer = this.#signer;
      const deployment = this.#deployment;
      this.#paid = new PaidCalls({
        deployment,
        account: async () => {
          assertSignerEnvironment(deployment);
          return resolveSigner(signer, deployment.environment);
        },
        maxPerCall,
        maxPerDay,
        urls,
        chain: createChainReader({ environment: deployment.environment, profile: "sdk" }),
        quotes: this.#quotes,
        send: (params) => this.#send(params),
        dateOffset: () => this.#dateOffset,
        now: Date.now,
      });
    } else {
      this.#paid = null;
    }
  }

  /** Opens the MCP session. */
  async connect(): Promise<void> {
    if (this.#client) return;
    const deployment = this.#deployment;
    const bearer = this.#apiKey;
    const pinned = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      // The transport must not pick the redirect mode or set credentials of its own.
      const { redirect: _redirect, ...rest } = init ?? {};
      void _redirect;
      const res = await pinnedFetch(deployment, input, { ...rest, bearer });
      this.#dateOffset = dateHeaderOffset(res.headers.get("date"), Date.now() / 1000);
      return res;
    };
    const client = new Client({ name: "assay-sdk", version: pkg.version });
    const transport = new StreamableHTTPClientTransport(new URL(deployment.url), { fetch: pinned as typeof fetch });
    await client.connect(transport as Transport);
    this.#client = client;
  }

  /** The tools visible at the URL. */
  async listTools(): Promise<AssayTool[]> {
    const client = this.#requireClient();
    const tools: AssayTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      this.#quotes.setAll(quotesFromList(page));
      for (const t of page.tools) {
        tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * Calls a tool. Without a signer, a paid tool comes back as `ok: false` and nothing is signed.
   * With one, a payment request runs every local guard (G1–G12) and is signed only when all pass;
   * at most one voucher per call.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    this.#requireClient();
    const params = prepareCallParams({ name, arguments: args });
    const startedAt = Date.now();
    const result = await this.#send(params);
    if (name === GET_TOOL) {
      const pair = quoteFromGetTool(result);
      if (pair) this.#quotes.set(pair[0], pair[1]);
    } else if (name === SEARCH_TOOLS) {
      this.#quotes.setAll(quotesFromSearch(result));
    }
    const state = paymentState(result);
    if (state.kind === "debt") {
      const web = this.#deployment.web;
      return mapResult(isPlaceholder(web) ? result : appendText(result, debtSuffix(web)));
    }
    if (state.kind !== "payment-required" || this.#paid === null) return mapResult(result);
    const tool = paidToolOf(name, params);
    if (tool === null) {
      return refusedResult({ guard: "G1", reason: "the payment request is not the answer to a forwarded tool call" });
    }
    const outcome = await this.#paid.pay(tool, params, startedAt, result, state.requirement);
    if (outcome.kind === "refused") return refusedResult(outcome.refused);
    return mapResult(outcome.result);
  }

  /**
   * Binds the signer's key to this API key (F4 step 3): the server's challenge is checked field
   * by field before anything is signed. Idempotent: when the key is already bound, nothing is
   * signed. Approve the key afterwards at {@link enablePaidCallsUrl}.
   */
  async bindDelegate(): Promise<DelegateBinding> {
    const signer = this.#signer;
    if (signer === null) throw new AssayConfigError("bindDelegate needs a signer");
    const deployment = this.#deployment;
    assertSignerEnvironment(deployment);
    const account = await resolveSigner(signer, deployment.environment);
    const address = getAddress(account.address);
    const network = Object.keys(deployment.networks)[0];
    if (network === undefined) throw new AssayConfigError("this Assay deployment has no payment network");
    const chainId = Number(network.slice("eip155:".length));

    const current = await this.#api("GET", "/agents/me/delegate");
    const data = current !== null && isObject(current.body) ? current.body.data : undefined;
    if (!isObject(data) || typeof data.credentialId !== "string" || !UUID_RE.test(data.credentialId)) {
      throw new AssayConfigError("Assay did not confirm the API key's credential. Try again.");
    }
    const credentialId = data.credentialId.toLowerCase();
    const bound = typeof data.delegate === "string" ? parseCaip10(data.delegate) : null;
    if (bound !== null && bound.chainId === chainId && getAddress(bound.address) === address) {
      this.#credentialId = credentialId;
      this.#boundAddress = address;
      return { credentialId, delegate: address, alreadyBound: true };
    }
    try {
      await bindDelegateKey({ account, api: (m, p, b) => this.#api(m, p, b), environment: deployment.environment, network, credentialId, now: Date.now });
    } catch (err) {
      if (err instanceof BindError) throw new AssayConfigError(err.message);
      throw err;
    }
    this.#credentialId = credentialId;
    this.#boundAddress = address;
    return { credentialId, delegate: address, alreadyBound: false };
  }

  /**
   * `{WEB}/agents/enable-paid?credential={id}#key={address}`: the page where the payer approves
   * this key and its caps. The key's address is only in the fragment, which browsers never send
   * to a server. Call {@link bindDelegate} first.
   */
  enablePaidCallsUrl(): string {
    if (this.#credentialId === null || this.#boundAddress === null) throw new AssayConfigError("call bindDelegate() first");
    const link = enablePaidLink(this.#deployment.web, this.#credentialId, this.#boundAddress);
    if (link === null) throw new AssayConfigError("this Assay deployment has no enable-paid page");
    return link;
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    if (client) await client.close();
  }

  toJSON(): Record<string, unknown> {
    return { url: this.#deployment.url, signer: this.#signer?.toJSON() ?? null };
  }

  toString(): string {
    return `AssayClient(${this.#deployment.url})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }

  #api: ApiCall = (method, path, body) => {
    const deployment = this.#deployment;
    return apiRequest((url, init) => pinnedFetch(deployment, url, init), deployment.api, this.#apiKey, method, path, body);
  };

  async #send(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.#requireClient().callTool(params as Parameters<Client["callTool"]>[0]);
    return result as Record<string, unknown>;
  }

  #requireClient(): Client {
    if (!this.#client) throw new AssayConfigError("call connect() first");
    return this.#client;
  }
}

function refusedResult(refused: Refusal): CallResult {
  const text = refusedText(refused.reason);
  return { ok: false, content: [{ type: "text", text }], error: { message: text }, refused };
}

function mapResult(result: Record<string, unknown>): CallResult {
  const meta = isObject(result._meta) ? result._meta : {};
  const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const out: CallResult = { ok: result.isError !== true, content };
  if (isObject(result.structuredContent)) out.structuredContent = result.structuredContent;
  if (meta[RECEIPT_META] !== undefined && meta[RECEIPT_META] !== null) out.receipt = meta[RECEIPT_META];
  if (isObject(meta[REFUSED_META])) {
    const r = meta[REFUSED_META];
    out.refused = { guard: String(r.guard ?? ""), reason: String(r.reason ?? "") };
  }
  if (!out.ok) {
    const e = isObject(meta[ERROR_META]) ? meta[ERROR_META] : {};
    const text = content.find((c): c is { text: string } => isObject(c) && c.type === "text" && typeof c.text === "string")?.text;
    const message = typeof e.message === "string" ? e.message : (text ?? "The call failed.");
    out.error = typeof e.code === "string" ? { code: e.code, message } : { message };
  }
  return out;
}
