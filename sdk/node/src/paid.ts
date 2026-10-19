import { getAddress } from "viem";
import { toGuardChain, type ChainReader } from "@assay-core/chain/reads.js";
import { builtInDeployments, parseCaip10, type Environment } from "@assay-core/deployments.js";
import { builtInNetwork } from "@assay-core/guards/guards.js";
import type { QuoteCache } from "@assay-core/guards/quote-cache.js";
import { guardAndBuild, type GuardedVoucher } from "@assay-core/guards/sign.js";
import type { GuardContext, GuardId, GuardResult, SignedVoucher } from "@assay-core/guards/types.js";
import type { ResolvedDeployment } from "@assay-core/profile/deployments.js";
import type { TypedDataSigner } from "@assay-core/proxy/delegate-bind.js";
import {
  DELEGATE_INACTIVE_CODE,
  paymentState,
  providerIdOf,
  quoteFromGetTool,
  refusedText,
  voucherEnvelope,
  withVoucher,
  GET_TOOL,
} from "@assay-core/proxy/meta.js";
import { issuedAt } from "@assay-core/signer/clock.js";

/**
 * Paid calls in the SDK (spec §10, R-SDK-4, R-SDK-5): the `assay-mcp` paid path's guards and
 * signer, with the SDK's own inputs:
 * - G7's caps come from the constructor (`maxPerCall`, `maxPerDay`); there is no confirmation
 *   prompt (`confirmAbove` off) and no provider allow-list (G8 checks the provider only);
 * - G11's `paid-urls.json` is replaced by the `urls` allow list;
 * - the 24 h spend is counted per process and per signing address (see {@link spentBy}).
 *
 * The order is fixed: every guard passes on one frozen copy of the requirement, the voucher is
 * recorded against the daily cap, and only then is it signed, for exactly the checked values.
 * One voucher per call: the paid retry's answer is returned as is, whatever it says.
 */

export interface Refused {
  guard: GuardId;
  reason: string;
}

/** The answer to a paid call: the remote result, or a local refusal (nothing was signed). */
export type PaidOutcome = { kind: "result"; result: Record<string, unknown> } | { kind: "refused"; refused: Refused; text: string; original: Record<string, unknown> };

/**
 * The SDK's guard step: the shared `guardAndBuild` (G1–G12 on a frozen copy, then the voucher
 * built from that same copy and the built-in network of `env`). Exported so the vectors drive
 * exactly what the paid path runs.
 */
export function guardVoucher(ctx: Omit<GuardContext, "network">, issuedAtSeconds: number, env: Environment): GuardedVoucher | Exclude<GuardResult, { ok: true }> {
  return guardAndBuild(ctx, issuedAtSeconds, env);
}

export interface SdkGuardInputs {
  requirement: unknown;
  tool: string;
  forwardedAtSeconds: number;
  quote: GuardContext["quote"];
  chain: GuardContext["chain"];
  signerAddress: string;
  recordedPayer: string | null;
  maxPerCall: string;
  maxPerDay: string;
  signed: SignedVoucher[];
  url: string;
  urls: readonly string[];
  /** G8: the provider allow-list (stricter mode); `null` is off. */
  providers: readonly string[] | null;
  nowSeconds: number;
}

/** The guard context the SDK builds: caps from the constructor, `urls` for G11, no prompt, and G8's allow-list only when `providers` is set. */
export function sdkGuardContext(i: SdkGuardInputs): Omit<GuardContext, "network"> {
  return {
    requirement: i.requirement,
    forwardedCall: { tool: i.tool, at: i.forwardedAtSeconds },
    quote: i.quote,
    chain: i.chain,
    localKey: i.signerAddress,
    recordedPayer: i.recordedPayer,
    limits: { perCall: i.maxPerCall, perDay: i.maxPerDay, confirmAbove: null, providers: i.providers === null ? null : [...i.providers] },
    signed: i.signed,
    confirmation: null,
    canonicalUrl: i.url,
    paidUrls: [...i.urls],
    nowSeconds: i.nowSeconds,
  };
}

const SPEND_WINDOW_SECONDS = 86_400;
/** Vouchers signed in this process, by signing address (lower case). */
const LEDGER = new Map<string, SignedVoucher[]>();

/**
 * The vouchers this process signed with `address` in the last 24 h. Every `AssayClient` in the
 * process that uses the same key shares this record, so two clients cannot each spend a full
 * `maxPerDay`. It is not persisted: a new process starts at zero, and the on-chain caps set on
 * the enable-paid page bound the key across processes (spec §8.5).
 */
export function spentBy(address: string, nowSeconds: number): SignedVoucher[] {
  const key = address.toLowerCase();
  const kept = (LEDGER.get(key) ?? []).filter((e) => e.at > nowSeconds - SPEND_WINDOW_SECONDS);
  LEDGER.set(key, kept);
  return kept;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function accountOn(value: unknown, chainId: number): string | null {
  const parsed = typeof value === "string" ? parseCaip10(value) : null;
  return parsed && parsed.chainId === chainId ? getAddress(parsed.address) : null;
}

export interface PaidDeps {
  readonly deployment: ResolvedDeployment;
  readonly account: () => Promise<TypedDataSigner>;
  readonly maxPerCall: string;
  readonly maxPerDay: string;
  /** Canonical URLs paid calls may go through (G11). */
  readonly urls: readonly string[];
  /** G8 allow-list of provider addresses, or null (off). */
  readonly providers: readonly string[] | null;
  readonly chain: ChainReader;
  readonly quotes: QuoteCache;
  /** Sends `tools/call` with these params; the raw result. */
  readonly send: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Server clock minus local clock, seconds, from the last answer's `Date` header. */
  readonly dateOffset: () => number;
  readonly now: () => number;
}

export class PaidCalls {
  /** The payer recorded after the first chain-confirmed voucher (G4); a different one later is refused. */
  private recordedPayer: string | null = null;

  constructor(private readonly d: PaidDeps) {}

  /**
   * After a `tools/call` answered `PAYMENT_REQUIRED` for `tool`: the guards, the record, the
   * signature and one retry, or a refusal. Never signs twice for one call.
   */
  async pay(tool: string, params: Record<string, unknown>, forwardedAtMs: number, original: Record<string, unknown>, raw: unknown): Promise<PaidOutcome> {
    const refused = (guard: GuardId, reason: string): PaidOutcome => ({ kind: "refused", refused: { guard, reason }, text: refusedText(reason), original });
    const { deployment } = this.d;
    const env = deployment.environment;

    let requirement: Record<string, unknown>;
    try {
      const copy: unknown = deepFreeze(structuredClone(raw));
      if (!isObject(copy)) throw new TypeError("not an object");
      requirement = copy;
    } catch {
      return refused("G1", "the payment request is not a requirement");
    }
    if (requirement.rail !== "B") return refused("G1", "the payment request is not on rail B");
    if (requirement.scheme !== "voucher") return refused("G1", "the payment request is not a voucher");
    const network = typeof requirement.network === "string" ? builtInNetwork(builtInDeployments()[env], requirement.network) : null;
    if (network === null) return refused("G2", "the network is not in the built-in table");
    const chainId = Number(network.id.slice("eip155:".length));

    const account = await this.d.account();
    const signer = getAddress(account.address);
    const payer = accountOn(requirement.payer, chainId);
    // R-SDK-4 (L7): a signer that is the payer is refused before anything else is read.
    if (payer !== null && payer === signer) return refused("G5", "the signer is the payer; use a dedicated payment key");
    const bound = accountOn(requirement.delegate, chainId);
    if (bound !== signer) {
      return refused("G5", "this signer is not the payment key bound to this API key; call bindDelegate(), then approve enablePaidCallsUrl()");
    }

    const chain = payer === null ? null : toGuardChain(await this.d.chain.readDelegation(network.id, payer, signer), signer);
    const quote = this.d.quotes.get(tool) ?? (await this.fetchQuote(tool));

    // Guards, record and signature with no await between the guards and the record, so two
    // calls in flight cannot both pass the daily cap.
    const nowSeconds = Math.floor(this.d.now() / 1000);
    const signed = spentBy(signer, nowSeconds);
    const ctx = sdkGuardContext({
      requirement,
      tool,
      forwardedAtSeconds: Math.floor(forwardedAtMs / 1000),
      quote,
      chain,
      signerAddress: signer,
      recordedPayer: this.recordedPayer,
      maxPerCall: this.d.maxPerCall,
      maxPerDay: this.d.maxPerDay,
      signed,
      url: deployment.url,
      urls: this.d.urls,
      providers: this.d.providers,
      nowSeconds,
    });
    const built = guardVoucher(ctx, issuedAt(nowSeconds, this.d.dateOffset()), env);
    if (!built.ok) {
      if ((built.guard === "G4" || built.guard === "G6") && payer !== null) this.d.chain.invalidate(payer, signer, network.id);
      return refused(built.guard, built.reason);
    }
    const providerId = providerIdOf(requirement);
    if (providerId === null) return refused("G1", "the payment request names no provider");
    signed.push({ at: nowSeconds, amount: built.typedData.message.amount.toString() });
    if (this.recordedPayer === null && payer !== null) this.recordedPayer = payer;

    const signature = await account.signTypedData(built.typedData);
    const envelope = voucherEnvelope(built.wire, signature, providerId, requirement.contractVersion);
    const answer = await this.d.send(withVoucher(params, envelope));
    const after = paymentState(answer);
    if (after.kind === "error" && after.code === DELEGATE_INACTIVE_CODE && payer !== null) this.d.chain.invalidate(payer, signer, network.id);
    return { kind: "result", result: answer };
  }

  /** G3 fallback: `get_tool {name}` on the same URL, just before signing. */
  private async fetchQuote(tool: string) {
    try {
      const answer = await this.d.send({ name: GET_TOOL, arguments: { name: tool } });
      const pair = quoteFromGetTool(answer);
      if (pair === null || pair[0] !== tool) return null;
      this.d.quotes.set(pair[0], pair[1]);
      return pair[1];
    } catch {
      return null;
    }
  }
}
