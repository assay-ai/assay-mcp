import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { hashDomain, hashStruct, hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import bindingVectors from "../../vectors/binding.json" with { type: "json" };
import voucherVectors from "../../vectors/vouchers.json" with { type: "json" };
import { builtInDeployments, type Deployment, type Deployments } from "../src/deployments.js";
import { checkBindingChallenge, DELEGATE_BINDING_TYPES, type BindingContext } from "../src/signer/binding.js";
import { dateHeaderOffset, issuedAt } from "../src/signer/clock.js";
import { SignerRefusal } from "../src/signer/errors.js";
import { generate } from "../src/signer/keygen.js";
import { resolveNetworkFrom, type ResolvedNetwork } from "../src/signer/network.internal.js";
import { buildVoucher, VOUCHER_TYPES, type VoucherRequirement } from "../src/signer/voucher.js";
import { buildVoucherFor } from "../src/signer/voucher.internal.js";

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
  const ctx = bindingVectors.context as BindingContext;
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

  it("takes the chain id from the built-in table, never from the caller", () => {
    expect(refusalField(() => checkBindingChallenge(valid, { ...ctx, network: "eip155:1" }))).toBe("network");
    expect(refusalField(() => checkBindingChallenge(valid, { ...ctx, network: "__proto__" }))).toBe("network");
    // a caller-supplied chain id is not part of the context and is ignored
    const sneaky = { ...ctx, chainId: 1 } as BindingContext;
    expect(() => checkBindingChallenge(valid, sneaky)).not.toThrow();
  });

  it("refuses a placeholder environment (staging) and an unknown one", () => {
    expect(refusalField(() => checkBindingChallenge(valid, { ...ctx, environment: "staging" }))).toBe("network.escrow");
    expect(
      refusalField(() => checkBindingChallenge(valid, { ...ctx, environment: "custom" as BindingContext["environment"] })),
    ).toBe("environment");
  });

  it("refuses an unusable context with a SignerRefusal", () => {
    expect(refusalField(() => checkBindingChallenge(valid, { ...ctx, nowSeconds: Number.NaN }))).toBe(
      "context.nowSeconds",
    );
    expect(refusalField(() => checkBindingChallenge(valid, { ...ctx, nowSeconds: Infinity }))).toBe(
      "context.nowSeconds",
    );
    expect(refusalField(() => checkBindingChallenge(valid, { ...ctx, localAddress: "0x12" }))).toBe(
      "context.localAddress",
    );
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

type VectorNetwork = { caip2: string; escrow: string; asset: string; decimals: number };

/** A fixture table holding one network, resolved through the same checks as the built-in one. */
function fixtureTable(network: VectorNetwork): Deployments {
  const d: Deployment = {
    mcp: "https://mcp.example.com",
    issuer: "https://mcp.example.com",
    api: "https://api.example.com",
    web: "https://app.example.com",
    networks: { [network.caip2]: { escrow: network.escrow, asset: network.asset, decimals: network.decimals, rpc: [] } },
  };
  return { production: d, staging: d, e2e: d, anvil: d };
}

function resolved(network: VectorNetwork): ResolvedNetwork {
  return resolveNetworkFrom(fixtureTable(network), "production", network.caip2, "the voucher");
}

describe("buildVoucher", () => {
  const cases = voucherVectors.cases;
  const builtIn = voucherVectors.cases.find((v) => v.name === "built-in-escrow")!;
  const req = builtIn.requirement as VoucherRequirement;

  it.each(cases.map((c) => [c.name, c] as const))("%s: digest equals the vector", async (_name, c) => {
    const { wire, typedData } = buildVoucherFor(c.requirement as VoucherRequirement, c.issuedAt, resolved(c.network));
    expect(wire).toEqual(c.wire);
    expect(decimals(typedData)).toEqual(c.typedData);
    expect(typedData.types).toBe(VOUCHER_TYPES);
    expect(hashTypedData(typedData)).toBe(c.digest);
    // F4 M2: the two parts of the digest are pinned too, so a stale vector field cannot hide.
    expect(
      hashDomain({
        domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) },
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
        },
      }),
    ).toBe(c.domainSeparator);
    expect(hashStruct({ data: typedData.message, primaryType: "Voucher", types: typedData.types })).toBe(c.structHash);
    expect(await testAccount.signTypedData(typedData)).toBe(c.signature);
  });

  it("matches the digest foundry cast computed for the backend's golden voucher", () => {
    const c = cases.find((v) => v.name === "backend-cast-golden")!;
    const { typedData } = buildVoucherFor(c.requirement as VoucherRequirement, c.issuedAt, resolved(c.network));
    expect(hashTypedData(typedData)).toBe("0xb50bc1d1af99579d1bdef9a5531e5a4114abe8c0d6352c4956bb66bc439241e1");
  });

  it.each(["production", "e2e", "anvil"] as const)("uses the built-in chain id and escrow (%s)", (env) => {
    for (const c of cases.filter((v) => v.network.escrow === builtIn.network.escrow)) {
      const { typedData } = buildVoucher(c.requirement as VoucherRequirement, c.issuedAt, env);
      expect(typedData.domain).toEqual({
        name: "Assay Settlement",
        version: "2",
        chainId: 46630,
        verifyingContract: "0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f",
      });
      expect(hashTypedData(typedData)).toBe(c.digest);
    }
  });

  it("the built-in table is deep-frozen: a write throws and vouchers keep the production escrow", () => {
    const table = builtInDeployments();
    const net = table.production.networks["eip155:46630"]!;
    const golden = cases.find((v) => v.name === "backend-cast-golden")!;
    expect(Object.isFrozen(table)).toBe(true);
    expect(() => {
      (net as { escrow: string }).escrow = golden.network.escrow;
    }).toThrow(TypeError);
    expect(() => {
      (net as { decimals: number }).decimals = 18;
    }).toThrow(TypeError);
    expect(() => {
      (net.rpc as string[]).push("https://rpc.example.com");
    }).toThrow(TypeError);
    expect(() => {
      (table.production.networks as Record<string, unknown>)["eip155:1"] = net;
    }).toThrow(TypeError);
    expect(() => {
      (table as Record<string, unknown>).production = table.e2e;
    }).toThrow(TypeError);
    expect(() => Object.assign(table.production, { api: "https://api.example.com" })).toThrow(TypeError);
    expect(net.escrow).toBe("eip155:46630:0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f");
    const { typedData } = buildVoucher(req, builtIn.issuedAt, "production");
    expect(typedData.domain.verifyingContract).toBe("0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f");
    expect(refusalField(() => buildVoucher(golden.requirement as VoucherRequirement, golden.issuedAt, "production"))).toBe(
      "payTo",
    );
  });

  it("refuses to sign for the built-in table's placeholder entry (staging)", () => {
    expect(refusalField(() => buildVoucher(req, builtIn.issuedAt, "staging"))).toBe("network.escrow");
  });

  it("refuses an environment that is not built in", () => {
    expect(
      refusalField(() => buildVoucher(req, builtIn.issuedAt, "custom" as Parameters<typeof buildVoucher>[2])),
    ).toBe("environment");
  });

  it("refuses a requirement network that is not built in, or not own", () => {
    for (const network of ["eip155:1", "__proto__", "constructor", "toString"]) {
      expect(refusalField(() => buildVoucher({ ...req, network }, builtIn.issuedAt, "production"))).toBe("network");
    }
  });

  it("refuses a payTo that is not the built-in escrow (the golden escrow included)", () => {
    const golden = cases.find((v) => v.name === "backend-cast-golden")!;
    expect(
      refusalField(() => buildVoucher(golden.requirement as VoucherRequirement, golden.issuedAt, "production")),
    ).toBe("payTo");
  });

  it("refuses a table whose escrow or asset is on another chain than the network", () => {
    const n = builtIn.network;
    const field = (over: Partial<VectorNetwork>) =>
      refusalField(() => resolved({ ...n, ...over }));
    expect(field({ escrow: "eip155:1:0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f" })).toBe("network.escrow");
    expect(field({ asset: "eip155:1/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3" })).toBe("network.asset");
    expect(field({ escrow: "<escrow>" })).toBe("network.escrow");
    expect(field({ asset: "<asset>" })).toBe("network.asset");
    expect(field({ caip2: "solana:5eykt" })).toBe("network");
  });

  it("refuses a requirement for another network than the resolved one", () => {
    const net = resolved(builtIn.network);
    expect(refusalField(() => buildVoucherFor({ ...req, network: "eip155:1" }, builtIn.issuedAt, net))).toBe("network");
  });

  it("only accepts a resolved network at the type level", () => {
    const handMade = { caip2: "eip155:46630", chainId: 46630, escrow: "0x1111111111111111111111111111111111111111", asset: "", decimals: 6 };
    // @ts-expect-error a hand-built network is not a ResolvedNetwork
    expect(() => buildVoucherFor(req, builtIn.issuedAt, handMade)).toThrow();
    // @ts-expect-error the public entry takes an environment name, not a deployment
    expect(() => buildVoucher(req, builtIn.issuedAt, builtInDeployments().production)).toThrow(SignerRefusal);
  });

  it("expiresAt = issuedAt + min(240, maxTimeoutSeconds)", () => {
    expect(buildVoucher({ ...req, maxTimeoutSeconds: 300 }, 1000, "production").wire.expiresAt).toBe(1240);
    expect(buildVoucher({ ...req, maxTimeoutSeconds: 60 }, 1000, "production").wire.expiresAt).toBe(1060);
  });

  it("builds the wire amount fresh, in the built-in asset and scale", () => {
    const extra = { ...req, amount: { ...req.amount, extra: "x" } as VoucherRequirement["amount"] };
    const { wire } = buildVoucher(extra, builtIn.issuedAt, "production");
    expect(wire.amount).toEqual(builtIn.wire.amount);
    expect(wire.amount).not.toBe(extra.amount);
  });

  it("refuses what it cannot encode as the backend verifies it", () => {
    const field = (r: Partial<VoucherRequirement>, at = builtIn.issuedAt) =>
      refusalField(() => buildVoucher({ ...req, ...r }, at, "production"));
    expect(field({ payTo: "eip155:46630:0x1111111111111111111111111111111111111111" })).toBe("payTo");
    expect(field({ payer: "eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8" })).toBe("payer");
    expect(field({ provider: "eip155:46630:0x3c44cdddb6a900fa2b585dd299e03d12fa4293bC" })).toBe("provider");
    expect(field({ requestHash: "sha256:abc" })).toBe("requestHash");
    expect(field({ seq: "18446744073709551616" })).toBe("seq");
    expect(field({ seq: "-1" })).toBe("seq");
    expect(field({ amount: { ...req.amount, amount: "1.5" } })).toBe("amount");
    expect(field({ amount: { ...req.amount, asset: "eip155:46630/erc20:0x1111111111111111111111111111111111111111" } })).toBe(
      "amount.asset",
    );
    expect(field({ amount: { ...req.amount, decimals: 18 } })).toBe("amount.decimals");
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

  it("never shows the private key when serialised, inspected or spread", () => {
    const a = generate();
    const hex = a.privateKey.slice(2);
    expect(JSON.stringify(a)).not.toContain(hex);
    expect(inspect(a, { depth: 5 })).not.toContain(hex);
    expect(JSON.stringify({ ...a })).not.toContain(hex);
    expect(Object.keys(a)).toEqual(["address"]);
  });
});
