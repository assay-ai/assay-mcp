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
import { builtInDeployments, isPlaceholder, type Environment } from "../deployments.js";
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
 * The built-in networks of `env` the signer may sign for, from the bundled `deployments.json`
 * only. An entry whose escrow or asset is still a placeholder is left out; a table the SDK
 * refuses gives no network at all (fail closed: every payment is then refused at G2).
 */
export function builtInNetworks(env: Environment): ReadonlyMap<string, Eip155NetworkEntry> {
  let networks = NETWORKS.get(env);
  if (networks === undefined) {
    const table = builtInDeployments();
    networks = new Map();
    if (Object.hasOwn(table, env)) {
      const entries = Object.entries(table[env].networks).map(
        ([id, n]) => [id, { escrow: n.escrow, asset: n.asset, decimals: n.decimals, rpcUrls: n.rpc.filter((r) => !isPlaceholder(r)) }] as const,
      );
      try {
        networks = networkEntriesFrom(Object.fromEntries(entries), {
          skip: (_id, n) => isPlaceholder(n.escrow) || isPlaceholder(n.asset),
        });
      } catch {
        networks = new Map();
      }
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
