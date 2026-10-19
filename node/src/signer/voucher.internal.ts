import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { parseCaip10 } from "../deployments.js";
import { SignerRefusal } from "./errors.js";
import type { ResolvedNetwork } from "./network.internal.js";

/** The escrow's EIP-712 domain name and version (assay-evm, backend `eip712/domain.ts`). */
export const VOUCHER_DOMAIN_NAME = "Assay Settlement";
export const VOUCHER_DOMAIN_VERSION = "2";

/** The lifetime the proxy asks for: well inside the server's 300 s ceiling. */
export const VOUCHER_LIFETIME_SECONDS = 240;

/** The eight signed fields, in the order assay-evm `Types.sol` declares them. The order is the typehash. */
export const VOUCHER_TYPES = {
  Voucher: [
    { name: "payer", type: "address" },
    { name: "provider", type: "address" },
    { name: "amount", type: "uint64" },
    { name: "resourceHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "seq", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export interface Money {
  amount: string;
  asset: string;
  decimals: number;
}

/** `_meta["x402/paymentRequired"]` on rail B, as the backend sends it (`VoucherRequirement`). */
export interface VoucherRequirement {
  rail: "B";
  scheme: "voucher";
  network: string;
  payer: string;
  payTo: string;
  provider: string;
  providerId: string;
  amount: Money;
  contractVersion?: number;
  resource: string;
  requestHash: string;
  seq: string;
  maxTimeoutSeconds: number;
  signers?: string[];
  delegate?: string | null;
}

/** The voucher as it goes on the wire in `_meta["assay/voucher"].voucher`. */
export interface WireVoucher {
  payer: string;
  payTo: string;
  provider: string;
  amount: Money;
  resource: string;
  requestHash: string;
  seq: string;
  issuedAt: number;
  expiresAt: number;
}

export interface VoucherTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: typeof VOUCHER_TYPES;
  primaryType: "Voucher";
  message: {
    payer: Address;
    provider: Address;
    amount: bigint;
    resourceHash: Hex;
    requestHash: Hex;
    seq: bigint;
    issuedAt: bigint;
    expiresAt: bigint;
  };
}

const MAX_UINT64 = 2n ** 64n - 1n;

function refuse(field: string, reason: string): never {
  throw new SignerRefusal("the voucher", field, reason);
}

function uint64(field: string, value: unknown): bigint {
  const ok =
    (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  if (!ok) refuse(field, "is not a non-negative integer");
  const n = BigInt(value as string | number);
  if (n > MAX_UINT64) refuse(field, "does not fit uint64");
  return n;
}

function account(field: string, value: unknown, chainId: number): Address {
  const parsed = typeof value === "string" ? parseCaip10(value) : null;
  if (!parsed) refuse(field, "is not a checksummed CAIP-10 account");
  if (parsed.chainId !== chainId) refuse(field, "is not on the requirement's network");
  return getAddress(parsed.address);
}

/** `sha256:<64 hex>` or bare 64 hex, as 32 bytes. The backend carries these bytes through unchanged. */
function requestHashBytes(value: unknown): Hex {
  const hex = typeof value === "string" ? value.replace(/^sha256:/, "") : "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) refuse("requestHash", "is not 32 bytes of hex");
  return `0x${hex.toLowerCase()}`;
}

/**
 * Builds the wire voucher and the EIP-712 typed data the delegate key signs, from a rail-B
 * requirement (a port of `agent-cli` `buildVoucher`), for an already resolved network.
 *
 * Internal: production code reaches it only through `buildVoucher` in `voucher.ts`, which
 * resolves the network from the built-in table. `ResolvedNetwork` is branded, so a hand-built
 * network does not type-check here.
 */
export function buildVoucherFor(
  requirement: VoucherRequirement,
  issuedAtSeconds: number,
  net: ResolvedNetwork,
): { wire: WireVoucher; typedData: VoucherTypedData } {
  if (requirement.network !== net.caip2) refuse("network", "is not the resolved network");
  const chainId = net.chainId;
  const verifyingContract = net.escrow;

  const payTo = account("payTo", requirement.payTo, chainId);
  if (payTo !== verifyingContract) refuse("payTo", "is not the built-in escrow");
  const payer = account("payer", requirement.payer, chainId);
  const provider = account("provider", requirement.provider, chainId);

  const money = requirement.amount as unknown;
  if (typeof money !== "object" || money === null) refuse("amount", "is missing");
  const amount = uint64("amount", requirement.amount.amount);
  if (requirement.amount.asset !== net.asset) refuse("amount.asset", "is not the built-in asset");
  if (requirement.amount.decimals !== net.decimals) refuse("amount.decimals", "are not the built-in decimals");
  const seq = uint64("seq", requirement.seq);
  if (typeof requirement.resource !== "string" || requirement.resource.length === 0) {
    refuse("resource", "is empty");
  }
  const requestHash = requestHashBytes(requirement.requestHash);
  const maxTimeout = requirement.maxTimeoutSeconds;
  if (!Number.isSafeInteger(maxTimeout) || maxTimeout < 1) refuse("maxTimeoutSeconds", "is not a positive integer");
  if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds <= 0) refuse("issuedAt", "is not a positive integer");

  const issuedAt = issuedAtSeconds;
  const expiresAt = issuedAt + Math.min(VOUCHER_LIFETIME_SECONDS, maxTimeout);

  // Built fresh: nothing the server sent beyond the checked fields reaches the wire.
  const wire: WireVoucher = {
    payer: requirement.payer,
    payTo: requirement.payTo,
    provider: requirement.provider,
    amount: { amount: amount.toString(), asset: net.asset, decimals: net.decimals },
    resource: requirement.resource,
    requestHash: requirement.requestHash,
    seq: seq.toString(),
    issuedAt,
    expiresAt,
  };
  const typedData: VoucherTypedData = {
    domain: { name: VOUCHER_DOMAIN_NAME, version: VOUCHER_DOMAIN_VERSION, chainId, verifyingContract },
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: {
      payer,
      provider,
      amount,
      // `stringToBytes`, not `toBytes`: a resource starting with `0x` is still a string.
      resourceHash: keccak256(stringToBytes(requirement.resource)),
      requestHash,
      seq,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
    },
  };
  return { wire, typedData };
}
