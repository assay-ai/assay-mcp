import { randomUUID } from "node:crypto";
import { getAddress, isAddress } from "viem";
import { shellQuote } from "../clients/install-command.js";
import { VERSION } from "../version.js";

/**
 * `_meta` handling on `tools/call` (spec §7.7), as pure functions. The key names follow the R1
 * rename: everything is `assay/*` except `x402/paymentRequired`, which is unchanged.
 *
 * Nothing here trusts a string from the server for what the user is shown about a payment: the
 * texts take values the proxy built or checked itself.
 */

export const PAYMENT_REQUIRED_META = "x402/paymentRequired";
export const VOUCHER_META = "assay/voucher";
export const RAIL_META = "assay/rail";
export const IDEMPOTENCY_META = "assay/idempotency-key";
export const ERROR_META = "assay/error";
export const PRICE_META = "assay/price";
/** Added by the proxy to a refusal: `{guard, reason}`. */
export const REFUSED_META = "assay-mcp/refused";

export const PAYMENT_REQUIRED_CODE = "PAYMENT_REQUIRED";
export const DEBT_CODE = "PAYMENT_DEBT_OUTSTANDING";
/** The server refused a voucher because the delegate's grant is revoked or expired. */
export const DELEGATE_INACTIVE_CODE = "PAYMENT_VOUCHER_DELEGATE_INACTIVE";

/** The meta tools of a SEARCH-mode URL. */
export const GET_TOOL = "get_tool";
export const SEARCH_TOOLS = "search_tools";
export const CALL_TOOL = "call_tool";

/** The idempotency key the server accepts: 1–128 printable ASCII characters (backend `parseIdempotencyKey`). */
const IDEMPOTENCY_RE = /^[\x20-\x7e]{1,128}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * §7.7 step 1: the params the proxy forwards for a host `tools/call`. A host-supplied
 * `assay/voucher` and `assay/rail` are removed (only the proxy signs); `assay/idempotency-key`
 * is kept when the host sent one, else a UUIDv4 is added. Other keys are kept. Returns a new
 * object; the input is not changed.
 */
export function prepareCallParams(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const meta: Record<string, unknown> = isObject(params._meta) ? { ...params._meta } : {};
  delete meta[VOUCHER_META];
  delete meta[RAIL_META];
  // A host key the server would refuse is replaced (review M3), so the call is not refused for it.
  if (idempotencyKeyOf(meta) === null) meta[IDEMPOTENCY_META] = randomUUID();
  return { ...params, _meta: meta };
}

/** A host's `assay/idempotency-key` when it is one the server accepts, else `null`. */
function idempotencyKeyOf(meta: Readonly<Record<string, unknown>>): string | null {
  const key = meta[IDEMPOTENCY_META];
  return typeof key === "string" && IDEMPOTENCY_RE.test(key) ? key : null;
}

/** The voucher the proxy sends in `_meta["assay/voucher"]` on the paid retry. */
export interface VoucherEnvelope {
  voucher: unknown;
  signature: string;
  providerId: string;
  contractVersion?: number;
}

const MAX_PROVIDER_ID_LENGTH = 256;

/** The requirement's `providerId` when it is usable (1–256 characters), else `null`. */
export function providerIdOf(requirement: Readonly<Record<string, unknown>>): string | null {
  const id = requirement.providerId;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_PROVIDER_ID_LENGTH ? id : null;
}

/** The `assay/voucher` envelope; `contractVersion` only when it is a positive safe integer. */
export function voucherEnvelope(voucher: unknown, signature: string, providerId: string, contractVersion: unknown): VoucherEnvelope {
  return {
    voucher,
    signature,
    providerId,
    ...(typeof contractVersion === "number" && Number.isSafeInteger(contractVersion) && contractVersion >= 1 ? { contractVersion } : {}),
  };
}

/** The same params with the voucher added (and nothing else changed, the idempotency key included). */
export function withVoucher(params: Readonly<Record<string, unknown>>, envelope: VoucherEnvelope): Record<string, unknown> {
  const meta: Record<string, unknown> = isObject(params._meta) ? { ...params._meta } : {};
  meta[VOUCHER_META] = envelope;
  return { ...params, _meta: meta };
}

/** What a `tools/call` result says about payment. */
export type PaymentState =
  | { kind: "none" }
  | { kind: "debt" }
  | { kind: "payment-required"; requirement: unknown }
  | { kind: "error"; code: string };

/** Sorts a `tools/call` result by its `_meta` (§7.7 steps 2, 3 and 4–7). */
export function paymentState(result: unknown): PaymentState {
  if (!isObject(result) || !isObject(result._meta)) return { kind: "none" };
  const meta = result._meta;
  const error = isObject(meta[ERROR_META]) ? meta[ERROR_META] : null;
  const code = error && typeof error.code === "string" ? error.code : null;
  if (code === DEBT_CODE) return { kind: "debt" };
  if (Object.hasOwn(meta, PAYMENT_REQUIRED_META) && meta[PAYMENT_REQUIRED_META] !== undefined && meta[PAYMENT_REQUIRED_META] !== null) {
    if (code === null || code === PAYMENT_REQUIRED_CODE) return { kind: "payment-required", requirement: meta[PAYMENT_REQUIRED_META] };
  }
  return code !== null ? { kind: "error", code } : { kind: "none" };
}

// ---- texts ------------------------------------------------------------------------------

/** §7.7 step 3 (R-PAY-5). */
export function debtSuffix(web: string): string {
  return ` Settle it at ${web.replace(/\/+$/, "")}/funding`;
}

/** The result with `suffix` appended to its first text block (a text block is added when there is none). */
export function appendText(result: Record<string, unknown>, suffix: string): Record<string, unknown> {
  const content = Array.isArray(result.content) ? [...(result.content as unknown[])] : [];
  const i = content.findIndex((c) => isObject(c) && c.type === "text" && typeof c.text === "string");
  if (i === -1) content.push({ type: "text", text: suffix.trimStart() });
  else {
    const block = content[i] as Record<string, unknown>;
    content[i] = { ...block, text: `${block.text as string}${suffix}` };
  }
  return { ...result, content };
}

/** §7.7 step 5. */
export function notAllowedText(url: string): string {
  return `Paid calls through this server are off. To allow them, run in a terminal: npx -y @assay-ai/mcp@${VERSION} allow-paid ${shellQuote(url)}`;
}

/** The payment key as people compare it: its last 8 hex digits, upper case, in two groups (`1A2B 9F3C`). */
export function fingerprint(address: string): string {
  const tail = address.slice(-8).toUpperCase();
  return `${tail.slice(0, 4)} ${tail.slice(4)}`;
}

/**
 * `{WEB}/agents/enable-paid?credential={id}#key={address}` (§7.7 step 6, R-MCP-18): only from the
 * built-in web origin, a UUID-checked credential id and a checked address; `null` otherwise.
 */
export function enablePaidLink(web: string, credentialId: string, address: string): string | null {
  let base: URL;
  try {
    base = new URL(web);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) return null;
  if (!UUID_RE.test(credentialId)) return null;
  if (!isAddress(address, { strict: false })) return null;
  return `${base.origin}/agents/enable-paid?credential=${credentialId}#key=${getAddress(address)}`;
}

/** §7.7 step 6. */
export function notEnabledText(link: string, address: string): string {
  return `This tool is paid, and paid calls are off for this agent. Open ${link} to turn them on (about a minute), then ask again. The page must show this payment key: ${fingerprint(address)}.`;
}

/** §7.7 step 7, on a guard refusal. */
export function refusedText(reason: string): string {
  return `Assay asked for a payment this app refused: ${reason}.`;
}

/** A tool error result with the original `_meta` (plus `extra`). */
export function errorResult(text: string, original: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const meta = isObject(original) && isObject(original._meta) ? original._meta : {};
  return { content: [{ type: "text", text }], isError: true, _meta: { ...meta, ...extra } };
}

// ---- quotes (G3) ------------------------------------------------------------------------

/** `assay/price` reduced to what G3 reads: `maxAmount` (atomic units) and its asset. */
export interface PriceQuote {
  maxAmount: string;
  asset: string;
}

/** A quote from an `assay/price` object, or `null` when it is not readable. */
export function quoteOf(price: unknown): PriceQuote | null {
  if (!isObject(price)) return null;
  const { maxAmount, asset } = price;
  if (typeof maxAmount !== "string" || !UINT_RE.test(maxAmount) || maxAmount.length > 30) return null;
  if (typeof asset !== "string" || asset.length === 0 || asset.length > 200) return null;
  return { maxAmount, asset };
}

/** `[name, quote]` pairs from a remote `tools/list` result (`tools[]._meta["assay/price"]`). */
export function quotesFromList(result: unknown): [string, PriceQuote][] {
  if (!isObject(result) || !Array.isArray(result.tools)) return [];
  const out: [string, PriceQuote][] = [];
  for (const tool of result.tools as unknown[]) {
    if (!isObject(tool) || typeof tool.name !== "string" || !TOOL_NAME_RE.test(tool.name)) continue;
    const quote = isObject(tool._meta) ? quoteOf(tool._meta[PRICE_META]) : null;
    if (quote) out.push([tool.name, quote]);
  }
  return out;
}

/** The structured output of a meta tool result (`structuredContent`, else the JSON text block). */
function structured(result: unknown): Record<string, unknown> | null {
  if (!isObject(result) || result.isError === true) return null;
  if (isObject(result.structuredContent)) return result.structuredContent;
  const first = Array.isArray(result.content) ? (result.content as unknown[])[0] : undefined;
  if (isObject(first) && first.type === "text" && typeof first.text === "string" && first.text.length <= 1_000_000) {
    try {
      const parsed: unknown = JSON.parse(first.text);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** `[name, quote]` pairs from a `search_tools` result (`results[].{name, assayPrice}`). */
export function quotesFromSearch(result: unknown): [string, PriceQuote][] {
  const out = structured(result);
  if (!out || !Array.isArray(out.results)) return [];
  const pairs: [string, PriceQuote][] = [];
  for (const r of out.results as unknown[]) {
    if (!isObject(r) || typeof r.name !== "string" || !TOOL_NAME_RE.test(r.name)) continue;
    const quote = quoteOf(r.assayPrice);
    if (quote) pairs.push([r.name, quote]);
  }
  return pairs;
}

/** The `[name, quote]` of a `get_tool` result (`{name, price}`), when readable. */
export function quoteFromGetTool(result: unknown): [string, PriceQuote] | null {
  const out = structured(result);
  if (!out || typeof out.name !== "string" || !TOOL_NAME_RE.test(out.name)) return null;
  const quote = quoteOf(out.price);
  return quote ? [out.name, quote] : null;
}

/**
 * The tool a `tools/call` pays for: the call's own name, or on `call_tool` the inner
 * `arguments.name` (Task 2.8 note M11). `null` when the inner name is not readable.
 */
export function paidToolOf(tool: string, params: Readonly<Record<string, unknown>>): string | null {
  if (tool !== CALL_TOOL) return tool;
  const args = params.arguments;
  return isObject(args) && typeof args.name === "string" && TOOL_NAME_RE.test(args.name) ? args.name : null;
}
