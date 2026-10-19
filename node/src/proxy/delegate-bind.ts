import { getAddress, type Address, type LocalAccount } from "viem";
import { parseCaip10, type Environment } from "../deployments.js";
import { silentLogger, type Logger } from "../log/logger.js";
import { readCapped, requestSignal } from "../oauth/endpoints.js";
import { checkBindingChallenge, type DelegateBindingTypedData } from "../signer/binding.js";
import { dateHeaderOffset, issuedAt } from "../signer/clock.js";
import { SignerRefusal } from "../signer/errors.js";
import type { FetchLike } from "./forwarder.js";

/**
 * F4 step 3 on the wire (spec §7.11, R-MCP-11), shared by the proxy (`paid.ts`) and the SDK:
 * the challenge, its field-by-field check (`checkBindingChallenge`), the signature by the payment
 * key, the bind request, and a check that the answer names that key. Nothing is held across it:
 * callers take no lock around this function.
 */

/** A key that signs EIP-712 data: a local key, or a KMS-backed account. Its secret never shows here. */
export interface TypedDataSigner {
  readonly address: Address;
  readonly signTypedData: LocalAccount["signTypedData"];
}

/** One API request with the bearer: the parsed body and the `Date` header, or `null` on any failure. */
export type ApiCall = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ body: unknown; date: string | null } | null>;

/** The binding could not be made. The message is the text the user sees; it carries no secret. */
export class BindError extends Error {
  override readonly name = "BindError";
}

export const BIND_TEXTS = Object.freeze({
  noAnswer: "Paid calls could not be set up: Assay did not answer. Try again.",
  clock: "Paid calls could not be set up: this computer's clock is too far from Assay's. Check the clock, then try again.",
  mismatch: "Paid calls could not be set up: Assay's key check did not match. Nothing was signed.",
  notAccepted: "Paid calls could not be set up: Assay did not accept the payment key. Try again.",
});

const API_TIMEOUT_MS = 15_000;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A checksummed bare address from a CAIP-10 account on `chainId`, or `null`. */
function accountOn(value: unknown, chainId: number): string | null {
  const parsed = typeof value === "string" ? parseCaip10(value) : null;
  return parsed && parsed.chainId === chainId ? getAddress(parsed.address) : null;
}

/**
 * `{api}{path}` through the caller's pinned fetch, with the bearer. Non-2xx, an oversized or
 * unparsable body, a timeout and a network error all give `null`. Logs the path prefix and the
 * status only.
 */
export async function apiRequest(
  fetch: FetchLike,
  apiBase: string,
  bearer: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  log: Logger = silentLogger,
): Promise<{ body: unknown; date: string | null } | null> {
  try {
    const res = await fetch(`${apiBase.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      bearer,
      log,
      signal: requestSignal(API_TIMEOUT_MS),
    });
    const date = res.headers.get("date");
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => {});
      log.info("API refused", { path: path.split("/").slice(0, 4).join("/"), status: res.status });
      return null;
    }
    const text = await readCapped(res);
    if (text === null) return null;
    return { body: text === "" ? null : (JSON.parse(text) as unknown), date };
  } catch {
    return null;
  }
}

export interface BindInputs {
  readonly account: TypedDataSigner;
  readonly api: ApiCall;
  readonly environment: Environment;
  /** CAIP-2; the chain id the challenge must name comes from the built-in table for it. */
  readonly network: string;
  readonly credentialId: string;
  /** Milliseconds clock. */
  readonly now: () => number;
  readonly log?: Logger;
}

/**
 * Binds `account` to the credential behind the bearer. The clock is corrected from the challenge
 * answer's `Date` header (clamped to ±120 s); a challenge refused on its expiry is retried once
 * with a fresh one. Nothing is signed unless every challenge field passed. Throws `BindError`.
 */
export async function bindDelegateKey(o: BindInputs): Promise<void> {
  const log = o.log ?? silentLogger;
  const chainId = Number(o.network.slice("eip155:".length));
  const address = getAddress(o.account.address);
  for (let attempt = 0; attempt < 2; attempt++) {
    const challenge = await o.api("POST", "/agents/me/delegate/challenge", { delegate: address });
    if (challenge === null) throw new BindError(BIND_TEXTS.noAnswer);
    const local = o.now() / 1000;
    const nowSeconds = issuedAt(local, dateHeaderOffset(challenge.date, local));
    const data = isObject(challenge.body) ? challenge.body.data : undefined;
    let typedData: DelegateBindingTypedData;
    try {
      typedData = checkBindingChallenge(data, { localAddress: address, credentialId: o.credentialId, environment: o.environment, network: o.network, nowSeconds });
    } catch (err) {
      if (err instanceof SignerRefusal && err.field === "message.expiresAt") {
        // Clock: retried once with a fresh challenge, then refused (no widening of the window).
        if (attempt === 0) continue;
        throw new BindError(BIND_TEXTS.clock);
      }
      log.warn("binding challenge refused", { field: err instanceof SignerRefusal ? err.field : "unknown" });
      throw new BindError(BIND_TEXTS.mismatch);
    }
    const challengeId = isObject(data) ? data.challengeId : undefined;
    if (typeof challengeId !== "string" || !UUID_RE.test(challengeId)) throw new BindError(BIND_TEXTS.mismatch);
    const signature = await o.account.signTypedData(typedData);
    const bound = await o.api("POST", "/agents/me/delegate", { challengeId, signature });
    const boundData = bound !== null && isObject(bound.body) ? bound.body.data : undefined;
    if (!isObject(boundData) || accountOn(boundData.delegate, chainId) !== address) throw new BindError(BIND_TEXTS.notAccepted);
    return;
  }
  throw new BindError(BIND_TEXTS.clock);
}
