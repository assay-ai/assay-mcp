import {
  guardAndBuild as coreGuardAndBuild,
  networkEntriesFrom,
  type BuiltInNetwork,
  type Eip155NetworkEntry,
  type GuardContext,
  type GuardedVoucher,
  type GuardOptions,
  type GuardResult,
} from "@goassay-ai/sdk/core";
import { builtInDeployments, ENVIRONMENTS, isPlaceholder, type Deployments, type Environment } from "../deployments.js";
import { RUN } from "../version.js";

/**
 * The proxy's door to the SDK's payment core (`@goassay-ai/sdk/core`): the guards, the voucher
 * builder and the EIP-712 types live there, never here (`scripts/check-no-fork.mjs`). What stays
 * in the proxy is its own trust root (the built-in `deployments.json`), its per-URL paid list
 * (G11) and the command its users run.
 */

/** G4: the text the user sees when the server names a payer other than the recorded one. */
export const PAYER_CHANGED_REASON = `payer changed; run ${RUN} enable-paid`;

const NETWORKS = new Map<Environment, ReadonlyMap<string, Eip155NetworkEntry>>();

/**
 * The SDK's network map for `env` of `table`: an entry whose escrow or asset is still a
 * placeholder is left out, placeholder RPCs are dropped. Throws the SDK's `ConfigError`, naming
 * the entry, when the SDK refuses one.
 */
export function networkEntriesOf(table: Deployments, env: Environment): ReadonlyMap<string, Eip155NetworkEntry> {
  if (!Object.hasOwn(table, env)) return new Map();
  const entries = Object.entries(table[env].networks).map(
    ([id, n]) => [id, { escrow: n.escrow, asset: n.asset, decimals: n.decimals, rpcUrls: n.rpc.filter((r) => !isPlaceholder(r)) }] as const,
  );
  return networkEntriesFrom(Object.fromEntries(entries), {
    skip: (_id, n) => isPlaceholder(n.escrow) || isPlaceholder(n.asset),
  });
}

/**
 * Every entry of `table` the SDK refuses, as `env: reason`. The CLI checks the built-in table
 * with this on start, so a refusal is reported there and never only seen as payments refused
 * at G2 (see {@link builtInNetworks}).
 */
export function sdkNetworkErrors(table: Deployments): string[] {
  const errors: string[] = [];
  for (const env of ENVIRONMENTS) {
    try {
      networkEntriesOf(table, env);
    } catch (err) {
      errors.push(`${env}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return errors;
}

/**
 * The built-in networks of `env` the signer may sign for, from the bundled `deployments.json`
 * only. An entry whose escrow or asset is still a placeholder is left out; a table the SDK
 * refuses gives no network at all (fail closed: every payment is then refused at G2). The CLI
 * refuses to start on such a table ({@link sdkNetworkErrors}), so this is only a backstop.
 */
export function builtInNetworks(env: Environment): ReadonlyMap<string, Eip155NetworkEntry> {
  let networks = NETWORKS.get(env);
  if (networks === undefined) {
    try {
      networks = networkEntriesOf(builtInDeployments(), env);
    } catch {
      networks = new Map();
    }
    NETWORKS.set(env, networks);
  }
  return networks;
}

/** The built-in entry for `id` in `env`, as the guards take it, or `null`. */
export function builtInNetwork(env: Environment, id: string): BuiltInNetwork | null {
  const e = builtInNetworks(env).get(id);
  return e ? { id: e.id, escrow: e.escrowCaip10, asset: e.asset, decimals: e.decimals } : null;
}

/** The guard context the proxy builds: the SDK's, plus the URL it serves and its paid list (G11). */
export type ProxyGuardContext = Omit<GuardContext, "network"> & {
  /** The canonical URL this proxy serves (G11). */
  canonicalUrl: string;
  /** `profiles/{profile}.paid-urls.json` (G11). */
  paidUrls: string[];
};

/** The options the proxy always runs the guards with: G11 on, its own G4 text, signer refusals thrown. */
export function proxyGuardOptions(ctx: Pick<ProxyGuardContext, "canonicalUrl" | "paidUrls">): GuardOptions {
  return {
    paidUrlPolicy: { canonicalUrl: ctx.canonicalUrl, paidUrls: ctx.paidUrls },
    payerChangedReason: PAYER_CHANGED_REASON,
    signerRefusal: "throw",
  };
}

/**
 * The one path from a requirement to a voucher (R-MCP-8), through the SDK's `guardAndBuild`: the
 * guards and the signer see the same frozen copy of the requirement, and the network both use is
 * the built-in entry of `env`. Returns the first guard refusal (G1..G12 in order, then the G7
 * confirmation), or the voucher to sign. Throws `SignerRefusal` when the signer refuses after the
 * guards passed, or for an `issuedAt` that is not a positive integer.
 */
export function guardAndBuild(
  ctx: ProxyGuardContext,
  issuedAtSeconds: number,
  env: Environment,
): GuardedVoucher | Exclude<GuardResult, { ok: true }> {
  const { canonicalUrl, paidUrls, ...rest } = ctx;
  return coreGuardAndBuild(rest, issuedAtSeconds, builtInNetworks(env), proxyGuardOptions({ canonicalUrl, paidUrls }));
}
