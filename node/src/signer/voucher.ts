import type { Environment } from "../deployments.js";
import { SignerRefusal } from "./errors.js";
import { resolveBuiltInNetwork } from "./network.js";
import { buildVoucherFor, type VoucherRequirement, type VoucherTypedData, type WireVoucher } from "./voucher.internal.js";

export {
  VOUCHER_DOMAIN_NAME,
  VOUCHER_DOMAIN_VERSION,
  VOUCHER_LIFETIME_SECONDS,
  VOUCHER_TYPES,
  type Money,
  type VoucherRequirement,
  type VoucherTypedData,
  type WireVoucher,
} from "./voucher.internal.js";

/**
 * Builds the wire voucher and the EIP-712 typed data the delegate key signs, from a rail-B
 * requirement.
 *
 * - `resourceHash = keccak256(utf8(resource))`; `requestHash` is the requirement's 32 bytes
 *   without `sha256:`;
 * - `expiresAt = issuedAt + min(240, maxTimeoutSeconds)`;
 * - the domain is `{name: "Assay Settlement", version: "2", chainId, verifyingContract}`, taken
 *   only from the built-in `deployments.json` entry `env` for `requirement.network` (G2). The
 *   signer resolves it itself: no table, chain id or escrow comes from the caller.
 *
 * Refuses (`SignerRefusal`) a network that is not in the built-in entry or is a placeholder, an
 * escrow or asset on another chain than the network, a `payTo` other than the built-in escrow,
 * an `amount` in another asset or scale, and anything it cannot encode as the backend verifies
 * it. The local guards (§7.8) run before it is called.
 */
export function buildVoucher(
  requirement: VoucherRequirement,
  issuedAtSeconds: number,
  env: Environment,
): { wire: WireVoucher; typedData: VoucherTypedData } {
  const net = resolveBuiltInNetwork(env, requirement?.network, "the voucher");
  const built = buildVoucherFor(requirement, issuedAtSeconds, net);
  // Belt and braces: the domain is the built-in one, whatever the builder did.
  const { domain } = built.typedData;
  if (domain.chainId !== net.chainId || domain.verifyingContract !== net.escrow) {
    throw new SignerRefusal("the voucher", "domain", "is not the built-in escrow and chain");
  }
  return built;
}
