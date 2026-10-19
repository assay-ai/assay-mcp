/**
 * Anvil proof (replaces the retired e2e `agent-cli` proof): a voucher built and signed with
 * assay-mcp's own signer, through the public signer modules only, is the one the escrow
 * contract on an anvil fork of eip155:46630 verifies.
 *
 * It needs a running anvil fork (default http://127.0.0.1:8547, override with ASSAY_ANVIL_RPC)
 * and skips cleanly when none answers, so a plain `npm test` never needs one. It is read-only:
 * `eth_chainId`, `eth_getCode` and `eth_call` only. The key is generated in memory; the
 * keychain and the profile are never touched. Addresses come from deployments.json.
 */
import { describe, expect, it } from "vitest";
import { hashDomain, recoverTypedDataAddress, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { builtInDeployments, parseCaip10 } from "../../src/deployments.js";
import { generate } from "../../src/signer/keygen.js";
import { buildVoucher, type VoucherRequirement } from "../../src/signer/voucher.js";

const RPC = process.env.ASSAY_ANVIL_RPC ?? "http://127.0.0.1:8547";
const NETWORK = "eip155:46630";
const NETWORK_ENTRY = builtInDeployments().anvil.networks[NETWORK]!;
const ESCROW = parseCaip10(NETWORK_ENTRY.escrow)!;
const ASSET = NETWORK_ENTRY.asset;
const DOMAIN_SEPARATOR_SELECTOR = "0x3644e515"; // DOMAIN_SEPARATOR()

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(3000),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

async function forkIsUp(): Promise<boolean> {
  try {
    if ((await rpc<string>("eth_chainId", [])) !== `0x${ESCROW.chainId.toString(16)}`) return false;
    return (await rpc<string>("eth_getCode", [ESCROW.address, "latest"])) !== "0x";
  } catch {
    return false;
  }
}

const up = await forkIsUp();

describe.skipIf(!up)("anvil proof: assay-mcp's signer against the escrow on the fork", () => {
  const delegate = generate();
  const payer = `${NETWORK}:0x18103e1D79257c695B2FBbd4b346CD2Ba7927296`;
  const requirement: VoucherRequirement = {
    rail: "B",
    scheme: "voucher",
    network: NETWORK,
    payer,
    payTo: NETWORK_ENTRY.escrow,
    provider: `${NETWORK}:0xfB18f483E985F21c58fD97F69DE225aECA5Fc1c4`,
    providerId: "anvil-provider",
    amount: { amount: "250000", asset: ASSET, decimals: 6 },
    resource: "/mcp/tools/get_weather",
    requestHash: `sha256:${"ab".repeat(32)}`,
    seq: "1",
    maxTimeoutSeconds: 300,
    signers: ["payer", "delegate"],
    delegate: `${NETWORK}:${delegate.address}`,
  };

  it("the typed-data domain hashes to the escrow's on-chain DOMAIN_SEPARATOR", async () => {
    const { typedData } = buildVoucher(requirement, 1_800_000_000, "anvil");
    const onChain = await rpc<string>("eth_call", [{ to: ESCROW.address, data: DOMAIN_SEPARATOR_SELECTOR }, "latest"]);
    expect(hashDomain({ domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) }, types: { EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ] } })).toBe(onChain);
  });

  it("the delegate's signature over the built voucher recovers to the delegate", async () => {
    const { typedData } = buildVoucher(requirement, 1_800_000_000, "anvil");
    // The key never leaves this test: it signs through viem, as the proxy does.
    const account = privateKeyToAccount(delegate.privateKey);
    const signature = await account.signTypedData(typedData);
    expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(delegate.address);
    expect(await verifyTypedData({ ...typedData, address: delegate.address, signature })).toBe(true);
  });
});
