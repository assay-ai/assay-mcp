import { fingerprint, isObject } from "@goassay-ai/sdk/core";
import { DEFAULT_PROFILE, shellQuote } from "../clients/install-command.js";
import { VERSION } from "../version.js";

/**
 * `_meta` handling on `tools/call` (spec §7.7). The key names, the pure `_meta` helpers (params,
 * voucher envelope, payment state, quotes, links) come from the SDK's payment core; the texts the
 * user sees are the proxy's own and stay here.
 *
 * Nothing here trusts a string from the server for what the user is shown about a payment: the
 * texts take values the proxy built or checked itself.
 */

export {
  CALL_TOOL,
  DEBT_CODE,
  DELEGATE_INACTIVE_CODE,
  ERROR_META,
  GET_TOOL,
  IDEMPOTENCY_META,
  PAYMENT_REQUIRED_CODE,
  PAYMENT_REQUIRED_META,
  PRICE_META,
  RAIL_META,
  SEARCH_TOOLS,
  VOUCHER_META,
  enablePaidLink,
  fingerprint,
  paidToolOf,
  paymentState,
  prepareCallParams,
  providerIdOf,
  quoteFromGetTool,
  quoteOf,
  quotesFromList,
  quotesFromSearch,
  serverApprovalLink,
  voucherEnvelope,
  withVoucher,
  type PaymentState,
  type PriceQuote,
  type VoucherEnvelope,
} from "@goassay-ai/sdk/core";

/** Added by the proxy to a refusal: `{guard, reason}`. */
export const REFUSED_META = "assay-mcp/refused";

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

/** §7.7 step 5. `--profile` is named when the proxy runs under another profile than the default. */
export function notAllowedText(url: string, profile: string = DEFAULT_PROFILE): string {
  const flag = profile === DEFAULT_PROFILE ? "" : ` --profile ${shellQuote(profile)}`;
  return `Paid calls through this server are off. To allow them, run in a terminal: npx -y @goassay-ai/mcp@${VERSION} allow-paid ${shellQuote(url)}${flag}`;
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
