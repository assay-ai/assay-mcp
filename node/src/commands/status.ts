/**
 * `assay-mcp status [--profile <name>]`: the §7.3 summary, on stderr.
 *
 * Read only: no lock, no refresh, no keychain write. The payment-key line comes from the chain
 * (`delegationOf`/`effectiveCapsOf` through the built-in RPCs, which must agree). The API's
 * `paidCalls` is used only when the chain cannot be asked yet (no payer recorded), and is
 * labelled as such. No secret is printed: the payment key appears only as its fingerprint.
 */
import { EXIT_OK } from "../exit-codes.js";
import { SPEND_WINDOW_SECONDS } from "../guards/guards.js";
import { readCapped, REQUEST_TIMEOUT_MS, requestSignal } from "../oauth/endpoints.js";
import { apiKey } from "../oauth/api-key.js";
import { pinnedFetch } from "../net/fetch.js";
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
  status: "NONE" | "ACTIVE" | "EXPIRED" | "REVOKED";
}

/** `GET {API}/agents/me/delegate` → `paidCalls.status` (UX only); null on any failure. */
async function paidCallsFromApi(deployment: ResolvedDeployment, bearer: string, timeoutMs: number): Promise<PaidCallsView | null> {
  try {
    const res = await pinnedFetch(deployment, `${deployment.api.replace(/\/+$/, "")}/agents/me/delegate`, {
      headers: { accept: "application/json" },
      bearer,
      signal: requestSignal(timeoutMs),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readCapped(res);
    if (text === null) return null;
    const status = (JSON.parse(text) as { data?: { paidCalls?: { status?: unknown } | null } } | null)?.data?.paidCalls?.status;
    return status === "NONE" || status === "ACTIVE" || status === "EXPIRED" || status === "REVOKED" ? { status } : null;
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
  decimals: number,
): Promise<string> {
  const delegate = record?.delegateAddress ?? null;
  if (delegate === null) return "none yet · made on the first paid call";
  const fp = fingerprint(delegate);
  const network = networkOf(record, deployment);
  const enable = "run `assay-mcp enable-paid`";
  if (record?.payer && network !== null) {
    const read = await deps.chain(deployment.environment, profile).readDelegation(network, record.payer, delegate, { fresh: true });
    if (!read.ok) return `${fp} · can't confirm on chain right now`;
    const d = read.value;
    const now = deps.nowSeconds();
    if (BigInt(d.validUntil) === 0n) return `${fp} · off (read from chain) · ${enable}`;
    if (!d.active) return `${fp} · stopped (read from chain) · ${enable}`;
    if (BigInt(d.validUntil) <= BigInt(now)) return `${fp} · expired ${utcDate(d.validUntil)} (read from chain) · ${enable}`;
    return `${fp} · on (read from chain) · ${unitsToUsd(d.delegateMaxVoucherAmount, decimals)} a call · ${unitsToUsd(d.delegateMaxPerWindow, decimals)} per 24 h · until ${utcDate(d.validUntil)}`;
  }
  const api = bearer === null ? null : await paidCallsFromApi(deployment, bearer, deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
  if (api === null || api.status === "NONE") return `${fp} · not turned on · ${enable}`;
  const word = { ACTIVE: "on", EXPIRED: "expired", REVOKED: "stopped" }[api.status];
  return `${fp} · ${word} (reported by Assay, not yet read from chain)${api.status === "ACTIVE" ? "" : ` · ${enable}`}`;
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
        : "no · run `assay-mcp login`";
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
    line("Payment key", await paymentKeyLine(deps, profile, record, deployment, bearer, decimals)),
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
