import { getAddress } from "viem";
import { toGuardChain, type ChainReader } from "../chain/reads.js";
import { parseCaip10 } from "../deployments.js";
import type { Logger } from "../log/logger.js";

/**
 * The wait after the enable-paid link (F4 step 6): it ends with "Paid calls are on" once the
 * payer's grant to this key is on chain and Assay says the same.
 *
 * The grant has no database record, so the backend can only answer it with chain reads of its own
 * (`GET /agents/me/delegate`). The proxy reads the chain itself instead:
 * - first tick: `GET /agents/me/delegate/status` (database only) confirms the binding; a 404 (an
 *   older backend) falls back to the full route on every tick, as before;
 * - each tick after that: a fresh chain read (`readDelegation(..., { fresh: true })`) and no
 *   backend request;
 * - once the chain shows a live grant: one `GET /agents/me/delegate`, whose `paidCalls` must say
 *   ACTIVE for this key, and whose `delegate` must be this key. A key bound while another one was
 *   (`PENDING_APPROVAL`: the old key stays `delegate`, this one `pendingDelegate`) keeps the wait
 *   going until Assay promotes it, which it does when the payer's approval lands on chain.
 * Every 5 s for the first 2 minutes, then every 15 s (each read is five requests per RPC, and the
 * listed RPCs include a public one), for up to 15 minutes in all. One wait per process.
 */

export const POLL_MS = 5_000;
export const POLL_SLOW_MS = 15_000;
export const POLL_FAST_FOR_MS = 2 * 60_000;
export const POLL_MAX_MS = 15 * 60_000;
/** A status probe that fails (not a 404) is tried again on the next ticks, this many times in all. */
const MAX_PROBES = 3;

export const DELEGATE_PATH = "/agents/me/delegate";
export const DELEGATE_STATUS_PATH = "/agents/me/delegate/status";

/** A GET with the bearer: the parsed body, `"not-found"` on a 404, or `null` on any other failure. */
export type ApiGet = (path: string) => Promise<{ body: unknown } | "not-found" | null>;

export interface EnablePollInputs {
  /** CAIP-2 network of the requirement. */
  readonly network: string;
  /** Checksummed payer. */
  readonly payer: string;
  /** This proxy's payment key (the bound delegate). */
  readonly address: string;
  readonly chain: ChainReader;
  readonly get: ApiGet;
  /** Whether this process is signed in now (a bearer exists); a tick without one reads nothing. */
  readonly signedIn: () => Promise<boolean>;
  /** Milliseconds clock. */
  readonly now: () => number;
  readonly log: Logger;
  /** Called once, when paid calls are on. */
  readonly onActive: () => void;
  /** Called once, when the wait ends either way. */
  readonly onEnd?: () => void;
  readonly pollMs?: number;
  readonly pollSlowMs?: number;
  readonly pollFastForMs?: number;
  readonly pollMaxMs?: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `data` of the envelope, or `undefined`. */
function dataOf(answer: { body: unknown } | "not-found" | null): unknown {
  return answer !== null && answer !== "not-found" && isObject(answer.body) ? answer.body.data : undefined;
}

export function startEnablePoll(o: EnablePollInputs): { stop: () => void } {
  const fast = o.pollMs ?? POLL_MS;
  const slow = Math.max(fast, o.pollSlowMs ?? POLL_SLOW_MS);
  const fastFor = o.pollFastForMs ?? POLL_FAST_FOR_MS;
  const started = o.now();
  const until = started + (o.pollMaxMs ?? POLL_MAX_MS);
  const chainId = Number(o.network.slice("eip155:".length));
  const local = getAddress(o.address);
  let mode: "probe" | "chain" | "legacy" = "probe";
  let probes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  /** A CAIP-10 account on this chain that is this key. */
  const namesLocal = (value: unknown): boolean => {
    const parsed = typeof value === "string" ? parseCaip10(value) : null;
    return parsed !== null && parsed.chainId === chainId && getAddress(parsed.address) === local;
  };

  /** `GET /agents/me/delegate` names this key and says its paid calls are ACTIVE. */
  const serverActive = async (): Promise<boolean> => {
    const data = dataOf(await o.get(DELEGATE_PATH));
    if (!isObject(data) || !isObject(data.paidCalls) || data.paidCalls.status !== "ACTIVE") return false;
    return namesLocal(data.delegate);
  };

  /** A fresh chain read shows a live grant to this key. An agreed read that does not is not left cached. */
  const chainLive = async (): Promise<boolean> => {
    const result = await o.chain.readDelegation(o.network, o.payer, o.address, { fresh: true });
    const chain = toGuardChain(result, o.address);
    const live = chain !== null && chain.active && BigInt(chain.validUntil) > BigInt(Math.floor(o.now() / 1000));
    // Not cached as "off": a paid call asked meanwhile reads the chain again, so an approval shows
    // at once. A failed read is never cached, so there is nothing to drop.
    if (result.ok && !live) o.chain.invalidate(o.payer, o.address, o.network);
    return live;
  };

  const once = async (): Promise<boolean> => {
    // Signed out (the proxy also stops the wait then): no RPC or API request on this tick.
    if (!(await o.signedIn()) || stopped) return false;
    if (mode === "probe") {
      probes++;
      const answer = await o.get(DELEGATE_STATUS_PATH);
      if (answer === "not-found") {
        o.log.info("delegate status route missing; polling the full route");
        mode = "legacy";
      } else if (answer !== null || probes >= MAX_PROBES) {
        // For the log only: the final `GET /agents/me/delegate` is what decides.
        const data = dataOf(answer);
        if (answer !== null && isObject(data) && namesLocal(data.pendingDelegate)) {
          o.log.info("this payment key waits for the payer's approval; another key stays bound until then");
        } else if (answer !== null && !(isObject(data) && data.bound === true && namesLocal(data.delegate))) {
          o.log.info("the credential's binding does not name this payment key");
        }
        mode = "chain";
      }
    }
    // A wait stopped while a step was in flight (sign-out, process end) asks nothing more.
    if (mode === "legacy") {
      // The backend reads the chain; the proxy confirms with its own read (G4).
      return (await serverActive()) && !stopped && (await chainLive());
    }
    return (await chainLive()) && !stopped && (await serverActive());
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    o.onEnd?.();
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(tick, o.now() - started < fastFor ? fast : slow);
    timer.unref?.();
  };

  const tick = (): void => {
    timer = null;
    if (stopped) return;
    if (o.now() > until) return stop();
    void once()
      .catch(() => false)
      .then((on) => {
        if (stopped) return;
        if (on) {
          o.onActive();
          stop();
        } else {
          schedule();
        }
      });
  };

  schedule();
  return { stop };
}
