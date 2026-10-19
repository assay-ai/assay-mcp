import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getAddress, type Hex } from "viem";
import { toGuardChain, type ChainReader, type ChainState } from "../chain/reads.js";
import { builtInDeployments, parseCaip10 } from "../deployments.js";
import { builtInNetwork, confirmationFor } from "../guards/guards.js";
import type { QuoteCache } from "../guards/quote-cache.js";
import { guardAndBuild } from "../guards/sign.js";
import { recordHeld, SpendLimitError } from "../guards/spend-record.js";
import type { BuiltInNetwork, Confirmation, GuardContext, GuardId, Quote } from "../guards/types.js";
import { silentLogger, type Logger } from "../log/logger.js";
import { identifyCredential } from "../oauth/flow.js";
import { readCapped, requestSignal } from "../oauth/endpoints.js";
import type { ResolvedDeployment } from "../profile/deployments.js";
import type { Keychain } from "../profile/keychain.js";
import { withLock, type LockHandle, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { createProfile, paidUrlKey, readLimits, readPaidUrls, readProfileFor, readState, updateProfile } from "../profile/profile.js";
import { checkBindingChallenge } from "../signer/binding.js";
import { dateHeaderOffset, issuedAt } from "../signer/clock.js";
import { SignerRefusal } from "../signer/errors.js";
import { generate } from "../signer/keygen.js";
import { openThroughGate } from "./browser-gate.js";
import { CONFIRMATION_TTL_MS, type CallRegistry, type ForwardedCall } from "./calls.js";
import type { FetchLike } from "./forwarder.js";
import {
  appendText,
  debtSuffix,
  DELEGATE_INACTIVE_CODE,
  enablePaidLink,
  errorResult,
  GET_TOOL,
  notAllowedText,
  notEnabledText,
  paidToolOf,
  paymentState,
  quoteFromGetTool,
  quotesFromSearch,
  refusedText,
  REFUSED_META,
  SEARCH_TOOLS,
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
 * - `PAYMENT_DEBT_OUTSTANDING`: the answer, with " Settle it at {WEB}/funding";
 * - `PAYMENT_REQUIRED` with `--no-paid`: the answer unchanged;
 * - this URL not in `paid-urls.json`: the allow-paid text;
 * - no payment key bound here, or no active grant on chain for it: under the profile lock, a key
 *   is generated if there is none and bound (F4 steps 2–3, every challenge field checked); the
 *   enable-paid text with the link and the fingerprint; the browser through the 10-minute gate;
 *   and a poll of `GET {API}/agents/me/delegate` that ends with a chain read;
 * - enabled: the guards on one frozen copy of the requirement, the G7 confirmation (MCP form
 *   elicitation, bound to this payment and to a single-use token) when the amount is above
 *   `confirmAbove`, then, in one hold of the profile lock, the spend record and the signature;
 *   the call is sent again with the same params, the same idempotency key and
 *   `_meta["assay/voucher"]`, and that answer goes to the host unchanged.
 *
 * At most one voucher per host call (`ForwardedCall.claimVoucher`). Nothing here calls
 * `/escrow/debts/*` or `/escrow/next-seq`. No key, signature or token reaches a log line.
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
  /** The enable-paid poll: every 5 s, for up to 15 minutes. */
  readonly pollMs?: number;
  readonly pollMaxMs?: number;
}

export const POLL_MS = 5_000;
export const POLL_MAX_MS = 15 * 60_000;
const API_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_ID_LENGTH = 256;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
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

export class PaidPath {
  private readonly log: Logger;
  private readonly now: () => number;
  private poll: { stop: () => void } | null = null;

  constructor(
    private readonly o: PaidOptions,
    private readonly host: PaidHost,
  ) {
    this.log = (o.log ?? silentLogger).child("paid");
    this.now = o.now ?? Date.now;
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
    const state = paymentState(result);
    if (state.kind === "debt") return { ...response, result: appendText(result, debtSuffix(this.o.deployment.web)) };
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
    if (!readPaidUrls(profile).includes(urlKey)) return { ...response, result: errorResult(notAllowedText(deployment.url), result) };

    // One frozen copy of the requirement: every decision below reads this, and so does the signer.
    let requirement: Record<string, unknown>;
    try {
      const copy: unknown = deepFreeze(structuredClone(raw));
      if (!isObject(copy)) throw new TypeError("not an object");
      requirement = copy;
    } catch {
      return this.refused(response, result, new Refusal("G1", "the payment request is not a requirement"));
    }
    const network = typeof requirement.network === "string" ? builtInNetwork(builtInDeployments()[deployment.environment], requirement.network) : null;
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
    return this.guardSignRetry(call, response, result, requirement, network, tool, local.address, chain, quote, urlKey, payer);
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
  ): Promise<JsonRpcResponse> {
    const { deployment, profile } = this.o;
    const env = deployment.environment;
    const forwardedCall = { tool, at: Math.floor(call.startedAt / 1000) };
    let confirmation: Confirmation | null = null;

    for (let pass = 0; pass < 2; pass++) {
      type Step =
        | { kind: "refused"; guard: GuardId; code: string; reason: string }
        | { kind: "again" }
        | { kind: "signed"; envelope: VoucherEnvelope };
      const step = await withLock(
        profile,
        async (lock): Promise<Step> => {
          // Everything the guards read is read under the lock (G7 `signed`, the terminal files).
          const nowSeconds = Math.floor(this.now() / 1000);
          const limits = readLimits(profile);
          const record = readProfileFor(profile, env);
          const ctx: Omit<GuardContext, "network"> = {
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
          const built = guardAndBuild(ctx, issuedAt(nowSeconds, this.host.dateOffset()), env);
          if (!built.ok) return { kind: "refused", guard: built.guard, code: built.code, reason: built.reason };

          // The key that signs is re-read under the lock and must be the key the guards checked.
          const account = await this.account();
          if (account === null || account.address !== getAddress(localAddress)) {
            return { kind: "refused", guard: "G5", code: "G5_DELEGATE_MISMATCH", reason: "the payment key changed while the payment was checked" };
          }
          const providerId = requirement.providerId;
          if (typeof providerId !== "string" || providerId.length === 0 || providerId.length > MAX_PROVIDER_ID_LENGTH) {
            return { kind: "refused", guard: "G1", code: "G1_NOT_A_REQUIREMENT", reason: "the payment request names no provider" };
          }
          if (!call.claimVoucher()) return { kind: "again" };
          try {
            recordHeld(profile, lock, built.typedData.message.amount, { limits, decimals: network.decimals, now: this.now });
          } catch (err) {
            if (err instanceof SpendLimitError) return { kind: "refused", guard: "G7", code: "G7_PER_DAY", reason: "the daily limit set for this computer would be passed" };
            throw err;
          }
          if (record !== null && record.payer === null && payer !== null) {
            // G4: the payer is recorded once the chain confirmed its grant to this key.
            updateProfile(profile, lock, (current) => ({ ...current, payer, network: network.id }));
          }
          lock.assertHeld();
          const signature = await account.signTypedData(built.typedData);
          const contractVersion = requirement.contractVersion;
          return {
            kind: "signed",
            envelope: {
              voucher: built.wire,
              signature,
              providerId,
              ...(typeof contractVersion === "number" && Number.isSafeInteger(contractVersion) && contractVersion >= 1 ? { contractVersion } : {}),
            },
          };
        },
        this.o.lockOptions,
      );

      if (step.kind === "again") return response; // R-MCP-9: a second PAYMENT_REQUIRED goes back unsigned
      if (step.kind === "signed") {
        this.log.info("voucher signed", { tool, amount: (requirement.amount as { amount: string }).amount });
        const answer = await this.host.resend(call, withVoucher(call.params, step.envelope));
        const after = "result" in answer ? paymentState(answer.result) : { kind: "none" as const };
        if (after.kind === "error" && after.code === DELEGATE_INACTIVE_CODE && payer !== null) {
          this.o.chain.invalidate(payer, localAddress, network.id);
        }
        return answer;
      }
      if (step.code === "G7_CONFIRMATION_REQUIRED" && pass === 0) {
        const asked = await this.confirm(call, requirement, forwardedCall, network);
        if (asked instanceof Refusal) return this.refused(response, result, asked);
        confirmation = asked;
        continue;
      }
      if ((step.guard === "G4" || step.guard === "G6") && payer !== null) this.o.chain.invalidate(payer, localAddress, network.id);
      return this.refused(response, result, new Refusal(step.guard, step.reason));
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
    if (!accepted) return new Refusal("G7", "you did not confirm the payment", "The payment was cancelled. Nothing was paid.");
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
    if (credentialId === null) throw new SetupError("Paid calls could not be set up yet: this app's Assay sign-in is not confirmed. Try again in a minute.");
    const address = bind ? await this.bindUnderLock(network, credentialId) : (await this.localKey())?.address ?? null;
    if (address === null) throw new SetupError("Paid calls could not be set up: the payment key could not be read. Try again.");

    // F5 step 3: an existing key bound to a new credential keeps its on-chain grant, so the call
    // is asked again (unsigned) for a requirement that names the bound key.
    if (bind && !reasked && payer !== null) {
      const chain = toGuardChain(await this.o.chain.readDelegation(network.id, payer, address), address);
      const live = chain !== null && chain.active && BigInt(chain.validUntil) > BigInt(Math.floor(this.now() / 1000));
      if (!live) this.o.chain.invalidate(payer, address, network.id);
      if (live) {
        const again = await this.host.resend(call, call.params);
        if (!("result" in again)) return again;
        const state = paymentState(again.result);
        if (state.kind !== "payment-required") return this.onPlainAnswer(again);
        return this.pay(call, again, again.result, state.requirement, true);
      }
    }

    const link = enablePaidLink(this.o.deployment.web, credentialId, address);
    if (link === null) throw new SetupError("Paid calls cannot be turned on from this app for this Assay deployment.");
    const opened = await openThroughGate(this.o.profile, link, this.o.openBrowser, { ...this.o.lockOptions, now: this.now });
    if (!opened) this.o.stderr(`assay-mcp: to turn on paid calls, open ${link}\n`);
    if (payer !== null) this.startPoll(network, payer, address);
    return { ...response, result: errorResult(notEnabledText(link, address), result) };
  }

  private onPlainAnswer(answer: JsonRpcResponse): JsonRpcResponse {
    if (!("result" in answer)) return answer;
    return paymentState(answer.result).kind === "debt" ? { ...answer, result: appendText(answer.result, debtSuffix(this.o.deployment.web)) } : answer;
  }

  /**
   * F4 steps 2–3 under the profile lock: re-read the keychain, generate and store a key if there
   * is none, then bind it (challenge, field-by-field check, signature). The clock is corrected
   * from the challenge answer's `Date` header (clamped to ±120 s); a challenge refused on its
   * expiry is retried once with a fresh one. Returns the bound address.
   */
  private async bindUnderLock(network: BuiltInNetwork, credentialId: string): Promise<string> {
    const { profile, keychain, deployment } = this.o;
    return withLock(
      profile,
      async (lock) => {
        let account = await this.account();
        if (account === null) {
          const key = generate();
          await keychain.set(lock, "delegate_key", key.privateKey);
          account = await this.account();
          if (account === null || account.address !== key.address) throw new SetupError("Paid calls could not be set up: the payment key could not be stored. Try again.");
          this.log.info("payment key created");
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          lock.assertHeld();
          const challenge = await this.api("POST", "/agents/me/delegate/challenge", { delegate: account.address });
          if (challenge === null) throw new SetupError("Paid calls could not be set up: Assay did not answer. Try again.");
          const local = this.now() / 1000;
          const nowSeconds = issuedAt(local, dateHeaderOffset(challenge.date, local));
          const data = isObject(challenge.body) ? challenge.body.data : undefined;
          let typedData;
          try {
            typedData = checkBindingChallenge(data, { localAddress: account.address, credentialId, environment: deployment.environment, network: network.id, nowSeconds });
          } catch (err) {
            if (err instanceof SignerRefusal && err.field === "message.expiresAt") {
              // Clock: retried once with a fresh challenge, then refused (no widening of the window).
              if (attempt === 0) continue;
              throw new SetupError("Paid calls could not be set up: this computer's clock is too far from Assay's. Check the clock, then try again.");
            }
            this.log.warn("binding challenge refused", { field: err instanceof SignerRefusal ? err.field : "unknown" });
            throw new SetupError("Paid calls could not be set up: Assay's key check did not match. Nothing was signed.");
          }
          const challengeId = isObject(data) ? data.challengeId : undefined;
          if (typeof challengeId !== "string" || !UUID_RE.test(challengeId)) throw new SetupError("Paid calls could not be set up: Assay's key check did not match. Nothing was signed.");
          const signature = await account.signTypedData(typedData);
          lock.assertHeld();
          const bound = await this.api("POST", "/agents/me/delegate", { challengeId, signature });
          const boundData = bound !== null && isObject(bound.body) ? bound.body.data : undefined;
          const chainId = Number(network.id.slice("eip155:".length));
          if (!isObject(boundData) || accountOn(boundData.delegate, chainId) !== account.address) {
            throw new SetupError("Paid calls could not be set up: Assay did not accept the payment key. Try again.");
          }
          this.recordBinding(lock, credentialId, account.address, network.id);
          this.log.info("payment key bound", { credential: credentialId.slice(0, 8) });
          return account.address;
        }
        throw new SetupError("Paid calls could not be set up: this computer's clock is too far from Assay's. Check the clock, then try again.");
      },
      this.o.lockOptions,
    );
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
  private async api(method: "GET" | "POST", path: string, body?: unknown): Promise<{ body: unknown; date: string | null } | null> {
    const bearer = await this.host.bearer();
    if (bearer === null) return null;
    try {
      const res = await this.o.fetch(`${this.o.deployment.api.replace(/\/+$/, "")}${path}`, {
        method,
        headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        bearer,
        log: this.log,
        signal: requestSignal(API_TIMEOUT_MS),
      });
      const date = res.headers.get("date");
      if (res.status < 200 || res.status > 299) {
        await res.body?.cancel().catch(() => {});
        this.log.info("API refused", { path: path.split("/").slice(0, 4).join("/"), status: res.status });
        return null;
      }
      const text = await readCapped(res);
      if (text === null) return null;
      return { body: text === "" ? null : (JSON.parse(text) as unknown), date };
    } catch {
      return null;
    }
  }

  // ---- after the link (F4 step 6) -------------------------------------------------------------

  /**
   * Polls `GET {API}/agents/me/delegate` every 5 s for up to 15 minutes; when the server says the
   * key is ACTIVE, confirms with a fresh chain read (G4) and logs "Paid calls are on". One poll
   * per process. The server's answer is for display only: the guards still read the chain.
   */
  private startPoll(network: BuiltInNetwork, payer: string, address: string): void {
    if (this.poll) return;
    const every = this.o.pollMs ?? POLL_MS;
    const until = this.now() + (this.o.pollMaxMs ?? POLL_MAX_MS);
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      if (this.now() > until) return stop();
      running = true;
      void this.pollOnce(network, payer, address)
        .then((on) => {
          if (on) {
            this.log.info("Paid calls are on");
            stop();
          }
        })
        .catch(() => {})
        .finally(() => {
          running = false;
        });
    }, every);
    timer.unref();
    const stop = () => {
      clearInterval(timer);
      this.poll = null;
    };
    this.poll = { stop };
  }

  private async pollOnce(network: BuiltInNetwork, payer: string, address: string): Promise<boolean> {
    const answer = await this.api("GET", "/agents/me/delegate");
    const data = answer && isObject(answer.body) ? answer.body.data : undefined;
    if (!isObject(data) || !isObject(data.paidCalls) || data.paidCalls.status !== "ACTIVE") return false;
    const chainId = Number(network.id.slice("eip155:".length));
    const delegate = accountOn(data.delegate, chainId);
    if (delegate !== getAddress(address)) return false;
    const chain = toGuardChain(await this.o.chain.readDelegation(network.id, payer, address, { fresh: true }), address);
    return chain !== null && chain.active && BigInt(chain.validUntil) > BigInt(Math.floor(this.now() / 1000));
  }

  /** Stops the poll (process end). */
  stop(): void {
    this.poll?.stop();
  }
}
