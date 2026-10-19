import { randomBytes } from "node:crypto";
import { idKey, type JsonRpcId } from "./protocol.js";

/**
 * One record per host `tools/call` the proxy forwards (the 2.3 re-review notes for 2.8/2.9).
 *
 * - **Paired by JSON-RPC id.** A record is keyed by the host's request id; a second request
 *   with an id still in flight is refused, so a remote answer can only ever be matched to the
 *   one call that id names. Answers carrying any other id are dropped by the forwarder.
 * - **At most one voucher per call** (R-MCP-9): {@link ForwardedCall.claimVoucher} returns true
 *   once. A second `PAYMENT_REQUIRED` on the same call goes back to the host unsigned, so a
 *   payment loop cannot drain the daily cap.
 * - **Single-use confirmation tokens**: a token names one call, is consumed on first use, and
 *   expires {@link CONFIRMATION_TTL_MS} after the call started, so a late "Pay" gets a clear
 *   answer instead of paying for a stale requirement.
 *
 * The paid path itself (signing, the guards, the confirmation prompt) is Task 2.9.
 */

/** How long after a call starts its confirmation is still accepted (the forwarding timeout). */
export const CONFIRMATION_TTL_MS = 120_000;

export interface ForwardedCall {
  readonly id: JsonRpcId;
  /** The exact tool name sent to the remote (an alias already mapped back). */
  readonly tool: string;
  /** The params as forwarded. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Wall-clock ms when the host's request arrived. */
  readonly startedAt: number;
  /** Vouchers signed for this call so far (0 or 1). */
  readonly vouchers: number;
  /** True the first time only: the caller may sign one voucher for this call. */
  claimVoucher(): boolean;
}

export type ConfirmationOutcome =
  | { kind: "ok"; call: ForwardedCall }
  | { kind: "expired"; call: ForwardedCall }
  | { kind: "unknown" };

class CallRecord implements ForwardedCall {
  vouchers = 0;
  constructor(
    readonly id: JsonRpcId,
    readonly tool: string,
    readonly params: Readonly<Record<string, unknown>>,
    readonly startedAt: number,
  ) {}
  claimVoucher(): boolean {
    if (this.vouchers > 0) return false;
    this.vouchers = 1;
    return true;
  }
}

/** How long a token of an ended call still answers `expired` (not `unknown`). */
export const TOMBSTONE_MS = 10 * 60_000;
const MAX_TOMBSTONES = 1_000;

export class CallRegistry {
  private readonly open = new Map<string, CallRecord>();
  private readonly confirmations = new Map<string, CallRecord>();
  /** Tokens of calls that ended: a late "Pay" gets `expired` (review M11). */
  private readonly tombstones = new Map<string, { call: CallRecord; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Opens the record for a host request; `null` when that id is already in flight. */
  begin(id: JsonRpcId, tool: string, params: Readonly<Record<string, unknown>>): ForwardedCall | null {
    const key = idKey(id);
    if (this.open.has(key)) return null;
    const record = new CallRecord(id, tool, params, this.now());
    this.open.set(key, record);
    return record;
  }

  /** The in-flight record for an id. */
  get(id: JsonRpcId): ForwardedCall | null {
    return this.open.get(idKey(id)) ?? null;
  }

  /** Closes a record once its answer went to the host; its confirmation tokens die with it. */
  end(call: ForwardedCall): void {
    const key = idKey(call.id);
    if (this.open.get(key) === call) this.open.delete(key);
    const now = this.now();
    for (const [token, c] of this.confirmations) {
      if (c !== call) continue;
      this.confirmations.delete(token);
      this.tombstones.set(token, { call: c, until: now + TOMBSTONE_MS });
    }
    for (const [token, t] of this.tombstones) if (t.until <= now || this.tombstones.size > MAX_TOMBSTONES) this.tombstones.delete(token);
  }

  get size(): number {
    return this.open.size;
  }

  /** A fresh single-use token naming `call`. */
  issueConfirmation(call: ForwardedCall): string {
    if (this.open.get(idKey(call.id)) !== call) throw new Error("the call is not in flight");
    const token = randomBytes(16).toString("base64url");
    this.confirmations.set(token, call as CallRecord);
    return token;
  }

  /** Consumes a token: valid once, and only within {@link CONFIRMATION_TTL_MS} of the call. */
  consumeConfirmation(token: string): ConfirmationOutcome {
    const call = this.confirmations.get(token);
    if (!call) {
      const t = this.tombstones.get(token);
      this.tombstones.delete(token);
      return t && t.until > this.now() ? { kind: "expired", call: t.call } : { kind: "unknown" };
    }
    this.confirmations.delete(token);
    if (this.open.get(idKey(call.id)) !== call) return { kind: "unknown" };
    if (this.now() - call.startedAt > CONFIRMATION_TTL_MS) return { kind: "expired", call };
    return { kind: "ok", call };
  }
}
