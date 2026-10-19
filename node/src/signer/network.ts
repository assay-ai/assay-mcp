import { builtInDeployments, type Environment } from "../deployments.js";
import { resolveNetworkFrom, type ResolvedNetwork } from "./network.internal.js";

export type { ResolvedNetwork } from "./network.internal.js";

/**
 * The only door to a network the signer may sign for: the built-in `deployments.json` bundled
 * into the CLI, keyed by environment name. No caller-supplied table, chain id or escrow is used.
 */
export function resolveBuiltInNetwork(env: Environment, network: string, what: string): ResolvedNetwork {
  return resolveNetworkFrom(builtInDeployments(), env, network, what);
}
