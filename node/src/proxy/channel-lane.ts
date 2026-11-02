import { randomBytes } from "node:crypto";
import {
  advanceLane,
  buildChannelVoucher,
  CHANNEL_CODES,
  CHANNEL_SCHEME,
  channelKey,
  checkChannelOffer,
  emptyBook,
  finishLane,
  laneCoversChain,
  laneOutcomeOf,
  pickLane,
  recordCheck,
  unpackChannelState,
  type ChannelBook,
  type ChannelNetwork,
  type ChannelVoucherTypedData,
  type Eip155NetworkEntry,
  type LaneOutcome,
  type LanePool,
  type WireChannelVoucher,
} from "@goassay-ai/sdk/core";
import { getAddress, type Hex } from "viem";
import type { ChainReader } from "../chain/reads.js";
import { parseCaip10 } from "../deployments.js";
import { withLock, type LockHandle, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { readState, updateState } from "../profile/profile.js";

/**
 * Channel vouchers (`channel-v1`) in the proxy: the lane record lives in `state.json`, under the
 * profile lock, so every host on this computer shares one record and two hosts never sign
 * conflicting totals. The lane rules, the offer check and the EIP-712 types are the SDK's
 * (`@goassay-ai/sdk/core`); this module only keeps them in the profile.
 *
 * - The next pair comes from the lane's own record only (never from the server); it is written
 *   to `state.json`, with the spend record of its increase, before the voucher is signed.
 * - A lane not checked in the last 600 s is checked against the escrow (`channelBooks`) first,
 *   outside the lock; a record that does not cover what the chain shows is retired.
 * - At most one voucher per host call still holds: a channel refusal is answered with a text and
 *   the next call opens or re-arms a lane; nothing is signed twice for one call.
 */

/** `assay/paymentSchemes` offered when a built-in network of the environment has the channel door. */
export function offeredSchemes(networks: ReadonlyMap<string, Eip155NetworkEntry>): string[] | null {
  return [...networks.values()].some((n) => n.channels === true) ? [CHANNEL_SCHEME, "voucher"] : null;
}

/** The SDK's channel network view of a built-in entry. */
export function channelNetworkOf(entry: Eip155NetworkEntry): ChannelNetwork {
  return { id: entry.id, chainId: entry.chainId, escrow: getAddress(entry.escrow), asset: entry.asset, decimals: entry.decimals };
}

export function poolOf(net: ChannelNetwork, requirement: Readonly<Record<string, unknown>>, signer: string): LanePool | null {
  const payer = typeof requirement.payer === "string" ? parseCaip10(requirement.payer) : null;
  const provider = typeof requirement.provider === "string" ? parseCaip10(requirement.provider) : null;
  if (!payer || !provider || payer.chainId !== net.chainId || provider.chainId !== net.chainId) return null;
  return { network: net.id, escrow: net.escrow, payer: getAddress(payer.address), signer: getAddress(signer), provider: getAddress(provider.address) };
}

const newChannelId = (): Hex => `0x${randomBytes(32).toString("hex")}`;

export interface LaneLimits {
  price: bigint;
  maxLanes: number;
  rotateAt: bigint;
}

/**
 * Before the paid lock: a lane that needs a chain check gets one, outside the lock, and the result
 * is recorded under a short hold (only when the lane is still as it was read). Best effort: any
 * failure leaves the lane unchecked, and the call is then paid per call.
 */
export async function checkLanes(
  profile: ProfileRef,
  chain: ChainReader,
  pool: LanePool,
  limits: LaneLimits,
  now: () => number,
  lockOptions?: LockOptions,
): Promise<void> {
  if (chain.readChannel === undefined) return;
  for (let round = 0; round < limits.maxLanes; round++) {
    const nowSeconds = Math.floor(now() / 1000);
    const pick = pickLane(readState(profile).channels ?? emptyBook(), pool, limits.price, { ...limits, nowSeconds, newChannelId });
    if (pick.kind !== "lane" || !pick.needsCheck) return;
    const lane = pick.lane;
    const read = await chain.readChannel(lane.network, channelKey(lane.payer, lane.signer, lane.provider, lane.channelId), lane.payer);
    if (!read.ok) return;
    const covered = laneCoversChain(lane, unpackChannelState(read.state));
    await withLock(
      profile,
      async (lock) => {
        updateState(profile, lock, (state) => {
          const book = state.channels ?? emptyBook();
          const current = book.lanes.find((l) => l.channelId === lane.channelId);
          const same = current && !current.retired && current.inFlightSince === null && current.maxSigned === lane.maxSigned && current.callsSigned === lane.callsSigned;
          return same ? { ...state, channels: recordCheck(book, lane.channelId, covered, nowSeconds) } : state;
        });
      },
      lockOptions,
    );
  }
}

/** One channel voucher, planned under the lock. `book` is written before it is signed. */
export interface LanePlan {
  book: ChannelBook;
  channelId: Hex;
  cumulative: bigint;
  calls: number;
  increase: bigint;
  wire: WireChannelVoucher;
  typedData: ChannelVoucherTypedData;
}

/**
 * The next pair on a free, checked lane (or a new lane), from the record in `state.json` read under
 * `lock`. Nothing is written here; `null` when no lane can take the call now (pay per call).
 */
export function planLane(profile: ProfileRef, lock: LockHandle, net: ChannelNetwork, pool: LanePool, limits: LaneLimits, issuedAt: number, lifetimeSeconds: number, nowSeconds: number): LanePlan | null {
  lock.assertHeld();
  const pick = pickLane(readState(profile).channels ?? emptyBook(), pool, limits.price, { ...limits, nowSeconds, newChannelId });
  if (pick.kind !== "lane" || pick.needsCheck) return null;
  const step = advanceLane(pick.book, pick.lane.channelId, limits.price, issuedAt, lifetimeSeconds, nowSeconds);
  const built = buildChannelVoucher(pick.lane, step, net);
  return { book: step.book, channelId: step.channelId, cumulative: step.cumulative, calls: step.calls, increase: step.increase, ...built };
}

/** Writes the planned lane (write-ahead): call under the same lock, before signing. */
export function writePlan(profile: ProfileRef, lock: LockHandle, plan: LanePlan): void {
  updateState(profile, lock, (state) => ({ ...state, channels: plan.book }));
}

/** The code for a channel voucher that got no usable answer: its outcome is `unknown`. */
export const NO_ANSWER = "NO_ANSWER";

/** The server's code for an answer to a channel voucher: `null` when it was served. */
export function answerCode(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return NO_ANSWER;
  const meta = (result as Record<string, unknown>)._meta;
  const error = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>)["assay/error"] : undefined;
  if (typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).code === "string") {
    return (error as Record<string, unknown>).code as string;
  }
  return null;
}

/** Frees, re-arms or retires the lane in `state.json`. */
export async function finishPlannedLane(profile: ProfileRef, channelId: string, outcome: LaneOutcome, lockOptions?: LockOptions): Promise<void> {
  await withLock(
    profile,
    async (lock) => {
      updateState(profile, lock, (state) => (state.channels ? { ...state, channels: finishLane(state.channels, channelId, outcome) } : state));
    },
    lockOptions,
  );
}

export { checkChannelOffer, laneOutcomeOf };

/** `PAYMENT_UNSETTLED_LIMIT`, as the agent reads it. `retryAfter` is in seconds. */
export function unsettledText(retryAfter: unknown): string {
  const seconds = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Waiting for earlier payments to settle on chain; retry in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}. Nothing was charged.`;
}

/** A channel refusal the next call recovers from by itself (a new or re-armed lane). */
export const CHANNEL_RETRY_TEXT = "Assay could not take this payment on its payment channel. Ask again to pay. Nothing was charged.";

/** The codes answered with {@link CHANNEL_RETRY_TEXT}. */
export const CHANNEL_RETRY_CODES: ReadonlySet<string> = new Set([
  CHANNEL_CODES.CHANNEL_ROTATE,
  CHANNEL_CODES.CHANNEL_LIMIT,
  CHANNEL_CODES.CHANNEL_SIGNER_EXPIRING,
  CHANNEL_CODES.CHANNEL_NOT_OFFERED,
]);
