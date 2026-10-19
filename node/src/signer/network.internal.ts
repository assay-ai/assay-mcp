import { getAddress, type Address } from "viem";
import {
  ENVIRONMENTS,
  isPlaceholder,
  parseCaip10,
  parseCaip19Erc20,
  type Deployments,
  type Environment,
} from "../deployments.js";
import { SignerRefusal } from "./errors.js";

declare const resolvedBrand: unique symbol;

/**
 * A network the signer may sign for. Only `resolveNetworkFrom` mints one, after every check
 * below, so a hand-built object cannot be passed where a resolved network is expected.
 */
export type ResolvedNetwork = {
  readonly caip2: string;
  readonly chainId: number;
  readonly escrow: Address;
  /** CAIP-19, as written in the table. */
  readonly asset: string;
  readonly decimals: number;
} & { readonly [resolvedBrand]: true };

const CAIP2 = /^eip155:([1-9][0-9]*)$/;

/**
 * Resolves `network` (CAIP-2) in `table[env]` and checks that it is a network the signer may
 * sign for: a known environment, an own entry of that environment, no placeholder, a checksummed
 * CAIP-10 escrow and CAIP-19 asset, both on the chain the CAIP-2 key names.
 *
 * Internal: production code reaches it only through `resolveBuiltInNetwork`, with the built-in
 * table. Tests use it with fixture tables.
 */
export function resolveNetworkFrom(
  table: Deployments,
  env: Environment,
  network: string,
  what: string,
): ResolvedNetwork {
  const refuse = (field: string, reason: string): never => {
    throw new SignerRefusal(what, field, reason);
  };
  if (!(ENVIRONMENTS as readonly string[]).includes(env) || !Object.hasOwn(table, env)) {
    refuse("environment", "is not a built-in environment");
  }
  const networks = table[env].networks;
  if (typeof network !== "string" || !Object.hasOwn(networks, network)) {
    refuse("network", "is not in the built-in table");
  }
  const chain = CAIP2.exec(network);
  if (!chain) refuse("network", "is not an eip155 CAIP-2 chain id");
  const chainId = Number(chain![1]);
  const entry = networks[network]!;
  if (isPlaceholder(entry.escrow)) refuse("network.escrow", "is a placeholder");
  if (isPlaceholder(entry.asset)) refuse("network.asset", "is a placeholder");
  const escrow = parseCaip10(entry.escrow);
  if (!escrow) refuse("network.escrow", "is not a checksummed CAIP-10 account");
  if (escrow!.chainId !== chainId) refuse("network.escrow", "is not on the network's chain");
  const asset = parseCaip19Erc20(entry.asset);
  if (!asset) refuse("network.asset", "is not a checksummed CAIP-19 erc20 asset");
  if (asset!.chainId !== chainId) refuse("network.asset", "is not on the network's chain");
  if (!Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 36) {
    refuse("network.decimals", "is invalid");
  }
  return {
    caip2: network,
    chainId,
    escrow: getAddress(escrow!.address),
    asset: entry.asset,
    decimals: entry.decimals,
  } as ResolvedNetwork;
}
