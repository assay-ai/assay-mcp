import { getAddress } from "viem";
import { builtInDeployments, parseCaip10, type Environment } from "../deployments.js";
import { SignerRefusal } from "../signer/errors.js";
import { buildVoucher, type VoucherRequirement, type VoucherTypedData, type WireVoucher } from "../signer/voucher.js";
import { builtInNetwork, checkAll } from "./guards.js";
import type { GuardContext, GuardResult } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type GuardedVoucher = { ok: true; wire: WireVoucher; typedData: VoucherTypedData };

/**
 * The one path from a requirement to a voucher (R-MCP-8): the guards and the signer see the same
 * frozen copy of the requirement, and the network the guards check is the built-in entry of `env`,
 * the same one the signer resolves. A caller cannot pass one object to the guards and another to
 * the signer.
 *
 * Returns the first guard refusal, or the voucher to sign. Throws `SignerRefusal` when the signer
 * refuses after the guards passed, or when the built voucher differs from the guarded values.
 */
export function guardAndBuild(
  ctx: Omit<GuardContext, "network">,
  issuedAtSeconds: number,
  env: Environment,
): GuardedVoucher | Exclude<GuardResult, { ok: true }> {
  let requirement: unknown;
  try {
    requirement = deepFreeze(structuredClone(ctx.requirement));
  } catch {
    return { ok: false, guard: "G1", code: "G1_NOT_A_REQUIREMENT", reason: "the payment request could not be copied" };
  }
  const table = builtInDeployments();
  const id = isPlainObject(requirement) && typeof requirement.network === "string" ? requirement.network : null;
  const network = id !== null && Object.hasOwn(table, env) ? builtInNetwork(table[env], id) : null;

  const result = checkAll({ ...ctx, requirement, network });
  if (!result.ok) return result;

  const req = requirement as VoucherRequirement;
  const built = buildVoucher(req, issuedAtSeconds, env);
  const m = built.typedData.message;
  const escrow = parseCaip10(network!.escrow)!;
  const same =
    m.amount === BigInt(req.amount.amount) &&
    m.seq === BigInt(req.seq) &&
    m.payer === getAddress(parseCaip10(req.payer)!.address) &&
    m.provider === getAddress(parseCaip10(req.provider)!.address) &&
    built.typedData.domain.verifyingContract === getAddress(escrow.address) &&
    built.typedData.domain.chainId === escrow.chainId;
  if (!same) throw new SignerRefusal("the voucher", "message", "differs from the guarded requirement");
  return { ok: true, ...built };
}
