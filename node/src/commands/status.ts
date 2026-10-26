/**
 * `assay-mcp status [--profile <name>]`: the §7.3 summary, on stderr.
 *
 * Read only: no lock, no refresh, no keychain write. The payment-key line comes from the chain
 * (`delegationOf`/`effectiveCapsOf` through the built-in RPCs, which must agree). The API's
 * `paidCalls` is used only when the chain cannot be asked yet (no payer recorded), and is
 * labelled as such. A key that waits for the payer's approval (`pendingDelegate`) is shown with
 * its fingerprint and the approval page. No secret is printed: the payment key appears only as
 * its fingerprint (and in the approval link's `#key=`, which is its public address).
 */
import { getAddress } from "viem";
import { DEFAULT_PROFILE } from "../clients/install-command.js";
import { parseCaip10 } from "../deployments.js";
import { RUN } from "../version.js";
import { EXIT_OK } from "../exit-codes.js";
import { SPEND_WINDOW_SECONDS } from "@goassay-ai/sdk/core";
import { MAX_BODY_BYTES, readCapped, REQUEST_TIMEOUT_MS, requestSignal } from "../oauth/endpoints.js";
import { apiKey } from "../oauth/api-key.js";
import { pinnedFetch } from "../net/fetch.js";
import { enablePaidLink, serverApprovalLink } from "../proxy/meta.js";
import type { ResolvedDeployment } from "../profile/deployments.js";
import { fingerprint } from "../profile/fingerprint.js";
import type { Keychain } from "../profile/keychain.js";
import { readLimits, readPaidUrls, readProfile, readState, type ProfileRecord } from "../profile/profile.js";
import { parseFlags } from "./context.js";
import { unitsToUsd, usd, utcDate } from "./format.js";
import {
  checkProfileName,
  defaultProfileDeps,
  installRecords,
  profileDeployment,
  profileKeychain,
  profileRef,
  reportFailure,
  type ProfileDeps,
} from "./profile-context.js";

const LABEL_WIDTH = 12;
const line = (label: string, value: string) => `${label.padEnd(LABEL_WIDTH)}${value}`;

/** "this Mac", "this PC", "this computer". */
export function thisComputer(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "this Mac" : platform === "win32" ? "this PC" : "this computer";
}

export interface PaidCallsView {
  /** The API's `paidCalls.status`; `UNBOUND` for `paidCalls: null` (no key bound), `UNKNOWN` when `paidCallsUnknown` is true. */
  status: "NONE" | "ACTIVE" | "EXPIRED" | "REVOKED" | "UNBOUND" | "UNKNOWN";
}

/** A payment key bound while another one was: it waits until the payer approves it on enable-paid. */
export interface PendingKey {
  /** Checksummed. */
  address: string;
  /** `YYYY-MM-DD` (UTC) of `pendingSince`, or null. */
  since: string | null;
  /** The approval page, only when it is safe to open (the server's `approvalUrl`, or one built here). */
  link: string | null;
}

interface DelegateView {
  /** `paidCalls`, or null when the answer has no status this reads. */
  paid: PaidCallsView | null;
  pending: PendingKey | null;
}

/** `pendingDelegate`, `pendingSince` and `approvalUrl` of a delegate answer; only checked values. */
export function pendingKeyOf(data: unknown, web: string, credentialId: string | null): PendingKey | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { pendingDelegate?: unknown; pendingSince?: unknown; approvalUrl?: unknown; credentialId?: unknown };
  const parsed = typeof d.pendingDelegate === "string" ? parseCaip10(d.pendingDelegate) : null;
  if (parsed === null) return null;
  const address = getAddress(parsed.address);
  const at = typeof d.pendingSince === "string" ? Date.parse(d.pendingSince) : NaN;
  const since = Number.isFinite(at) ? utcDate(Math.floor(at / 1000)) : null;
  const credential = typeof d.credentialId === "string" ? d.credentialId : credentialId;
  const link =
    serverApprovalLink(web, typeof d.approvalUrl === "string" ? d.approvalUrl : null, address) ??
    (credential !== null ? enablePaidLink(web, credential, address) : null);
  return { address, since, link };
}

/** `GET {API}/agents/me/delegate` → `paidCalls.status` and a pending key (UX only); null on any failure. */
async function delegateFromApi(deployment: ResolvedDeployment, bearer: string, timeoutMs: number, credentialId: string | null): Promise<DelegateView | null> {
  try {
    const signal = requestSignal(timeoutMs);
    const res = await pinnedFetch(deployment, `${deployment.api.replace(/\/+$/, "")}/agents/me/delegate`, {
      headers: { accept: "application/json" },
      bearer,
      signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readCapped(res, MAX_BODY_BYTES, signal);
    if (text === null) return null;
    const data = (JSON.parse(text) as { data?: { paidCalls?: { status?: unknown } | null; paidCallsUnknown?: unknown } } | null)?.data;
    const pending = pendingKeyOf(data, deployment.web, credentialId);
    const view = (paid: PaidCallsView | null): DelegateView => ({ paid, pending });
    if (data?.paidCallsUnknown === true) return view({ status: "UNKNOWN" });
    if (data?.paidCalls === null && data.paidCallsUnknown === false) return view({ status: "UNBOUND" });
    const status = data?.paidCalls?.status;
    return view(status === "NONE" || status === "ACTIVE" || status === "EXPIRED" || status === "REVOKED" ? { status } : null);
  } catch {
    return null;
  }
}

function networkOf(record: ProfileRecord | null, deployment: ResolvedDeployment): string | null {
  if (record?.network) return record.network;
  const networks = Object.keys(deployment.networks);
  return networks.length === 1 ? networks[0]! : null;
}

async function paymentKeyLine(
  deps: ProfileDeps,
  profile: string,
  record: ProfileRecord | null,
  deployment: ResolvedDeployment,
  bearer: string | null,
  /** A sign-in is stored (OAuth refresh token or API key), even when its access token has expired. */
  signedIn: boolean,
  decimals: number,
): Promise<string> {
  const delegate = record?.delegateAddress ?? null;
  if (delegate === null) return "none yet · made on the first paid call";
  const fp = fingerprint(delegate);
  const network = networkOf(record, deployment);
  const enable = enablePaidHint(profile);
  const timeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const isLocal = (pending: PendingKey): boolean => pending.address === getAddress(delegate);
  if (record?.payer && network !== null) {
    const read = await deps.chain(deployment.environment, profile).readDelegation(network, record.payer, delegate, { fresh: true });
    if (!read.ok) return `${fp} · can't confirm on chain right now, try again in a minute`;
    const d = read.value;
    const now = deps.nowSeconds();
    const live = BigInt(d.validUntil) !== 0n && d.active && BigInt(d.validUntil) > BigInt(now);
    if (!live && bearer !== null) {
      // Not live on chain: this key may be waiting for the payer's approval of a rebinding.
      const pending = (await delegateFromApi(deployment, bearer, timeoutMs, record.credentialId))?.pending ?? null;
      if (pending !== null && isLocal(pending)) return `${fp} · ${pendingText(pending, enable)}`;
    }
    if (BigInt(d.validUntil) === 0n) return `${fp} · off (read from chain) · ${enable}`;
    if (!d.active) return `${fp} · stopped (read from chain) · ${enable}`;
    if (BigInt(d.validUntil) <= BigInt(now)) return `${fp} · expired ${utcDate(d.validUntil)} (read from chain) · ${enable}`;
    return `${fp} · on (read from chain) · ${unitsToUsd(d.delegateMaxVoucherAmount, decimals)} a call · ${unitsToUsd(d.delegateMaxPerWindow, decimals)} per 24 h · until ${utcDate(d.validUntil)}`;
  }
  // Read only: no refresh. Without a live token, or without an answer, the key's state is unknown, not "off".
  if (bearer === null) {
    return signedIn
      ? `${fp} · unknown: the stored sign-in has expired (it renews on the next call, or run \`${RUN} login\`)`
      : `${fp} · unknown while signed out · run \`${RUN} login\``;
  }
  const answer = await delegateFromApi(deployment, bearer, timeoutMs, record?.credentialId ?? null);
  const pending = answer?.pending ?? null;
  if (pending !== null && isLocal(pending)) return `${fp} · ${pendingText(pending, enable)}`;
  // Another key waits for approval (bound from another computer): said after this key's state.
  const other = pending === null ? "" : ` · another key ${fingerprint(pending.address)} ${pendingText(pending, null)}`;
  const api = answer?.paid ?? null;
  if (api === null || api.status === "UNKNOWN") return `${fp} · can't check with Assay right now${other}`;
  if (api.status === "UNBOUND") return `${fp} · not bound to this sign-in · ${enable}${other}`;
  if (api.status === "NONE") return `${fp} · not turned on · ${enable}${other}`;
  const word = { ACTIVE: "on", EXPIRED: "expired", REVOKED: "stopped" }[api.status];
  return `${fp} · ${word} (reported by Assay, not yet read from chain)${api.status === "ACTIVE" ? "" : ` · ${enable}`}${other}`;
}

/** `waits for the payer's approval since 2026-10-22 · approve it at <link>` (else `fallback`, when given). */
function pendingText(pending: PendingKey, fallback: string | null): string {
  const since = pending.since === null ? "" : ` since ${pending.since}`;
  const next = pending.link !== null ? ` · approve it at ${pending.link}` : fallback !== null ? ` · ${fallback}` : "";
  return `waits for the payer's approval${since}${next}`;
}

async function signedInBearer(keychain: Keychain, nowSeconds: number): Promise<string | null> {
  const access = await keychain.getAccessToken();
  return access !== null && access.expiresAt > nowSeconds ? access.token : null;
}

export async function statusText(args: readonly string[], deps: ProfileDeps): Promise<string> {
  const { values } = parseFlags(args, { profile: { type: "string" } }, 0);
  const profile = checkProfileName(values.profile as string | undefined);
  const ref = profileRef(deps, profile);
  const deployment = profileDeployment(deps, profile);
  const record = readProfile(ref);
  const keychain = await profileKeychain(deps, profile, deployment);
  const now = deps.nowSeconds();

  const key = apiKey(deployment, deps.env);
  const oauth = key === null && (await keychain.get("refresh_token")) !== null;
  const credential = record ? ` · credential ${record.credentialId.slice(0, 8)}` : "";
  const signedIn =
    key !== null
      ? `yes · API key from ${deployment.dev ? "ASSAY_DEV_API_KEY" : "ASSAY_API_KEY"}${credential}`
      : oauth
        ? `yes · Assay app on ${thisComputer(deps.platform)}${credential} (OAuth)`
        : `no · run \`${RUN} login\``;
  const bearer = key ?? (oauth ? await signedInBearer(keychain, now) : null);

  const network = networkOf(record, deployment);
  const decimals = (network !== null ? deployment.networks[network]?.decimals : undefined) ?? 6;
  const limits = readLimits(ref);
  const spent = readState(ref)
    .signed.filter((e) => e.at > now - SPEND_WINDOW_SECONDS)
    .reduce((sum, e) => sum + BigInt(e.amount), 0n);
  const providers = limits.providers === null ? "any" : limits.providers.join(", ");

  const origin = new URL(deployment.mcp).origin;
  const shortUrl = (url: string) => (url.startsWith(`${origin}/`) ? url.slice(origin.length) : url);
  let installs: string;
  try {
    const mine = installRecords(deps).filter((r) => r.profile === profile);
    installs = mine.length === 0 ? "none" : mine.map((r) => `${r.name} (${r.client}, ${r.scope}) → ${shortUrl(r.url)}`).join("    ");
  } catch (err) {
    installs = `unreadable (${(err as Error).message})`;
  }

  return [
    line("Profile", `${profile}  (${origin})`),
    line("Signed in", signedIn),
    line("Agent", record?.agentLabel ?? "unknown until signed in"),
    line("Payment key", await paymentKeyLine(deps, profile, record, deployment, bearer, key !== null || oauth, decimals)),
    line(
      "Local caps",
      `${usd(limits.perCall)} a call · ${usd(limits.perDay)} per 24 h · spent today ${unitsToUsd(spent, decimals)} · confirm above: ${limits.confirmAbove === null ? "off" : usd(limits.confirmAbove)} · providers: ${providers}`,
    ),
    line("Paid URLs", readPaidUrls(ref).join("  ·  ")),
    line("Installs", installs),
  ].join("\n");
}

export async function runStatus(args: readonly string[], deps: ProfileDeps): Promise<number> {
  try {
    deps.print(`${await statusText(args, deps)}\n`);
    return EXIT_OK;
  } catch (err) {
    return reportFailure("status", err, deps);
  }
}

/** `assay-mcp status`. */
export function run(args: readonly string[]): Promise<number> {
  return runStatus(args, defaultProfileDeps());
}

/** The `enable-paid` command to run for `profile`: a named profile must be passed, or it acts on `default`. */
export function enablePaidHint(profile: string): string {
  const flag = profile === DEFAULT_PROFILE ? "" : ` --profile ${profile}`;
  return `run \`${RUN} enable-paid${flag}\``;
}
