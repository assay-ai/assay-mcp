import {
  correctedNow,
  emptyBook,
  renewChannelDebts,
  type ChannelNetwork,
  type DebtRenewal,
  type RenewAnswer,
  type RenewRunOptions,
} from "@goassay-ai/sdk/core";
import { getAddress, type PrivateKeyAccount } from "viem";
import { withLock, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { readState, updateState } from "../profile/profile.js";
import { refusalCodeOf } from "./forwarder.js";

/**
 * Channel-debt renew in the proxy (API-W2 §1.3, §3.3). A buyer debt on a payment channel can only
 * be settled by the lane's own signer, the payment key on this computer: the web portal cannot.
 * The steps are the SDK's (`renewChannelDebts` in `@goassay-ai/sdk/core`); this module only
 * gives them the lane record in `state.json` (under the profile lock, never held across the
 * network), the payment key and the API.
 *
 * - Only `CHANNEL` debts, only on the lane the debt names (`channel.channelId`) when it is this
 *   computer's lane, and only a pair its record shows signed there and served (or with no answer):
 *   never a larger pair, a pair the server refused, or another lane; at most one signature per
 *   lane per run. Per-call debts are left to the person (the portal).
 * - Not counted again as a spend: the renew re-authorises a total already signed on that lane.
 * - A debt whose lane record is gone (`state.json` deleted, another computer or profile) cannot be
 *   renewed here (`not_signed_here`); a person settles it in the app once offered there.
 * - Nothing is asked of the API unless the record holds a lane: a proxy that never paid by
 *   channel never calls `/escrow/debts`.
 */

/** One API request with the bearer: the status and the parsed body, or `null` on no answer. */
export type DebtApi = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; body: unknown } | null>;

export interface RenewInputs {
  readonly profile: ProfileRef;
  readonly lockOptions?: LockOptions;
  /** The environment's channel-capable built-in networks, by CAIP-2. */
  readonly networks: ReadonlyMap<string, ChannelNetwork>;
  readonly account: PrivateKeyAccount;
  readonly api: DebtApi;
  /** Milliseconds clock. */
  readonly now: () => number;
  /** Server clock minus local clock, seconds. */
  readonly dateOffset: () => number;
}

/** Whether `state.json` holds any channel lane (a renew can only re-sign a lane's own pair). */
export function hasLanes(profile: ProfileRef): boolean {
  try {
    return (readState(profile).channels?.lanes.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** The server's `retryAfter` (seconds) on a refusal, in ms. */
function retryAfterMsOf(body: unknown): number | undefined {
  const e = typeof body === "object" && body !== null ? (body as Record<string, unknown>).error : undefined;
  const ctx = typeof e === "object" && e !== null ? (e as Record<string, unknown>).context : undefined;
  const secs = typeof ctx === "object" && ctx !== null ? (ctx as Record<string, unknown>).retryAfter : undefined;
  return typeof secs === "number" && Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

/** Renews this computer's channel debts once; one result per debt (see the SDK's `DebtRenewal`). */
export async function renewProfileDebts(o: RenewInputs, options: RenewRunOptions = {}): Promise<DebtRenewal[]> {
  return renewChannelDebts(
    {
    listDebts: async () => {
      const answer = await o.api("GET", "/escrow/debts");
      if (answer === null || answer.status !== 200 || typeof answer.body !== "object" || answer.body === null) {
        throw new Error("the debt list could not be read");
      }
      return (answer.body as Record<string, unknown>).data;
    },
    withBook: (fn) =>
      withLock(
        o.profile,
        async (lock) => {
          const out = fn(readState(o.profile).channels ?? emptyBook());
          if (out.book !== null) {
            const book = out.book;
            updateState(o.profile, lock, (state) => ({ ...state, channels: book }));
          }
          return out.value;
        },
        o.lockOptions,
      ),
    network: (id) => o.networks.get(id) ?? null,
    signer: getAddress(o.account.address),
    sign: (typedData) => o.account.signTypedData(typedData as never),
    post: async (intentId, body): Promise<RenewAnswer> => {
      const answer = await o.api("POST", `/escrow/debts/${encodeURIComponent(intentId)}/voucher`, body);
      if (answer === null) throw new Error("no answer");
      if (answer.status >= 200 && answer.status <= 299) return { ok: true };
      const retryAfterMs = retryAfterMsOf(answer.body);
      return { ok: false, code: refusalCodeOf(answer.body), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    },
    nowSeconds: () => Math.floor(o.now() / 1000),
    issuedAt: (nowSeconds) => correctedNow(nowSeconds, o.dateOffset()),
    },
    options,
  );
}
