import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildVoucher, SignerRefusal, type VoucherRequirement } from "@goassay-ai/sdk/core";
import voucherVectors from "../../vectors/vouchers.json" with { type: "json" };
import { builtInDeployments, type Environment } from "../src/deployments.js";
import { builtInNetworks } from "../src/guards/sign.js";
import { generate } from "../src/signer/keygen.js";

// The voucher builder, its EIP-712 types and its refusals are the SDK's and tested there. Here:
// the proxy's own trust root (the built-in `deployments.json`) as the network the SDK signs for.

/** `buildVoucher` with the built-in entry of `env` for the requirement's network. */
function build(req: VoucherRequirement, issuedAt: number, env: Environment) {
  const e = builtInNetworks(env).get(req.network);
  if (!e) throw new SignerRefusal("the voucher", "network", "is not in the built-in table");
  return buildVoucher(req, issuedAt, { caip2: e.id, escrow: e.escrowCaip10, asset: e.asset, decimals: e.decimals });
}

function refusalField(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SignerRefusal) return error.field;
    throw error;
  }
  throw new Error("expected a SignerRefusal");
}

const cases = voucherVectors.cases;
const builtIn = cases.find((v) => v.name === "built-in-escrow")!;
const golden = cases.find((v) => v.name === "backend-cast-golden")!;
const req = builtIn.requirement as VoucherRequirement;

describe("vouchers for the built-in networks", () => {
  // The vectors are signed for the local fixture escrow, which e2e and anvil use; production and staging have their own.
  it.each(["e2e", "anvil"] as const)("uses the built-in chain id and escrow (%s)", (env) => {
    for (const c of cases.filter((v) => v.network.escrow === builtIn.network.escrow)) {
      const { typedData } = build(c.requirement as VoucherRequirement, c.issuedAt, env);
      expect(typedData.domain).toEqual({
        name: "Assay Settlement",
        version: "2",
        chainId: 46630,
        verifyingContract: "0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f",
      });
      expect(hashTypedData(typedData)).toBe(c.digest);
    }
  });

  it("production signs only for its own escrow, never the vectors' dev escrow", () => {
    const prodEscrow = builtInDeployments().production.networks["eip155:46630"]!.escrow;
    expect(prodEscrow).toBe("eip155:46630:0xE68A6E2810027dB5da48c2110bd3993eD8177115");
    expect(refusalField(() => build(req, builtIn.issuedAt, "production"))).toBe("payTo");
    const { typedData } = build({ ...req, payTo: prodEscrow }, builtIn.issuedAt, "production");
    expect(typedData.domain.verifyingContract).toBe("0xE68A6E2810027dB5da48c2110bd3993eD8177115");
  });

  it("the built-in table is deep-frozen: a write throws and vouchers keep the built-in escrow", () => {
    const table = builtInDeployments();
    const net = table.production.networks["eip155:46630"]!;
    expect(Object.isFrozen(table)).toBe(true);
    expect(() => {
      (net as { escrow: string }).escrow = golden.network.escrow;
    }).toThrow(TypeError);
    expect(() => {
      (net.rpc as string[]).push("https://rpc.example.com");
    }).toThrow(TypeError);
    expect(() => {
      (table as Record<string, unknown>).production = table.e2e;
    }).toThrow(TypeError);
    expect(refusalField(() => build(golden.requirement as VoucherRequirement, golden.issuedAt, "production"))).toBe("payTo");
  });

  it("knows no network that is not built in, or not own", () => {
    for (const network of ["eip155:1", "__proto__", "constructor", "toString"]) {
      expect(builtInNetworks("e2e").get(network)).toBeUndefined();
      expect(refusalField(() => build({ ...req, network }, builtIn.issuedAt, "e2e"))).toBe("network");
    }
    expect(builtInNetworks("custom" as Environment).size).toBe(0);
  });

  it("refuses a payTo that is not the built-in escrow (the golden escrow included)", () => {
    expect(refusalField(() => build(golden.requirement as VoucherRequirement, golden.issuedAt, "e2e"))).toBe("payTo");
  });
});

describe("keygen", () => {
  it("generates a fresh key whose address matches", () => {
    const a = generate();
    const b = generate();
    expect(a.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(privateKeyToAccount(a.privateKey).address).toBe(a.address);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it("never shows the private key when serialised, inspected or spread", () => {
    const a = generate();
    const hex = a.privateKey.slice(2);
    expect(JSON.stringify(a)).not.toContain(hex);
    expect(inspect(a, { depth: 5 })).not.toContain(hex);
    expect(JSON.stringify({ ...a })).not.toContain(hex);
    expect(Object.keys(a)).toEqual(["address"]);
  });
});
