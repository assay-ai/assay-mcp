import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getAddress, type Hex } from "viem";
import { toGuardChain, type ChainReader, type ChainState } from "../chain/reads.js";
import {
  channelDebtAnswer,
  CHANNEL_CODES,
  CHANNEL_REQUIRED_META,
  CHANNEL_VOUCHER_META,
  channelVoucherEnvelope,
  confirmationFor,
  correctedNow,
  PAYMENT_SCHEMES_META,
  type BuiltInNetwork,
  type Eip155NetworkEntry,
  type Confirmation,
  type DebtRenewal,
  type GuardId,
  type Quote,
} from "@goassay-ai/sdk/core";
import { parseCaip10 } from "../deployments.js";
import type { QuoteCache } from "../guards/quote-cache.js";
import { builtInNetwork, builtInNetworks, guardAndBuild, type ProxyGuardContext } from "../guards/sign.js";
import {
  answerCode,
  CHANNEL_RETRY_CODES,
  CHANNEL_RETRY_TEXT,
  channelNetworkOf,
  checkChannelOffer,
  checkLanes,
  finishPlannedLane,
  laneOutcomeOf,
  NO_ANSWER,
  offeredSchemes,
  planLane,
  poolOf,
  unsettledText,
  writePlan,
  type LaneLimits,
  type LanePlan,
} from "./channel-lane.js";
import { recordHeld, SpendLimitError } from "../guards/spend-record.js";
import { silentLogger, type Logger } from "../log/logger.js";
import { identifyCredential } from "../oauth/flow.js";
import type { ResolvedDeployment } from "../profile/deployments.js";
import type { Keychain } from "../profile/keychain.js";
import { withLock, type LockHandle, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { createProfile, paidUrlKey, readLimits, readPaidUrls, readProfileFor, readState, updateProfile, usdToUnits } from "../profile/profile.js";
import { generate } from "../signer/keygen.js";
import { openThroughGate } from "./browser-gate.js";
import { apiExchange, apiGet, apiRequest, BindError, bindDelegateKey, type BindResult } from "./delegate-bind.js";
import { hasLanes, renewProfileDebts } from "./channel-debt.js";
import { DELEGATE_STATUS_PATH, startEnablePoll } from "./enable-poll.js";
import { CONFIRMATION_TTL_MS, type CallRegistry, type ForwardedCall } from "./calls.js";
import { scopeMissingText, toolScopeMissingOf, type FetchLike } from "./forwarder.js";
import {
  appendText,
  debtSuffix,
  DELEGATE_INACTIVE_CODE,
  enablePaidLink,
  errorResult,
  GET_TOOL,
  noChainReadText,
  notAllowedText,
  notEnabledText,
  paidToolOf,
  paymentState,
  providerIdOf,
  quoteFromGetTool,
  quotesFromSearch,
  refusedText,
  serverApprovalLink,
  REFUSED_META,
  SEARCH_TOOLS,
  voucherEnvelope,
  withVoucher,
  type VoucherEnvelope,
} from "./meta.js";
import type { JsonRpcResponse } from "./protocol.js";

/**
 * The paid path (spec §7.7 steps 2–7, §7.8, F4, F5 step 3; R-MCP-8 to R-MCP-11, R-PAY-5).
 *
 * On each `tools/call` answer the proxy forwarded:
 * - quotes in `get_tool` and `search_tools` results go to the G3 cache (the proxy fills it from
 *   `tools/list` itself);
 * - `PAYMENT_DEBT_OUTSTANDING`: when `state.json` holds a channel lane, the channel debts this
 *   computer signed are renewed once (`channel-debt.ts`; at most once a minute, within it only
 *   listed; never with `--no-paid`) and the agent reads what to do (`channelDebtAnswer`): being
 *   collected, no payment record here (settle in the app once offered), or call again soon; with
 *   a per-call debt (or no lane here) the answer, with " Settle it at {WEB}/funding";
 * - `AUTH_SCOPE_MISSING` (a free-only key on a paid tool, before or after a voucher): the scope
 *   text ("This key cannot pay. ..." for `payments`); nothing is signed, re-signed or resent;
 * - `PAYMENT_REQUIRED` with `--no-paid`: the answer unchanged;
 * - this URL not in `paid-urls.json`: the allow-paid text;
 * - no payment key bound here, or no active grant on chain for it: under the profile lock, a key
 *   is generated if there is none and bound (F4 steps 2–3, every challenge field checked); the
 *   enable-paid text with the link and the fingerprint; the browser through the 10-minute gate;
 *   and a wait on fresh chain reads that ends with one `GET {API}/agents/me/delegate`;
 * - enabled: the guards on one frozen copy of the requirement, the G7 confirmation (MCP form
 *   elicitation, bound to this payment and to a single-use token) when the amount is above
 *   `confirmAbove`, then, in one hold of the profile lock, the spend record and the signature;
 *   the call is sent again with the same params, the same idempotency key and
 *   `_meta["assay/voucher"]`, and that answer goes to the host unchanged.
 *
 * At most one voucher per host call (`ForwardedCall.claimVoucher`). `/escrow/debts` is called only
 * for a channel-debt renew (a lane in `state.json`), `/escrow/next-seq` never. No key, signature or
 * token reaches a log line.
 */

/** What the paid path needs from the proxy. */
export interface PaidHost {
  /** The host call's records (confirmation tokens). */
  readonly calls: CallRegistry;
  /** Sends `tools/call` with `params` under the call's own id; the remote answer, as is. */
  resend(call: ForwardedCall, params: Record<string, unknown>): Promise<JsonRpcResponse>;
  /** Sends `get_tool {name}` on the same URL, under an id of the proxy's own. */
  getTool(name: string): Promise<JsonRpcResponse>;
  /** Whether the host declared form elicitation in `initialize`. */
  canElicit(): boolean;
  /** Sends `elicitation/create` to the host; the result, or `null` when none came by `deadlineMs`. */
  elicit(params: Record<string, unknown>, deadlineMs: number): Promise<unknown>;
  /** The bearer for the API (the access token or the API key), or `null` when signed out. */
  bearer(): Promise<string | null>;
  /** Server clock minus local clock, seconds, from the last MCP answer's `Date` header. */
  dateOffset(): number;
}

export interface PaidOptions {
  readonly deployment: ResolvedDeployment;
  readonly profile: ProfileRef;
  readonly keychain: Keychain;
  /** `--no-paid`: never sign. */
  readonly noPaid: boolean;
  readonly chain: ChainReader;
  readonly quotes: QuoteCache;
  /** `pinnedFetch` bound to the deployment (API requests). */
  readonly fetch: FetchLike;
  readonly openBrowser: (url: string) => Promise<boolean>;
  readonly stderr: (line: string) => void;
  readonly log?: Logger;
  readonly lockOptions?: LockOptions;
  /** Milliseconds clock. */
  readonly now?: () => number;
  /** The enable-paid wait: every 5 s (15 s after 2 minutes), for up to 15 minutes. */
  readonly pollMs?: number;
  /**
   * Tests only (the CLI never passes this): network ids of the built-in table treated as having the
   * channel door. It changes no escrow, asset or RPC: those still come from `deployments.json`.
   */
  readonly channelNetworks?: readonly string[];
  readonly pollMaxMs?: number;
}

export { POLL_MAX_MS, POLL_MS } from "./enable-poll.js";
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SIGNED_OUT_DURING_BIND = "Paid calls could not be set up: you signed out while the payment key was being bound. Sign in again, then ask again.";
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** A refusal for the host, with `_meta["assay-mcp/refused"]`. */
class Refusal {
  constructor(
    readonly guard: GuardId,
    readonly reason: string,
    readonly text: string = refusedText(reason),
  ) {}
}

/** The binding could not be made; the message is the tool text. */
class SetupError extends Error {}

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

/** A checksummed bare address from a CAIP-10 account on `chainId`, or `null`. */
function accountOn(value: unknown, chainId: number): string | null {
  const parsed = typeof value === "string" ? parseCaip10(value) : null;
  return parsed && parsed.chainId === chainId ? getAddress(parsed.address) : null;
}

/** Atomic units at `decimals` places as dollars: `$0.75`, `$12`, `$0.000001`. */
export function usdText(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  let fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fraction.length === 1) fraction += "0";
  return `$${whole}${fraction ? `.${fraction}` : ""}`;
}

/** The G7 prompt, from the guards' own parsed values only (never server text). */
export function confirmationMessage(c: Confirmation, decimals: number, chainId: number): string | null {
  const provider = accountOn(c.provider, chainId);
  if (provider === null || !/^(0|[1-9][0-9]*)$/.test(c.amount)) return null;
  return `Pay ${usdText(BigInt(c.amount), decimals)} to ${provider} for ${c.tool}?`;
}

/** How long channels are not offered after a channel refusal the next call cannot fix (`CHANNEL_LIMIT` and the like). */
export const CHANNEL_PAUSE_MS = 60 * 60 * 1000;
/** This many `CHANNEL_ROTATE` within {@link CHANNEL_PAUSE_MS} pause channels as well. */
export const CHANNEL_ROTATE_PAUSE_COUNT = 5;
/** After a paid call refused for a debt, channel debts are renewed at most this often. */
export const DEBT_RENEW_INTERVAL_MS = 60_000;

/** The `assay/error` of a result, or `null`. */
function assayErrorOf(result: unknown): Record<string, unknown> | null {
  const meta = isObject(result) ? result._meta : undefined;
  const e = isObject(meta) ? meta["assay/error"] : undefined;
  return isObject(e) && typeof e.code === "string" ? e : null;
}

/** What one channel voucher for this call may use: the offer passed its checks against the requirement. */
interface ChannelSetup {
  net: ReturnType<typeof channelNetworkOf>;
  pool: NonNullable<ReturnType<typeof poolOf>>;
  limits: LaneLimits;
  lifetimeSeconds: number;
}

export class PaidPath {
  private readonly log: Logger;
  private readonly now: () => number;
  private poll: { stop: () => void; network: string; payer: string; address: string } | null = null;
  /** Until when (ms) the proxy offers no channel. */
  private channelPausedUntil = 0;
  /** When Assay rotated a lane (ms); a burst of rotations pauses channels too. */
  private rotations: number[] = [];
  /** Before when (ms) a debt refusal does not renew channel debts again. */
  private debtRenewNotBefore = 0;
  /** The results of the last renewing run, by intent (what a throttled run reports). */
  private lastRenewals = new Map<string, DebtRenewal>();

  /** LIMIT-like codes pause channel offers for an hour; so do {@link CHANNEL_ROTATE_PAUSE_COUNT} rotations within an hour. */
  private channelRefused(code: string): void {
    const now = this.now();
    if (code === CHANNEL_CODES.CHANNEL_ROTATE) {
      this.rotations = [...this.rotations.filter((t) => now - t < CHANNEL_PAUSE_MS), now];
      if (this.rotations.length < CHANNEL_ROTATE_PAUSE_COUNT) return;
      this.rotations = [];
    }
    this.channelPausedUntil = now + CHANNEL_PAUSE_MS;
  }

  constructor(
    private readonly o: PaidOptions,
    private readonly host: PaidHost,
  ) {
    this.log = (o.log ?? silentLogger).child("paid");
    this.now = o.now ?? Date.now;
  }

  /** `assay/paymentSchemes` on every forwarded call, when this environment has a channel-capable network. */
  callMeta(): Record<string, unknown> {
    if (this.o.noPaid || this.now() < this.channelPausedUntil) return {};
    const offered = offeredSchemes(this.channelCapable());
    return offered === null ? {} : { [PAYMENT_SCHEMES_META]: offered };
  }

  /** The built-in networks of this environment, with the channel door as `deployments.json` (or a test) says. */
  private channelCapable(): ReadonlyMap<string, Eip155NetworkEntry> {
    const networks = builtInNetworks(this.o.deployment.environment);
    const extra = this.o.channelNetworks ?? [];
    if (extra.length === 0) return networks;
    return new Map([...networks].map(([id, e]) => [id, extra.includes(id) ? { ...e, channels: true } : e]));
  }

  /** Quotes from a remote `tools/list` result (before alias rewriting). */
  observeList(pairs: readonly (readonly [string, Quote])[]): void {
    this.o.quotes.setAll(pairs);
  }

  /** The `tools/call` hook: never throws; on an unexpected failure nothing is signed. */
  async onToolResult(call: ForwardedCall, response: JsonRpcResponse): Promise<JsonRpcResponse> {
    if (!("result" in response)) return response;
    const result = response.result;
    this.observeMetaTool(call, result);
    const scoped = this.scopeRefused(response);
    if (scoped !== null) return scoped;
    const state = paymentState(result);
    if (state.kind === "debt") return this.debtAnswer(response, result);
    if (state.kind === "error" && state.code === CHANNEL_CODES.PAYMENT_UNSETTLED_LIMIT) return this.unsettled(response, result);
    if (state.kind !== "payment-required" || this.o.noPaid) return response;
    try {
      return await this.pay(call, response, result, state.requirement);
    } catch (err) {
      this.log.warn("paid call not completed", { tool: call.tool, error: err instanceof Error ? err.name : "error" });
      const text = err instanceof SetupError ? err.message : "Assay asked for a payment this app could not complete. Try again.";
      return { ...response, result: errorResult(text, result) };
    }
  }

  private observeMetaTool(call: ForwardedCall, result: Record<string, unknown>): void {
    if (call.tool === GET_TOOL) {
      const pair = quoteFromGetTool(result);
      if (pair) this.o.quotes.set(pair[0], pair[1]);
    } else if (call.tool === SEARCH_TOOLS) {
      this.o.quotes.setAll(quotesFromSearch(result));
    }
  }

  /** An `AUTH_SCOPE_MISSING` tool refusal with the proxy's scope text; `null` for any other answer. */
  private scopeRefused(response: JsonRpcResponse): JsonRpcResponse | null {
    if (!("result" in response)) return null;
    const missing = toolScopeMissingOf(response.result);
    if (missing === undefined) return null;
    this.log.info("scope missing", { scope: missing.scope ?? "unnamed" });
    return { ...response, result: errorResult(scopeMissingText(missing.scope), response.result) };
  }

  /**
   * `PAYMENT_DEBT_OUTSTANDING`: the channel debts this computer signed are renewed once (within a
   * minute of the last renew only listed), and the agent reads what to do (`channelDebtAnswer`,
   * the server's `_meta` kept): being collected, no payment record here (settle in the app once
   * offered), or call again soon. A per-call debt, no lane here or no debt list: the answer with
   * " Settle it at {WEB}/funding", as before. Never throws.
   */
  private async debtAnswer(response: JsonRpcResponse, result: Record<string, unknown>): Promise<JsonRpcResponse> {
    try {
      const answer = channelDebtAnswer(await this.renewDebts(), this.o.deployment.web);
      if (answer !== null) return { ...response, result: errorResult(answer.text, result) };
    } catch (err) {
      this.log.warn("channel debt renew not completed", { error: err instanceof Error ? err.name : "error" });
    }
    return { ...response, result: appendText(result, debtSuffix(this.o.deployment.web)) };
  }

  /**
   * One renew of this computer's channel debts, or `null` when there is nothing it could renew
   * (`--no-paid`, no channel-capable network, no lane in `state.json`, no payment key, signed out).
   * At most one renewing run a minute; within it the debts are only listed (nothing signed) and a
   * debt reads as the last run left it. The API is called outside the profile lock.
   */
  private async renewDebts(): Promise<DebtRenewal[] | null> {
    if (this.o.noPaid) return null;
    const networks = new Map([...this.channelCapable()].filter(([, e]) => e.channels === true).map(([id, e]) => [id, channelNetworkOf(e)]));
    if (networks.size === 0 || !hasLanes(this.o.profile)) return null;
    const account = await this.account();
    if (account === null) return null;
    const bearer = await this.host.bearer();
    if (bearer === null) return null;
    const now = this.now();
    const throttled = now < this.debtRenewNotBefore;
    if (!throttled) this.debtRenewNotBefore = now + DEBT_RENEW_INTERVAL_MS;
    const renewals = await renewProfileDebts(
      {
        profile: this.o.profile,
        ...(this.o.lockOptions !== undefined ? { lockOptions: this.o.lockOptions } : {}),
        networks,
        account,
        api: (method, path, body) => apiExchange(this.o.fetch, this.o.deployment.api, bearer, method, path, body, this.log),
        now: this.now,
        dateOffset: () => this.host.dateOffset(),
      },
      throttled ? { renew: false, retryAfterMs: this.debtRenewNotBefore - now, previous: this.lastRenewals } : {},
    );
    if (!throttled) this.lastRenewals = new Map(renewals.map((r) => [r.intentId, r]));
    this.log.info("channel debts", { renewed: renewals.filter((r) => r.status === "renewed").length, debts: renewals.length, listOnly: throttled });
    return renewals;
  }

  /** `PAYMENT_UNSETTLED_LIMIT` with the text the agent reads; the server's `_meta` is kept. */
  private unsettled(response: JsonRpcResponse, result: Record<string, unknown>): JsonRpcResponse {
    return { ...response, result: errorResult(unsettledText(assayErrorOf(result)?.retryAfter), result) };
  }

  /**
   * The channel lane for this payment, when the server offered one and this environment's entry for
   * the network has the channel door: the offer is checked against the requirement and the built-in
   * entry (an offer for any other escrow is refused, never signed). `null`: pay per call.
   */
  private channelSetup(requirement: Record<string, unknown>, network: BuiltInNetwork, localAddress: string, chain: ChainState | null, offer: unknown): ChannelSetup | null {
    if (offer === undefined || offer === null || this.now() < this.channelPausedUntil) return null;
    const entry = this.channelCapable().get(network.id);
    if (entry?.channels !== true) return null;
    const net = channelNetworkOf(entry);
    const checked = checkChannelOffer(offer, requirement, net);
    const pool = poolOf(net, requirement, localAddress);
    if (!checked.ok || pool === null) {
      if (!checked.ok) this.log.info("channel offer refused", { reason: checked.reason });
      return null;
    }
    const perDay = usdToUnits(readLimits(this.o.profile).perDay, entry.decimals);
    const window = chain?.delegateMaxPerWindow !== undefined ? BigInt(chain.delegateMaxPerWindow) : perDay;
    return {
      net,
      pool,
      limits: { price: checked.offer.price, maxLanes: checked.offer.maxLanes, rotateAt: window < perDay ? window : perDay },
      lifetimeSeconds: checked.offer.lifetimeSeconds,
    };
  }

  private refused(response: JsonRpcResponse, result: Record<string, unknown>, r: Refusal): JsonRpcResponse {
    this.log.info("payment refused", { guard: r.guard });
    return { ...response, result: errorResult(r.text, result, { [REFUSED_META]: { guard: r.guard, reason: r.reason } }) };
  }

  private async pay(call: ForwardedCall, response: JsonRpcResponse, result: Record<string, unknown>, raw: unknown, reasked = false): Promise<JsonRpcResponse> {
    const { deployment, profile } = this.o;
    // G1: the tool this call pays for (the inner name on `call_tool`).
    const tool = paidToolOf(call.tool, call.params);
    if (tool === null) return this.refused(response, result, new Refusal("G1", "the payment request is not the answer to a forwarded tool call"));

    // §7.7 step 5 (G11).
    const urlKey = paidUrlKey(deployment);
    if (!readPaidUrls(profile).includes(urlKey)) return { ...response, result: errorResult(notAllowedText(deployment.url, profile.name), result) };

    // One frozen copy of the requirement: every decision below reads this, and so does the signer.
    let requirement: Record<string, unknown>;
    try {
      const copy: unknown = deepFreeze(structuredClone(raw));
      if (!isObject(copy)) throw new TypeError("not an object");
      requirement = copy;
    } catch {
      return this.refused(response, result, new Refusal("G1", "the payment request is not a requirement"));
    }
    // G1 first (review M6): only a rail-B voucher request can lead to a key or a binding.
    if (requirement.rail !== "B") return this.refused(response, result, new Refusal("G1", "the payment request is not on rail B"));
    if (requirement.scheme !== "voucher") return this.refused(response, result, new Refusal("G1", "the payment request is not a voucher"));
    const network = typeof requirement.network === "string" ? builtInNetwork(deployment.environment, requirement.network) : null;
    if (network === null) return this.refused(response, result, new Refusal("G2", "the network is not in the built-in table"));
    const chainId = Number(network.id.slice("eip155:".length));

    const local = await this.localKey();
    const bound = requirement.delegate === null || requirement.delegate === undefined ? null : accountOn(requirement.delegate, chainId);
    const payer = accountOn(requirement.payer, chainId);

    if (local === null || bound === null || bound !== local.address) {
      // Step 6: no key here, or another key (or none) bound to this credential.
      return this.notEnabled(call, response, result, network, payer, true, reasked);
    }

    const chain = payer === null ? null : toGuardChain(await this.o.chain.readDelegation(network.id, payer, local.address), local.address);
    if (chain !== null && (!chain.active || BigInt(chain.validUntil) <= BigInt(Math.floor(this.now() / 1000)))) {
      // Not cached as "off": the next call reads the chain again, so an approval shows at once.
      this.o.chain.invalidate(payer!, local.address, network.id);
      return this.notEnabled(call, response, result, network, payer, false, reasked);
    }

    // G3: the cached quote, or a `get_tool` sent just now on the same URL.
    const quote = this.o.quotes.get(tool) ?? (await this.fetchQuote(tool));
    const meta = isObject(result._meta) ? result._meta : {};
    const offer = Object.keys(this.callMeta()).length > 0 ? meta[CHANNEL_REQUIRED_META] : undefined;
    return this.guardSignRetry(call, response, result, requirement, network, tool, local.address, chain, quote, urlKey, payer, offer);
  }

  // ---- step 7 ---------------------------------------------------------------------------

  private async guardSignRetry(
    call: ForwardedCall,
    response: JsonRpcResponse,
    result: Record<string, unknown>,
    requirement: Record<string, unknown>,
    network: BuiltInNetwork,
    tool: string,
    localAddress: string,
    chain: ChainState | null,
    quote: Quote | null,
    urlKey: string,
    payer: string | null,
    offer: unknown,
  ): Promise<JsonRpcResponse> {
    const { deployment, profile } = this.o;
    const env = deployment.environment;
    const forwardedCall = { tool, at: Math.floor(call.startedAt / 1000) };
    let confirmation: Confirmation | null = null;
    // A channel lane: a lane that needs a chain check gets it now, outside the paid lock.
    const lane = this.channelSetup(requirement, network, localAddress, chain, offer);
    if (lane !== null) await checkLanes(profile, this.o.chain, lane.pool, lane.limits, this.now, this.o.lockOptions).catch(() => undefined);

    for (let pass = 0; pass < 2; pass++) {
      type Step =
        | { kind: "refused"; guard: GuardId; code: string; reason: string }
        | { kind: "again" }
        | { kind: "signed"; envelope: VoucherEnvelope; metaKey?: string; channelId?: string };
      const step = await withLock(
        profile,
        async (lock): Promise<Step> => {
          // Everything the guards read is read under the lock (G7 `signed`, the terminal files).
          const nowSeconds = Math.floor(this.now() / 1000);
          const limits = readLimits(profile);
          const record = readProfileFor(profile, env);
          const ctx: ProxyGuardContext = {
            requirement,
            forwardedCall,
            quote,
            chain,
            localKey: localAddress,
            recordedPayer: record?.payer ?? null,
            limits: { perCall: limits.perCall, perDay: limits.perDay, confirmAbove: limits.confirmAbove, providers: limits.providers },
            signed: readState(profile).signed,
            confirmation,
            canonicalUrl: urlKey,
            paidUrls: readPaidUrls(profile),
            nowSeconds,
          };
          const built = guardAndBuild(ctx, correctedNow(nowSeconds, this.host.dateOffset()), env);
          if (!built.ok) return { kind: "refused", guard: built.guard, code: built.code, reason: built.reason };

          // The key that signs is re-read under the lock and must be the key the guards checked.
          const account = await this.account();
          if (account === null || account.address !== getAddress(localAddress)) {
            return { kind: "refused", guard: "G5", code: "G5_DELEGATE_MISMATCH", reason: "the payment key changed while the payment was checked" };
          }
          const providerId = providerIdOf(requirement);
          if (providerId === null) {
            return { kind: "refused", guard: "G1", code: "G1_NOT_A_REQUIREMENT", reason: "the payment request names no provider" };
          }
          // The host cancelled the call (review M2): nobody would receive the paid answer.
          if (call.cancelled) return { kind: "refused", guard: "G1", code: "G1_NOT_FORWARDED", reason: "the call was cancelled" };
          if (!call.claimVoucher()) return { kind: "again" };
          // The channel step, from the lane record in state.json only; `null` pays per call.
          let plan: LanePlan | null = null;
          if (lane !== null) {
            try {
              const perDay = usdToUnits(limits.perDay, network.decimals);
              const rotateAt = perDay < lane.limits.rotateAt ? perDay : lane.limits.rotateAt;
              const issuedAt = correctedNow(nowSeconds, this.host.dateOffset());
              plan = planLane(profile, lock, lane.net, lane.pool, { ...lane.limits, rotateAt }, issuedAt, lane.lifetimeSeconds, nowSeconds);
            } catch {
              plan = null;
            }
          }
          // Only what the voucher adds counts toward the daily limit: the price, or nothing when a
          // channel voucher signs the same total again.
          const spend = plan !== null ? plan.increase : built.typedData.message.amount;
          try {
            if (spend > 0n) recordHeld(profile, lock, spend, { limits, decimals: network.decimals, now: this.now });
          } catch (err) {
            if (err instanceof SpendLimitError) return { kind: "refused", guard: "G7", code: "G7_PER_DAY", reason: "the daily limit set for this computer would be passed" };
            throw err;
          }
          // Write-ahead: the lane's new total is on disk before it is signed.
          if (plan !== null) writePlan(profile, lock, plan);
          if (record !== null && record.payer === null && payer !== null) {
            // G4: the payer is recorded once the chain confirmed its grant to this key.
            updateProfile(profile, lock, (current) => ({ ...current, payer, network: network.id }));
          }
          lock.assertHeld();
          if (plan !== null) {
            const signature = await account.signTypedData(plan.typedData as never);
            const envelope = channelVoucherEnvelope(plan.wire, signature, providerId, requirement.contractVersion) as unknown as VoucherEnvelope;
            return { kind: "signed", envelope, metaKey: CHANNEL_VOUCHER_META, channelId: plan.channelId };
          }
          const signature = await account.signTypedData(built.typedData);
          return { kind: "signed", envelope: voucherEnvelope(built.wire, signature, providerId, requirement.contractVersion) };
        },
        this.o.lockOptions,
      );

      if (step.kind === "again") return response; // R-MCP-9: a second PAYMENT_REQUIRED goes back unsigned
      if (step.kind === "signed") {
        this.log.info(step.channelId ? "channel voucher signed" : "voucher signed", { tool, amount: (requirement.amount as { amount: string }).amount });
        const params =
          step.metaKey === undefined
            ? withVoucher(call.params, step.envelope)
            : { ...call.params, _meta: { ...(isObject(call.params._meta) ? call.params._meta : {}), [step.metaKey]: step.envelope } };
        let answer: JsonRpcResponse;
        try {
          answer = await this.host.resend(call, params);
        } catch (err) {
          // No answer: what the server did with the voucher is unknown, so the lane is never reused
          // and its pair stays renewable (it may have been stored; spec 12.4).
          if (step.channelId) await finishPlannedLane(profile, step.channelId, "unknown", this.o.lockOptions).catch(() => undefined);
          throw err;
        }
        const after = "result" in answer ? paymentState(answer.result) : { kind: "none" as const };
        if (after.kind === "error" && after.code === DELEGATE_INACTIVE_CODE && payer !== null) {
          this.o.chain.invalidate(payer, localAddress, network.id);
        }
        if (step.channelId) {
          const code = "result" in answer ? answerCode(answer.result) : NO_ANSWER;
          // A JSON-RPC error with no result is no answer too: `unknown`, never a refusal.
          const outcome = code === NO_ANSWER ? "unknown" : laneOutcomeOf(code);
          await finishPlannedLane(profile, step.channelId, outcome, this.o.lockOptions).catch(() => undefined);
          // One voucher per host call (R-MCP-9): a channel refusal is answered with a text, and the
          // next call opens a new lane (CHANNEL_ROTATE) or pays per call while channels pause.
          if (code !== null && CHANNEL_RETRY_CODES.has(code) && "result" in answer) {
            this.channelRefused(code);
            return { ...answer, result: errorResult(CHANNEL_RETRY_TEXT, answer.result) };
          }
          // A debt that refused the channel voucher (nothing stored; the lane is re-armed).
          if (after.kind === "debt" && "result" in answer) return this.debtAnswer(answer, answer.result);
        }
        if (after.kind === "error" && after.code === CHANNEL_CODES.PAYMENT_UNSETTLED_LIMIT && "result" in answer) return this.unsettled(answer, answer.result);
        // A key that may not pay is refused even with the voucher: say so, and sign nothing more.
        return this.scopeRefused(answer) ?? answer;
      }
      if (step.code === "G7_CONFIRMATION_REQUIRED" && pass === 0) {
        const asked = await this.confirm(call, requirement, forwardedCall, network);
        if (asked instanceof Refusal) return this.refused(response, result, asked);
        confirmation = asked;
        continue;
      }
      if ((step.guard === "G4" || step.guard === "G6") && payer !== null) this.o.chain.invalidate(payer, localAddress, network.id);
      const text = step.code === "G4_NO_CHAIN_READ" ? noChainReadText() : refusedText(step.reason);
      return this.refused(response, result, new Refusal(step.guard, step.reason, text));
    }
    return this.refused(response, result, new Refusal("G7", "the confirmation was for another payment"));
  }

  /** G7 `confirmAbove`: MCP form elicitation, bound to this payment and to a single-use token. */
  private async confirm(
    call: ForwardedCall,
    requirement: Record<string, unknown>,
    forwardedCall: { tool: string; at: number },
    network: BuiltInNetwork,
  ): Promise<Confirmation | Refusal> {
    if (!this.host.canElicit()) {
      return new Refusal("G7", "the amount is above the confirmation limit and this app cannot ask you to confirm it");
    }
    const confirmation = confirmationFor({ requirement, forwardedCall });
    const chainId = Number(network.id.slice("eip155:".length));
    const message = confirmation === null ? null : confirmationMessage(confirmation, network.decimals, chainId);
    if (confirmation === null || message === null) return new Refusal("G7", "the payment could not be shown for confirmation");

    const token = this.host.calls.issueConfirmation(call);
    const deadline = call.startedAt + CONFIRMATION_TTL_MS;
    const answer = await this.host.elicit({ message, requestedSchema: { type: "object", properties: {} } }, deadline);
    const accepted = isObject(answer) && answer.action === "accept";
    const consumed = this.host.calls.consumeConfirmation(token);
    if (answer === null || consumed.kind === "expired") {
      return new Refusal(
        "G7",
        "the confirmation came more than 2 minutes after the call",
        "The payment was not made: it was confirmed more than 2 minutes after the call. Ask again to pay.",
      );
    }
    if (!accepted || call.cancelled) return new Refusal("G7", "you did not confirm the payment", "The payment was cancelled. Nothing was paid.");
    if (consumed.kind !== "ok" || consumed.call !== call) return new Refusal("G7", "the confirmation was for another payment");
    return confirmation;
  }

  /** G3 fallback: `get_tool {name}` on the same URL, just before signing. */
  private async fetchQuote(tool: string): Promise<Quote | null> {
    try {
      const answer = await this.host.getTool(tool);
      if (!("result" in answer)) return null;
      const pair = quoteFromGetTool(answer.result);
      if (pair === null || pair[0] !== tool) return null;
      this.o.quotes.set(pair[0], pair[1]);
      return pair[1];
    } catch {
      return null;
    }
  }

  // ---- step 6 and F4 ----------------------------------------------------------------------

  private async notEnabled(
    call: ForwardedCall,
    response: JsonRpcResponse,
    result: Record<string, unknown>,
    network: BuiltInNetwork,
    payer: string | null,
    bind: boolean,
    reasked: boolean,
  ): Promise<JsonRpcResponse> {
    const credentialId = await this.credentialId();
    if (credentialId === null) {
      // A key without `payments` cannot read its binding either: say so rather than "try again".
      await this.api("GET", DELEGATE_STATUS_PATH).catch((err: unknown) => {
        throw err instanceof BindError ? new SetupError(err.message) : err;
      });
      throw new SetupError("Paid calls could not be set up yet: this app's Assay sign-in is not confirmed. Try again in a minute.");
    }
    const bound = bind ? await this.bind(network, credentialId) : null;
    const address = bound !== null ? bound.address : (await this.localKey())?.address ?? null;
    if (address === null) throw new SetupError("Paid calls could not be set up: the payment key could not be read. Try again.");
    // Another key stays bound until the payer approves this one (rebinding): nothing to ask again.
    const pending = bound?.status === "PENDING_APPROVAL";

    // F5 step 3: an existing key bound to a new credential keeps its on-chain grant, so the call
    // is asked again (unsigned) for a requirement that names the bound key.
    if (bind && !pending && !reasked && payer !== null) {
      const chain = toGuardChain(await this.o.chain.readDelegation(network.id, payer, address), address);
      const live = chain !== null && chain.active && BigInt(chain.validUntil) > BigInt(Math.floor(this.now() / 1000));
      if (!live) this.o.chain.invalidate(payer, address, network.id);
      if (live) {
        const again = await this.host.resend(call, call.params);
        if (!("result" in again)) return again;
        const state = paymentState(again.result);
        if (state.kind !== "payment-required") return await this.onPlainAnswer(again);
        return this.pay(call, again, again.result, state.requirement, true);
      }
    }

    // The server's link only on the configured web origin, and only for this key; else our own.
    const link = serverApprovalLink(this.o.deployment.web, bound?.approvalUrl ?? null, address) ?? enablePaidLink(this.o.deployment.web, credentialId, address);
    if (link === null) throw new SetupError("Paid calls cannot be turned on from this app for this Assay deployment.");
    const opened = await openThroughGate(this.o.profile, link, this.o.openBrowser, { ...this.o.lockOptions, now: this.now });
    if (!opened) this.o.stderr(`assay-mcp: to turn on paid calls, open ${link}\n`);
    if (payer !== null) this.startPoll(network, payer, address);
    return { ...response, result: errorResult(notEnabledText(link, address), result) };
  }

  private async onPlainAnswer(answer: JsonRpcResponse): Promise<JsonRpcResponse> {
    if (!("result" in answer)) return answer;
    const scoped = this.scopeRefused(answer);
    if (scoped !== null) return scoped;
    return paymentState(answer.result).kind === "debt" ? this.debtAnswer(answer, answer.result) : answer;
  }

  /**
   * F4 steps 2–3, in two short holds of the profile lock with the network outside them (review I1):
   * - the bearer is taken first, outside any lock (a refresh takes the profile lock itself);
   * - hold 1: re-read the keychain and generate and store a key if there is none;
   * - no lock: challenge, every field checked, signature, `POST /agents/me/delegate`, and the
   *   answer must name this key;
   * - hold 2 (compare-and-set): the keychain is re-read; the binding is recorded only if it still
   *   holds the key that was bound. If the key is gone (a sign-out ran meanwhile) nothing is
   *   recorded, no key is made and the call ends with a message. If another window replaced the
   *   key, the binding is redone once. The keychain is the single source of truth: no side record
   *   is kept, so any number of windows binding at once do not invalidate each other.
   * The clock is corrected from the challenge answer's `Date` header (clamped to ±120 s); a
   * challenge refused on its expiry is retried once with a fresh one. Returns the bound address
   * and the server's answer: `PENDING_APPROVAL` when another key stays bound until the payer
   * approves this one (the key is recorded all the same: it is the one this computer signs with).
   */
  private async bind(network: BuiltInNetwork, credentialId: string): Promise<BindResult & { address: string }> {
    const { profile, keychain } = this.o;
    for (let round = 0; round < 2; round++) {
      const bearer = await this.host.bearer();
      if (bearer === null) throw new SetupError("Paid calls could not be set up: this app is not signed in to Assay.");

      const account = await withLock(
        profile,
        async (lock) => {
          let account = await this.account();
          if (account === null) {
            // Round 2 only follows a key that was replaced a moment ago; a missing key then means
            // a sign-out, and a new key must not appear after it.
            if (round > 0) throw new SetupError(SIGNED_OUT_DURING_BIND);
            const key = generate();
            await keychain.set(lock, "delegate_key", key.privateKey);
            account = await this.account();
            if (account === null || account.address !== key.address) throw new SetupError("Paid calls could not be set up: the payment key could not be stored. Try again.");
            this.log.info("payment key created");
          }
          return account;
        },
        this.o.lockOptions,
      );

      const answer = await this.bindOnServer(account, network, credentialId, bearer);

      const outcome = await withLock(
        profile,
        async (lock) => {
          const now = await this.account();
          // Signed out during the network phase (the sign-out deletes the key): record nothing and
          // make no key; the next paid call starts from a clean state.
          if (now === null) return "signed-out" as const;
          if (now.address !== account.address) return "changed" as const;
          this.recordBinding(lock, credentialId, account.address, network.id);
          return "recorded" as const;
        },
        this.o.lockOptions,
      );
      if (outcome === "signed-out") throw new SetupError(SIGNED_OUT_DURING_BIND);
      if (outcome === "recorded") {
        this.log.info(answer.status === "ACTIVE" ? "payment key bound" : "payment key waits for approval", { credential: credentialId.slice(0, 8) });
        return { ...answer, address: account.address };
      }
      this.log.warn("payment key changed during the binding; binding again");
    }
    throw new SetupError("Paid calls could not be set up: the payment key changed in another window while it was being bound. Try again.");
  }

  /** The challenge, its field-by-field check, the signature and the bind request (no lock held). */
  private async bindOnServer(account: PrivateKeyAccount, network: BuiltInNetwork, credentialId: string, bearer: string): Promise<BindResult> {
    try {
      return await bindDelegateKey({
        account,
        api: (method, path, body) => this.api(method, path, body, bearer),
        environment: this.o.deployment.environment,
        network: network.id,
        credentialId,
        now: this.now,
        log: this.log,
      });
    } catch (err) {
      if (err instanceof BindError) throw new SetupError(err.message);
      throw err;
    }
  }

  private recordBinding(lock: LockHandle, credentialId: string, address: string, network: string): void {
    const { profile, deployment } = this.o;
    const current = readProfileFor(profile, deployment.environment);
    if (current === null) {
      createProfile(profile, lock, { environment: deployment.environment, credentialId, agentLabel: "agent", createdAt: new Date(this.now()).toISOString(), delegateAddress: address, network });
    } else {
      updateProfile(profile, lock, (c) => ({ ...c, credentialId, delegateAddress: address, network, ...(c.delegateAddress !== address ? { payer: null } : {}) }));
    }
  }

  /** The profile's credential id, or the one the API names for this bearer. */
  private async credentialId(): Promise<string | null> {
    const record = readProfileFor(this.o.profile, this.o.deployment.environment);
    if (record !== null && UUID_RE.test(record.credentialId)) return record.credentialId.toLowerCase();
    const bearer = await this.host.bearer();
    if (bearer === null) return null;
    return identifyCredential(this.o.deployment, bearer, this.o.log ?? silentLogger);
  }

  /** The delegate key from the keychain, as a signer; `null` when there is none. */
  private async account(): Promise<PrivateKeyAccount | null> {
    const pk = await this.o.keychain.get("delegate_key");
    if (pk === null) return null;
    if (!PRIVATE_KEY_RE.test(pk)) throw new SetupError("The payment key stored on this computer is unreadable.");
    return privateKeyToAccount(pk as Hex);
  }

  private async localKey(): Promise<{ address: string } | null> {
    const account = await this.account();
    return account === null ? null : { address: account.address };
  }

  /** One API request with the bearer; the parsed body and the `Date` header, or `null` on any failure. */
  private async api(method: "GET" | "POST", path: string, body?: unknown, given?: string): Promise<{ body: unknown; date: string | null } | null> {
    // Never called with the profile lock held: `bearer()` may refresh, which takes that lock.
    const bearer = given ?? (await this.host.bearer());
    if (bearer === null) return null;
    return apiRequest(this.o.fetch, this.o.deployment.api, bearer, method, path, body, this.log);
  }

  // ---- after the link (F4 step 6) -------------------------------------------------------------

  /**
   * The wait for the person's approval (`enable-poll.ts`): fresh chain reads, then one
   * `GET {API}/agents/me/delegate`; logs "Paid calls are on". One wait per process. The server's
   * answer is for display only: the guards still read the chain. A wait for another network, payer
   * or key (another account signed in) replaces the running one.
   */
  private startPoll(network: BuiltInNetwork, payer: string, address: string): void {
    const p = this.poll;
    if (p !== null && p.network === network.id && p.payer === getAddress(payer) && p.address === getAddress(address)) return;
    p?.stop();
    const handle = startEnablePoll({
      network: network.id,
      payer,
      address,
      chain: this.o.chain,
      get: (path) => this.apiGet(path),
      signedIn: async () => (await this.host.bearer()) !== null,
      now: this.now,
      log: this.log,
      // Shown at the default level (review M4): the one line the user waits for.
      onActive: () => this.log.warn("Paid calls are on"),
      onEnd: () => {
        if (this.poll?.stop === handle.stop) this.poll = null;
      },
      ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
      ...(this.o.pollMaxMs !== undefined ? { pollMaxMs: this.o.pollMaxMs } : {}),
    });
    this.poll = { stop: handle.stop, network: network.id, payer: getAddress(payer), address: getAddress(address) };
  }

  /** A GET with the bearer; `"not-found"` on a 404 (a route an older backend lacks). */
  private async apiGet(path: string): Promise<{ body: unknown } | "not-found" | null> {
    const bearer = await this.host.bearer();
    if (bearer === null) return null;
    return apiGet(this.o.fetch, this.o.deployment.api, bearer, path, this.log);
  }

  /** Stops the enable-paid wait (process end, sign-out, another credential). */
  stop(): void {
    this.poll?.stop();
  }
}
