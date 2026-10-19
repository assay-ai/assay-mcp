import { describe, expect, it } from "vitest";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import bindingVectors from "../../vectors/binding.json" with { type: "json" };
import voucherVectors from "../../vectors/vouchers.json" with { type: "json" };
import { builtInDeployments, type Deployment } from "../src/deployments.js";
import { checkBindingChallenge, DELEGATE_BINDING_TYPES } from "../src/signer/binding.js";
import { dateHeaderOffset, issuedAt } from "../src/signer/clock.js";
import { SignerRefusal } from "../src/signer/errors.js";
import { generate } from "../src/signer/keygen.js";
import { buildVoucher, VOUCHER_TYPES, type VoucherRequirement } from "../src/signer/voucher.js";

/** Integers as decimal strings, the way the vectors store typed data. */
function decimals(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(decimals);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decimals(v)]));
  }
  return value;
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

type Path = (string | number)[];

function mutate(source: unknown, op: string, path: Path, value?: unknown): unknown {
  const copy = structuredClone(source) as Record<string | number, unknown>;
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if (op === "delete") delete node[last];
  else node[last] = value;
  return copy;
}

// TEST ONLY: the well-known public anvil key that signed the vectors.
const TEST_KEY = voucherVectors.testKey.privateKey as Hex;
const testAccount = privateKeyToAccount(TEST_KEY);

describe("vectors", () => {
  it("are signed by the labelled public test key", () => {
    for (const v of [voucherVectors, bindingVectors]) {
      expect(v.testKey.label).toMatch(/^TEST ONLY/);
      expect(privateKeyToAccount(v.testKey.privateKey as Hex).address).toBe(v.testKey.address);
    }
  });
});

describe("checkBindingChallenge", () => {
  const ctx = bindingVectors.context;
  const valid = bindingVectors.valid[0]!.challenge;

  it.each(bindingVectors.valid.map((c) => [c.name, c] as const))("accepts %s", async (_name, c) => {
    const typed = checkBindingChallenge(c.challenge, ctx);
    expect(decimals(typed)).toEqual(c.typedData);
    expect(hashTypedData(typed)).toBe(c.digest);
    expect(await testAccount.signTypedData(typed)).toBe(c.signature);
    expect(await recoverTypedDataAddress({ ...typed, signature: c.signature as Hex })).toBe(ctx.localAddress);
  });

  it.each(bindingVectors.invalid.map((c) => [c.name, c] as const))("refuses %s, naming the field", (_name, c) => {
    const bad = mutate(valid, c.op, c.path, "value" in c ? c.value : undefined);
    expect(refusalField(() => checkBindingChallenge(bad, ctx))).toBe(c.field);
  });

  it("the vectors cover every bad field the spec lists", () => {
    const fields = new Set(bindingVectors.invalid.map((c) => c.field));
    for (const f of [
      "domain.name",
      "domain.version",
      "domain.verifyingContract",
      "domain.chainId",
      "primaryType",
      "types.DelegateBinding",
      "message.delegate",
      "message.credentialId",
      "message.expiresAt",
    ]) {
      expect(fields).toContain(f);
    }
    expect(bindingVectors.invalid.some((c) => c.field.startsWith("types.") && c.field !== "types.DelegateBinding")).toBe(
      true,
    );
    const plus301 = bindingVectors.invalid.find((c) => c.name === "expiresAt = now + 301")!;
    expect(plus301.value).toBe(String(ctx.nowSeconds + 301));
  });

  it("refuses expiresAt = now + 301 and accepts now + 300", () => {
    const at = (s: number) => mutate(valid, "set", ["typedData", "message", "expiresAt"], String(s));
    expect(refusalField(() => checkBindingChallenge(at(ctx.nowSeconds + 301), ctx))).toBe("message.expiresAt");
    expect(() => checkBindingChallenge(at(ctx.nowSeconds + 300), ctx)).not.toThrow();
  });

  it("refuses a challenge for another chain than the network's", () => {
    expect(refusalField(() => checkBindingChallenge(valid, { ...ctx, chainId: 1 }))).toBe("domain.chainId");
  });

  it("refuses a challenge for another profile credential or key", () => {
    expect(refusalField(() => checkBindingChallenge(valid, { ...ctx, credentialId: "other" }))).toBe(
      "message.credentialId",
    );
    expect(
      refusalField(() =>
        checkBindingChallenge(valid, { ...ctx, localAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }),
      ),
    ).toBe("message.delegate");
  });

  it("accepts a lower-case delegate and a numeric chainId and expiresAt, and signs its own constants", () => {
    const c = mutate(
      mutate(
        mutate(valid, "set", ["typedData", "message", "delegate"], ctx.localAddress.toLowerCase()),
        "set",
        ["typedData", "domain", "chainId"],
        46630,
      ),
      "set",
      ["typedData", "message", "expiresAt"],
      ctx.nowSeconds + 300,
    );
    const typed = checkBindingChallenge(c, ctx);
    expect(typed.types).toBe(DELEGATE_BINDING_TYPES);
    expect(hashTypedData(typed)).toBe(bindingVectors.valid[0]!.digest);
  });

  it("refuses a challenge that is not an object", () => {
    expect(refusalField(() => checkBindingChallenge(null, ctx))).toBe("challenge");
  });
});

function deploymentFor(network: { caip2: string; escrow: string; asset: string; decimals: number }): Deployment {
  return {
    mcp: "https://mcp.example.com",
    issuer: "https://mcp.example.com",
    api: "https://api.example.com",
    web: "https://app.example.com",
    networks: { [network.caip2]: { escrow: network.escrow, asset: network.asset, decimals: network.decimals, rpc: [] } },
  };
}

describe("buildVoucher", () => {
  const cases = voucherVectors.cases;

  it.each(cases.map((c) => [c.name, c] as const))("%s: digest equals the vector", async (_name, c) => {
    const { wire, typedData } = buildVoucher(c.requirement as VoucherRequirement, c.issuedAt, deploymentFor(c.network));
    expect(wire).toEqual(c.wire);
    expect(decimals(typedData)).toEqual(c.typedData);
    expect(typedData.types).toBe(VOUCHER_TYPES);
    expect(hashTypedData(typedData)).toBe(c.digest);
    expect(await testAccount.signTypedData(typedData)).toBe(c.signature);
  });

  it("matches the digest foundry cast computed for the backend's golden voucher", () => {
    const c = cases.find((v) => v.name === "backend-cast-golden")!;
    const { typedData } = buildVoucher(c.requirement as VoucherRequirement, c.issuedAt, deploymentFor(c.network));
    expect(hashTypedData(typedData)).toBe("0xb50bc1d1af99579d1bdef9a5531e5a4114abe8c0d6352c4956bb66bc439241e1");
  });

  it("uses the built-in chain id and escrow", () => {
    const c = cases.find((v) => v.name === "built-in-escrow")!;
    const { typedData } = buildVoucher(c.requirement as VoucherRequirement, c.issuedAt, builtInDeployments().production);
    expect(typedData.domain).toEqual({
      name: "Assay Settlement",
      version: "2",
      chainId: 46630,
      verifyingContract: "0x1D2625efD87c2fc10b8563f3F0890072845Fcf41",
    });
    expect(hashTypedData(typedData)).toBe(c.digest);
  });

  it("expiresAt = issuedAt + min(240, maxTimeoutSeconds)", () => {
    const c = cases.find((v) => v.name === "built-in-escrow")!;
    const req = c.requirement as VoucherRequirement;
    const d = deploymentFor(c.network);
    expect(buildVoucher({ ...req, maxTimeoutSeconds: 300 }, 1000, d).wire.expiresAt).toBe(1240);
    expect(buildVoucher({ ...req, maxTimeoutSeconds: 60 }, 1000, d).wire.expiresAt).toBe(1060);
  });

  it("refuses what it cannot encode as the backend verifies it", () => {
    const c = cases.find((v) => v.name === "built-in-escrow")!;
    const req = c.requirement as VoucherRequirement;
    const d = deploymentFor(c.network);
    const field = (r: Partial<VoucherRequirement>, at = c.issuedAt) =>
      refusalField(() => buildVoucher({ ...req, ...r }, at, d));
    expect(field({ network: "eip155:1" })).toBe("network");
    expect(field({ payTo: "eip155:46630:0x1111111111111111111111111111111111111111" })).toBe("payTo");
    expect(field({ payer: "eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8" })).toBe("payer");
    expect(field({ provider: "eip155:46630:0x3c44cdddb6a900fa2b585dd299e03d12fa4293bC" })).toBe("provider");
    expect(field({ requestHash: "sha256:abc" })).toBe("requestHash");
    expect(field({ seq: "18446744073709551616" })).toBe("seq");
    expect(field({ seq: "-1" })).toBe("seq");
    expect(field({ amount: { ...req.amount, amount: "1.5" } })).toBe("amount");
    expect(field({ resource: "" })).toBe("resource");
    expect(field({ maxTimeoutSeconds: 0 })).toBe("maxTimeoutSeconds");
    expect(field({}, 1.5)).toBe("issuedAt");
  });
});

describe("clock", () => {
  it("a +500 s Date offset is clamped to +120 s", () => {
    expect(issuedAt(1_000_000, 500)).toBe(1_000_120);
  });

  it("a -500 s Date offset is clamped to -120 s", () => {
    expect(issuedAt(1_000_000, -500)).toBe(999_880);
  });

  it("an offset inside the clamp is applied; a missing one is ignored", () => {
    expect(issuedAt(1_000_000, 30)).toBe(1_000_030);
    expect(issuedAt(1_000_000, -30)).toBe(999_970);
    expect(issuedAt(1_000_000.9, Number.NaN)).toBe(1_000_000);
    expect(issuedAt(1_000_000, Number.POSITIVE_INFINITY)).toBe(1_000_000);
  });

  it("is never later than local time + 120 s", () => {
    for (const offset of [0, 119, 120, 121, 1e9]) expect(issuedAt(1_000_000, offset)).toBeLessThanOrEqual(1_000_120);
  });

  it("reads the offset from an HTTP Date header", () => {
    const local = Date.parse("2026-01-01T00:00:00Z") / 1000;
    expect(dateHeaderOffset("Thu, 01 Jan 2026 00:08:20 GMT", local)).toBe(500);
    expect(issuedAt(local, dateHeaderOffset("Thu, 01 Jan 2026 00:08:20 GMT", local))).toBe(local + 120);
    expect(dateHeaderOffset("not a date", local)).toBe(0);
    expect(dateHeaderOffset(undefined, local)).toBe(0);
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
});
