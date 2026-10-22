import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  stringToBytes,
  type Hex,
} from "viem";

/**
 * A local fake of the Assay MCP server and API for the paid path (Task 2.9), for tests only.
 * One HTTP server on 127.0.0.1 answers:
 * - the MCP endpoint (`POST /`): `tools/list` with `assay/price`, `get_tool`, `search_tools`,
 *   `call_tool`, a free `echo`, a paid `weather` that answers `PAYMENT_REQUIRED` (backend shape:
 *   `_meta["assay/error"]` and `_meta["x402/paymentRequired"]`, checksummed CAIP-10, a fresh `seq`
 *   each time) and settles a voucher in `_meta["assay/voucher"]`, and `owe`, which answers
 *   `PAYMENT_DEBT_OUTSTANDING`;
 * - the API (`/api/v1/agents/me/delegate`, its `challenge`), in the API envelope;
 * - a JSON-RPC chain (`POST /__rpc`): `eth_chainId`, `eth_blockNumber` and the escrow views the
 *   proxy reads, from the grants set here;
 * - `/__test/browser` and `/__test/fetch` for the forked proxy.
 *
 * The voucher check follows the backend (`EvmChainAdapter.verifyVoucherSignature` and
 * `VoucherService`): the EIP-712 `Voucher` of the "Assay Settlement" v2 domain on the network's
 * escrow, recovered to the delegate bound to the credential, with every field equal to the
 * requirement this server issued for that `seq`, a life of at most `min(240, maxTimeoutSeconds)`,
 * not expired, and each `seq` redeemed once. `verifyVoucher` is exported so the signer vectors
 * can check this verifier itself.
 */

export const API_KEY = "assay_sk_live_TESTONLYpaidpathkey0001";
export const CREDENTIAL_ID = "5b8f3c1e-2a4d-4e6f-9a1b-3c5d7e9f0a2b";
/** Public anvil default accounts (test only). */
export const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const PROVIDER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const PROVIDER_ID = "00000000-0000-4000-8000-000000000001";

const VOUCHER_TYPES = {
  Voucher: [
    { name: "payer", type: "address" },
    { name: "provider", type: "address" },
    { name: "amount", type: "uint64" },
    { name: "resourceHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "seq", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

const BINDING_TYPES = {
  DelegateBinding: [
    { name: "delegate", type: "address" },
    { name: "credentialId", type: "string" },
    { name: "nonce", type: "string" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

const ESCROW_ABI = parseAbi([
  "struct Delegation { uint64 maxVoucherAmount; uint64 maxPerWindow; uint64 spentInWindow; uint64 windowStartedAt; uint64 validUntil; uint32 listPosition; bool revoked; }",
  "struct Escrow { uint128 balance; uint64 seqHigh; uint64 authNonce; uint64 maxVoucherAmount; uint64 maxPerWindow; uint64 spentInWindow; uint64 windowStartedAt; uint64 withdrawRequested; uint64 withdrawAvailableAt; uint128 totalRedeemed; uint128 totalWithdrawn; uint128 totalFunded; }",
  "function escrowOf(address buyer) view returns (Escrow)",
  "function delegationOf(address payer, address delegate) view returns (Delegation)",
  "function effectiveCapsOf(address payer, address delegate) view returns (uint64 maxVoucherAmount, uint64 maxPerWindow, uint64 delegateMaxVoucherAmount, uint64 delegateMaxPerWindow)",
]);

export interface NetworkEntry {
  /** CAIP-2. */
  id: string;
  /** CAIP-10. */
  escrow: string;
  /** CAIP-19. */
  asset: string;
  decimals: number;
}

export interface WireVoucher {
  payer: string;
  payTo: string;
  provider: string;
  amount: { amount: string; asset: string; decimals: number };
  resource: string;
  requestHash: string;
  seq: string;
  issuedAt: number;
  expiresAt: number;
}

function addressOf(caip10: string): string {
  return getAddress(caip10.split(":").pop()!);
}

function bytes32(requestHash: string): Hex {
  return `0x${requestHash.replace(/^sha256:/, "").toLowerCase()}` as Hex;
}

/**
 * The backend's voucher signature check: the signer recovered from the EIP-712 message built
 * from the wire voucher (`buildVoucherMessage`) on `network`'s escrow, or `null` when malformed.
 */
export async function recoverVoucherSigner(wire: WireVoucher, signature: string, network: NetworkEntry): Promise<string | null> {
  try {
    const chainId = Number(network.id.split(":")[1]);
    const signer = await recoverTypedDataAddress({
      domain: { name: "Assay Settlement", version: "2", chainId, verifyingContract: addressOf(network.escrow) as Hex },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: {
        payer: addressOf(wire.payer) as Hex,
        provider: addressOf(wire.provider) as Hex,
        amount: BigInt(wire.amount.amount),
        resourceHash: keccak256(stringToBytes(wire.resource)),
        requestHash: bytes32(wire.requestHash),
        seq: BigInt(wire.seq),
        issuedAt: BigInt(wire.issuedAt),
        expiresAt: BigInt(wire.expiresAt),
      },
      signature: signature as Hex,
    });
    return getAddress(signer);
  } catch {
    return null;
  }
}

/** `VoucherService`'s checks against the issued requirement, then the signature. */
export async function verifyVoucher(
  wire: WireVoucher,
  signature: string,
  requirement: Record<string, unknown>,
  network: NetworkEntry,
  expectedSigner: string,
  nowSeconds: number,
): Promise<string | null> {
  const amount = requirement.amount as WireVoucher["amount"];
  if (wire.payer !== requirement.payer) return "payer";
  if (wire.payTo !== requirement.payTo) return "payTo";
  if (wire.provider !== requirement.provider) return "provider";
  if (wire.amount?.amount !== amount.amount || wire.amount.asset !== amount.asset || wire.amount.decimals !== amount.decimals) return "amount";
  if (wire.resource !== requirement.resource) return "resource";
  if (wire.requestHash !== requirement.requestHash) return "requestHash";
  if (wire.seq !== requirement.seq) return "seq";
  const life = Math.min(240, requirement.maxTimeoutSeconds as number);
  if (!Number.isSafeInteger(wire.issuedAt) || !Number.isSafeInteger(wire.expiresAt)) return "times";
  if (wire.expiresAt - wire.issuedAt > life || wire.expiresAt <= wire.issuedAt) return "lifetime";
  if (wire.expiresAt <= nowSeconds || wire.issuedAt > nowSeconds + 120) return "expired";
  const signer = await recoverVoucherSigner(wire, signature, network);
  if (signer === null || signer !== getAddress(expectedSigner)) return "signature";
  return null;
}

export interface Grant {
  validUntil: bigint;
  revoked: boolean;
  maxVoucherAmount: bigint;
  maxPerWindow: bigint;
}

export interface SeenCall {
  name: string;
  params: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export class FakeAssay {
  port = 0;
  network: NetworkEntry;
  /** Atomic price of `weather`, and its `maxAmount` quote. */
  price = 250_000n;
  maxAmount: bigint | null = null;
  /** The delegate bound to the credential (bare checksummed address), or `null`. */
  delegate: string | null = null;
  /** On-chain grants of `PAYER` by delegate address (lower case). */
  readonly grants = new Map<string, Grant>();
  /** Every voucher call answers PAYMENT_REQUIRED again (a misbehaving server). */
  repeatPaymentRequired = false;
  /** Refuse vouchers with PAYMENT_VOUCHER_DELEGATE_INACTIVE. */
  delegateInactive = false;
  /** Server clock skew in seconds (the `Date` header and challenge expiry follow it). */
  skewSeconds = 0;
  /** The payer the session names (a test can switch it). */
  payer = PAYER;
  /** The bind answer names this delegate (or pending key) instead of the one bound (a misbehaving server). */
  bindAnswerDelegate: string | null = null;
  /** `payTo` sent in requirements instead of the network's escrow. */
  payToOverride: string | null = null;
  /** Runs before the challenge is answered (tests hold the binder in its network phase). */
  beforeChallenge: (() => Promise<void>) | null = null;
  /** Delay before every MCP answer, ms. */
  delayMs = 0;
  /** `GET /agents/me/delegate/status` exists (false: an older backend, which answers 404). */
  statusRoute = true;
  /**
   * Binding a key while another is bound leaves it pending (`PENDING_APPROVAL`, the backend's
   * rebinding) until `approvePending()`; false: the new key replaces the old one at once.
   */
  pendingRebind = false;
  /** The bind request answers 409 `ACCOUNT_DELEGATE_ALREADY_BOUND` (the key is held by another live credential). */
  alreadyBound = false;
  /** The key waiting for approval (bare checksummed address), or `null`. */
  pendingDelegate: string | null = null;
  /** The origin of `approvalUrl` in the bind and status answers (the backend's `WEB_APP_URL`), or `null` for none. */
  approvalOrigin: string | null = null;
  /** The scopes of every bearer (the backend's agent key scopes). */
  scopes: readonly string[] = ["tools:call", "payments", "activity:read"];
  /** The bearers this server accepts: the API key, and an OAuth access token a test adds. */
  readonly bearers = new Set<string>([API_KEY]);
  readonly calls: SeenCall[] = [];
  readonly accepted: { seq: string; signature: string; amount: string; idempotencyKey: unknown }[] = [];
  readonly rejected: string[] = [];
  readonly paths: string[] = [];
  readonly fetched: string[] = [];
  readonly opened: string[] = [];
  readonly challenges: string[] = [];
  readonly rpcCalls: string[] = [];
  private nextSeq = 1n;
  private readonly issued = new Map<string, Record<string, unknown>>();
  private readonly redeemed = new Set<string>();
  private challenge: { id: string; delegate: string; nonce: string; expiresAt: number } | null = null;
  private server: Server | null = null;

  constructor(network: NetworkEntry) {
    this.network = network;
  }

  get chainId(): number {
    return Number(this.network.id.split(":")[1]);
  }

  private nowSeconds(): number {
    return Math.floor(Date.now() / 1000) + this.skewSeconds;
  }

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

  grant(delegate: string, g: Partial<Grant> = {}): void {
    this.grants.set(delegate.toLowerCase(), {
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
      revoked: false,
      maxVoucherAmount: 500_000n,
      maxPerWindow: 5_000_000n,
      ...g,
    });
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.setHeader("date", new Date(this.nowSeconds() * 1000).toUTCString());
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (path === "/__test/browser") {
      this.opened.push(raw);
      res.writeHead(200).end();
      return;
    }
    if (path === "/__test/fetch") {
      this.fetched.push(raw);
      res.writeHead(200).end();
      return;
    }
    let json: Record<string, unknown> = {};
    try {
      json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      // not JSON
    }
    if (path === "/__rpc") return this.rpc(json, res);
    this.paths.push(`${req.method} ${path}`);
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!this.bearers.has(bearer)) return this.send(res, 401, { statusCode: 401, message: "MCP_CREDENTIAL_INVALID" });
    // The backend's scope check: the MCP host needs `tools:call`, the delegate routes `payments`.
    const needed = path.startsWith("/api/v1/agents/me/delegate") ? "payments" : path.startsWith("/api/v1/") ? null : "tools:call";
    if (needed !== null && !this.scopes.includes(needed)) {
      return this.send(res, 403, { success: false, error: { code: "AUTH_SCOPE_MISSING", message: `This key does not have the ${needed} scope.`, statusCode: 403, context: { requiredScope: needed } } });
    }
    if (path.startsWith("/api/v1/")) return this.api(req.method ?? "GET", path.slice("/api/v1".length), json, res);
    if (typeof json.method !== "string" || json.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const result = await this.mcp(json.method, (json.params ?? {}) as Record<string, unknown>);
    this.send(res, 200, { jsonrpc: "2.0", id: json.id, result });
  }

  // ---- API ----------------------------------------------------------------------------------

  private async api(method: string, path: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const caip = (a: string) => `${this.network.id}:${getAddress(a)}`;
    if (method === "POST" && path === "/agents/me/delegate/challenge") {
      const delegate = String(body.delegate ?? "");
      this.challenges.push(delegate);
      if (this.beforeChallenge) await this.beforeChallenge();
      const expiresAt = this.nowSeconds() + 300;
      this.challenge = { id: randomUUID(), delegate: getAddress(delegate), nonce: randomUUID(), expiresAt };
      return this.send(res, 201, {
        data: {
          challengeId: this.challenge.id,
          delegate: caip(delegate),
          expiresAt: new Date(expiresAt * 1000).toISOString(),
          typedData: {
            domain: { name: "GoAssay Agent Binding", version: "1", chainId: String(this.chainId) },
            types: BINDING_TYPES,
            primaryType: "DelegateBinding",
            message: { delegate: getAddress(delegate), credentialId: CREDENTIAL_ID, nonce: this.challenge.nonce, expiresAt: String(expiresAt) },
          },
        },
        statusCode: 201,
        message: "Success",
      });
    }
    if (method === "POST" && path === "/agents/me/delegate") {
      const c = this.challenge;
      this.challenge = null;
      if (!c || c.id !== body.challengeId || c.expiresAt < this.nowSeconds()) return this.send(res, 400, { message: "ACCOUNT_DELEGATE_CHALLENGE_INVALID" });
      let signer: string | null;
      try {
        signer = await recoverTypedDataAddress({
          domain: { name: "GoAssay Agent Binding", version: "1", chainId: this.chainId },
          types: BINDING_TYPES,
          primaryType: "DelegateBinding",
          message: { delegate: c.delegate as Hex, credentialId: CREDENTIAL_ID, nonce: c.nonce, expiresAt: BigInt(c.expiresAt) },
          signature: String(body.signature) as Hex,
        });
      } catch {
        signer = null;
      }
      if (signer === null || getAddress(signer) !== c.delegate) return this.send(res, 400, { message: "ACCOUNT_DELEGATE_SIGNATURE_INVALID" });
      if (this.alreadyBound) {
        return this.send(res, 409, { success: false, error: { code: "ACCOUNT_DELEGATE_ALREADY_BOUND", message: "already bound", statusCode: 409 } });
      }
      const replacing = this.delegate !== null && this.delegate !== c.delegate;
      if (this.pendingRebind && replacing) {
        this.pendingDelegate = c.delegate;
        const answer = this.binding();
        return this.send(res, 201, { data: { ...answer, ...(this.bindAnswerDelegate ? { pendingDelegate: caip(this.bindAnswerDelegate) } : {}), status: "PENDING_APPROVAL" } });
      }
      this.delegate = c.delegate;
      this.pendingDelegate = null;
      const answer = this.binding();
      return this.send(res, 201, { data: { ...answer, delegate: caip(this.bindAnswerDelegate ?? c.delegate), boundAt: new Date().toISOString(), status: "ACTIVE" } });
    }
    if (method === "GET" && path === "/agents/me/delegate/status" && this.statusRoute) {
      return this.send(res, 200, { data: { ...this.binding(), bound: this.delegate !== null } });
    }
    if (method === "GET" && path === "/agents/me/delegate") {
      const g = this.delegate ? this.grants.get(this.delegate.toLowerCase()) : undefined;
      const active = g !== undefined && !g.revoked && g.validUntil > BigInt(this.nowSeconds());
      return this.send(res, 200, {
        data: {
          ...this.binding(),
          paidCalls: this.delegate
            ? active
              ? { status: "ACTIVE", maxVoucherAmount: String(g!.maxVoucherAmount), maxPerWindow: String(g!.maxPerWindow), spentInWindow: "0", validUntil: new Date(Number(g!.validUntil) * 1000).toISOString() }
              : { status: "NONE", maxVoucherAmount: null, maxPerWindow: null, spentInWindow: null, validUntil: null }
            : null,
        },
      });
    }
    this.send(res, 404, { message: "not found" });
  }

  // ---- MCP ----------------------------------------------------------------------------------

  /** The binding as every delegate route answers it (`AgentDelegateBindingDto`). */
  private binding(): Record<string, unknown> {
    const caip = (a: string) => `${this.network.id}:${getAddress(a)}`;
    const toApprove = this.pendingDelegate ?? this.delegate;
    return {
      credentialId: CREDENTIAL_ID,
      agentLabel: "agent",
      delegate: this.delegate ? caip(this.delegate) : null,
      boundAt: null,
      pendingDelegate: this.pendingDelegate ? caip(this.pendingDelegate) : null,
      pendingSince: this.pendingDelegate ? new Date().toISOString() : null,
      approvalUrl: this.approvalOrigin && toApprove ? `${this.approvalOrigin}/agents/enable-paid?credential=${CREDENTIAL_ID}#key=${toApprove}` : null,
    };
  }

  /** The payer approved the pending key on chain: the backend promotes it to `delegate`. */
  approvePending(): void {
    if (this.pendingDelegate === null) return;
    this.delegate = this.pendingDelegate;
    this.pendingDelegate = null;
  }

  priceObject(): Record<string, unknown> {
    const max = this.maxAmount ?? this.price;
    return { amount: String(this.price), maxAmount: String(max), asset: this.network.asset, display: "$0.25" };
  }

  private async mcp(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (method) {
      case "initialize":
        return { protocolVersion: params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake-assay", version: "1" } };
      case "tools/list":
        return {
          tools: [
            { name: "echo", description: "Echo", inputSchema: { type: "object" }, _meta: { "assay/price": { amount: "0", maxAmount: "0", asset: this.network.asset, display: "free" } } },
            { name: "weather", description: "Weather", inputSchema: { type: "object" }, _meta: { "assay/price": this.priceObject() } },
            { name: "owe", description: "Owed", inputSchema: { type: "object" } },
          ],
        };
      case "tools/call":
        return this.call(params);
      default:
        return {};
    }
  }

  private async call(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    let name = String(params.name);
    let args = (params.arguments ?? {}) as Record<string, unknown>;
    this.calls.push({ name, params, meta });
    if (name === "get_tool") {
      const inner = String(args.name);
      const out = { name: inner, price: inner === "weather" ? this.priceObject() : null };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    }
    if (name === "search_tools") {
      const out = { results: [{ name: "weather", score: 1, assayPrice: this.priceObject() }], categories: [], total: 1, nextCursor: null, limitApplied: 10 };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    }
    if (name === "call_tool") {
      name = String(args.name);
      args = (args.arguments ?? {}) as Record<string, unknown>;
    }
    if (name === "owe") {
      return { isError: true, content: [{ type: "text", text: "An unpaid call must be settled first." }], _meta: { "assay/error": { code: "PAYMENT_DEBT_OUTSTANDING", retryable: false } } };
    }
    if (name !== "weather") return { content: [{ type: "text", text: JSON.stringify({ name, arguments: args }) }] };

    const voucher = meta["assay/voucher"];
    if (voucher !== undefined && !this.repeatPaymentRequired) return this.settle(voucher, meta, name, args);
    return this.paymentRequired(name, args);
  }

  private requestHash(name: string, args: Record<string, unknown>): string {
    return `sha256:${createHash("sha256").update(JSON.stringify({ name, args, price: String(this.price) })).digest("hex")}`;
  }

  private paymentRequired(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const seq = String(this.nextSeq++);
    const caip = (a: string) => `${this.network.id}:${getAddress(a)}`;
    const requirement = {
      rail: "B",
      scheme: "voucher",
      network: this.network.id,
      payer: caip(this.payer),
      payTo: this.payToOverride ?? this.network.escrow,
      provider: caip(PROVIDER),
      providerId: PROVIDER_ID,
      amount: { amount: String(this.price), asset: this.network.asset, decimals: this.network.decimals },
      resource: `/mcp/tools/${name}`,
      requestHash: this.requestHash(name, args),
      seq,
      maxTimeoutSeconds: 300,
      signers: ["payer", "delegate"],
      delegate: this.delegate ? caip(this.delegate) : null,
    };
    this.issued.set(seq, requirement);
    return {
      isError: true,
      content: [{ type: "text", text: `${name} is paid on rail B: sign the voucher in x402/paymentRequired and call again with it in _meta["assay/voucher"].` }],
      _meta: {
        "assay/error": { code: "PAYMENT_REQUIRED", retryable: true, intentId: null },
        "x402/paymentRequired": requirement,
      },
    };
  }

  private async settle(raw: unknown, meta: Record<string, unknown>, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const refuse = (why: string, code = "PAYMENT_VOUCHER_INVALID") => {
      this.rejected.push(why);
      return { isError: true, content: [{ type: "text", text: `The voucher was refused (${why}).` }], _meta: { "assay/error": { code, retryable: false } } };
    };
    const env = raw as Record<string, unknown>;
    if (typeof env !== "object" || env === null || typeof env.voucher !== "object" || typeof env.signature !== "string" || typeof env.providerId !== "string") return refuse("envelope");
    if (env.providerId !== PROVIDER_ID) return refuse("providerId");
    const wire = env.voucher as WireVoucher;
    const requirement = this.issued.get(String(wire.seq));
    if (!requirement) return refuse("unknown seq");
    if (this.redeemed.has(wire.seq)) return refuse("seq used");
    if (requirement.requestHash !== this.requestHash(name, args)) return refuse("other call");
    if (this.delegateInactive) return refuse("delegate inactive", "PAYMENT_VOUCHER_DELEGATE_INACTIVE");
    if (!this.delegate) return refuse("no delegate bound", "PAYMENT_VOUCHER_DELEGATE_NOT_BOUND");
    const why = await verifyVoucher(wire, env.signature, requirement, this.network, this.delegate, this.nowSeconds());
    if (why !== null) return refuse(why);
    this.redeemed.add(wire.seq);
    this.accepted.push({ seq: wire.seq, signature: env.signature, amount: wire.amount.amount, idempotencyKey: meta["assay/idempotency-key"] });
    return {
      content: [{ type: "text", text: JSON.stringify({ forecast: "sunny", arguments: args }) }],
      _meta: { "assay/receipt": { intentId: randomUUID(), charged: { amount: wire.amount.amount, asset: wire.amount.asset } } },
    };
  }

  // ---- chain --------------------------------------------------------------------------------

  private rpc(json: Record<string, unknown>, res: ServerResponse): void {
    const id = json.id;
    const ok = (result: unknown): void => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    const method = String(json.method);
    this.rpcCalls.push(method);
    if (method === "eth_chainId") return ok(`0x${this.chainId.toString(16)}`);
    if (method === "eth_blockNumber") return ok("0x3e8");
    if (method !== "eth_call") return ok(null);
    const call = (json.params as [{ data: Hex }])[0];
    const decoded = decodeFunctionData({ abi: ESCROW_ABI, data: call.data });
    if (decoded.functionName === "escrowOf") {
      return ok(
        encodeFunctionResult({
          abi: ESCROW_ABI,
          functionName: "escrowOf",
          result: {
            balance: 50_000_000n,
            seqHigh: 0n,
            authNonce: 1n,
            maxVoucherAmount: 1_000_000n,
            maxPerWindow: 10_000_000n,
            spentInWindow: 0n,
            windowStartedAt: 0n,
            withdrawRequested: 0n,
            withdrawAvailableAt: 0n,
            totalRedeemed: 0n,
            totalWithdrawn: 0n,
            totalFunded: 50_000_000n,
          },
        }),
      );
    }
    const [payer, delegate] = decoded.args as [string, string];
    const g = getAddress(payer) === getAddress(this.payer) ? this.grants.get(delegate.toLowerCase()) : undefined;
    if (decoded.functionName === "delegationOf") {
      return ok(
        encodeFunctionResult({
          abi: ESCROW_ABI,
          functionName: "delegationOf",
          result: {
            maxVoucherAmount: g?.maxVoucherAmount ?? 0n,
            maxPerWindow: g?.maxPerWindow ?? 0n,
            spentInWindow: 0n,
            windowStartedAt: 0n,
            validUntil: g?.validUntil ?? 0n,
            listPosition: 0,
            revoked: g?.revoked ?? false,
          },
        }),
      );
    }
    const live = g !== undefined && !g.revoked;
    return ok(
      encodeFunctionResult({
        abi: ESCROW_ABI,
        functionName: "effectiveCapsOf",
        result: [1_000_000n, 10_000_000n, live ? g.maxVoucherAmount : 0n, live ? g.maxPerWindow : 0n],
      }),
    );
  }
}
