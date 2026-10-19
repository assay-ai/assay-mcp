import { describe, expect, it } from "vitest";
import guardVectors from "../../vectors/guards.json" with { type: "json" };
import seqVectors from "../../vectors/seq.json" with { type: "json" };
import { builtInDeployments } from "../src/deployments.js";
import { getAddress } from "viem";
import { builtInNetwork, checkAll, confirmationFor, GUARD_ORDER, usdToAtomic } from "../src/guards/guards.js";
import { guardAndBuild } from "../src/guards/sign.js";
import { DEFAULT_LIMITS, REFUSAL_CODES, type GuardContext, type GuardResult } from "../src/guards/types.js";

type Path = (string | number)[];
interface Change {
  op: string;
  path: Path;
  value?: unknown;
}

function apply(source: unknown, changes: Change[]): GuardContext {
  const copy = structuredClone(source) as Record<string | number, unknown>;
  for (const { op, path, value } of changes) {
    let node = copy;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
    const last = path[path.length - 1]!;
    if (op === "delete") delete node[last];
    else if (op === "set") node[last] = structuredClone(value);
    else throw new Error(`unknown op ${op}`);
  }
  return copy as unknown as GuardContext;
}

const base = guardVectors.base as unknown as GuardContext;
const cases = guardVectors.cases as unknown as {
  guard: string;
  name: string;
  changes: Change[];
  expect: { ok: boolean; guard?: string; code?: string; reason?: string };
}[];

function find(name: string) {
  const c = cases.find((x) => x.name === name);
  if (!c) throw new Error(`no vector named ${name}`);
  return c;
}

function run(name: string): GuardResult {
  return checkAll(apply(base, find(name).changes));
}

describe("guards.json", () => {
  it.each(cases.map((c) => [`${c.guard} ${c.name}`, c] as const))("%s", (_, c) => {
    const result = checkAll(apply(base, c.changes));
    if (c.expect.ok) {
      expect(result).toEqual({ ok: true });
      return;
    }
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect({ guard: result.guard, code: result.code }).toEqual({ guard: c.expect.guard, code: c.expect.code });
    if (c.expect.reason !== undefined) expect(result.reason).toBe(c.expect.reason);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("has one passing and one failing case per guard", () => {
    for (const g of GUARD_ORDER) {
      expect(cases.some((c) => c.guard === g && c.expect.ok), `${g} pass`).toBe(true);
      expect(cases.some((c) => c.guard === g && !c.expect.ok && c.expect.guard === g), `${g} fail`).toBe(true);
    }
  });

  it("has a vector for every refusal code", () => {
    const covered = new Set(cases.filter((c) => !c.expect.ok).map((c) => c.expect.code));
    for (const code of Object.keys(REFUSAL_CODES)) expect(covered.has(code), code).toBe(true);
  });

  it("names the guard each code belongs to", () => {
    for (const c of cases.filter((x) => !x.expect.ok)) {
      expect(REFUSAL_CODES[c.expect.code as keyof typeof REFUSAL_CODES]).toBe(c.expect.guard);
    }
  });

  it("uses the built-in production network, the default limits and a $5 day", () => {
    const prod = builtInDeployments().production;
    expect(base.network).toEqual(builtInNetwork(prod, "eip155:46630"));
    expect(base.limits).toEqual(DEFAULT_LIMITS);
  });
});

describe("the brief's cases", () => {
  const refuses = (name: string, guard: string) => {
    const r = run(name);
    expect(r.ok ? "ok" : r.guard, name).toBe(guard);
  };

  it("seq 2^53-1 passes; 2^53 and 2^64-1 -> G9; seq 0 -> G9", () => {
    expect(run("seq 2^53-1 passes")).toEqual({ ok: true });
    refuses("seq 2^53", "G9");
    refuses("seq 2^64-1", "G9");
    refuses("seq 0", "G9");
  });

  it("amount 500001 (> $0.50) -> G7", () => refuses("amount 500001 (> $0.50)", "G7"));
  it("spent 4.80 + 0.30 > 5 -> G7", () => refuses("spent 4.80 + 0.30 > 5", "G7"));
  it("payTo other escrow -> G2", () => refuses("payTo other escrow", "G2"));
  it("asset decimals 18 -> G2", () => refuses("asset decimals 18", "G2"));
  it("amount > quote.maxAmount -> G3", () => refuses("amount > quote.maxAmount", "G3"));
  it("signers without delegate -> G5", () => refuses("signers without delegate", "G5"));
  it("localKey === payer -> G5", () => refuses("localKey === payer", "G5"));
  it("requestHash 63 hex -> G10", () => refuses("requestHash 63 hex", "G10"));
  it("maxTimeoutSeconds 301 -> G10", () => refuses("maxTimeoutSeconds 301", "G10"));
  it("url not in paidUrls -> G11", () => refuses("url not in paidUrls", "G11"));
  it("rail A -> G1", () => refuses("rail A", "G1"));
  it("providers set and provider absent -> G8", () => refuses("providers set and provider absent", "G8"));

  it('recordedPayer differs -> G4 "payer changed; run assay-mcp enable-paid"', () => {
    expect(run("recordedPayer differs")).toMatchObject({
      ok: false,
      guard: "G4",
      reason: "payer changed; run assay-mcp enable-paid",
    });
  });

  it("never signs for the debt and next-seq endpoints (G12)", () => {
    refuses("resource is a debt endpoint", "G12");
    refuses("resource is next-seq under the API prefix", "G12");
  });
});

describe("seq.json", () => {
  it.each(seqVectors.cases.map((c) => [String(c.seq), c] as const))("seq %s", (_, c) => {
    const r = checkAll(apply(base, [{ op: "set", path: ["requirement", "seq"], value: c.seq }]));
    if (c.ok) expect(r).toEqual({ ok: true });
    else expect(r).toMatchObject({ ok: false, guard: "G9", code: "G9_SEQ" });
  });

  it("covers 2^53-1, 2^53 and 2^64-1", () => {
    const seqs = seqVectors.cases.map((c) => c.seq);
    expect(seqs).toEqual(expect.arrayContaining(["9007199254740991", "9007199254740992", "18446744073709551615"]));
  });
});

describe("fail closed", () => {
  it("refuses a context with missing parts rather than throwing", () => {
    const broken: Partial<Record<keyof GuardContext, unknown>>[] = [
      { limits: undefined },
      { limits: null },
      { paidUrls: undefined },
      { quote: { maxAmount: 5 } },
      { chain: { ...base.chain, active: "yes" } },
      { nowSeconds: Number.NaN },
      { localKey: undefined },
      { confirmation: "yes" },
      { forwardedCall: true },
      { forwardedCall: { tool: 1, at: base.nowSeconds } },
      { signed: undefined },
      { chain: { ...base.chain, delegate: undefined } },
    ];
    for (const patch of broken) {
      const r = checkAll({ ...base, ...patch } as GuardContext);
      expect(r.ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it("refuses a requirement that is not a plain object", () => {
    for (const requirement of [undefined, "B", 1, true, []]) {
      expect(checkAll({ ...base, requirement })).toMatchObject({ ok: false, guard: "G1" });
    }
  });

  it("does not mutate the context", () => {
    const ctx = structuredClone(base);
    checkAll(ctx);
    expect(ctx).toEqual(base);
  });

  it("puts no address, amount or URL from the requirement in a reason", () => {
    for (const c of cases.filter((x) => !x.expect.ok)) {
      const r = checkAll(apply(base, c.changes));
      if (r.ok) continue;
      expect(r.reason).not.toMatch(/0x[0-9a-fA-F]{6}|https?:|\/mcp\/|\/escrow/);
    }
  });
});

describe("binding (I1, I2)", () => {
  const confirmAbove = { ...base, limits: { ...base.limits, confirmAbove: "0.05" } };

  it("asks for confirmation only after every other guard passed", () => {
    expect(checkAll(confirmAbove)).toMatchObject({ ok: false, code: "G7_CONFIRMATION_REQUIRED" });
    expect(checkAll({ ...confirmAbove, paidUrls: [] })).toMatchObject({ ok: false, guard: "G11" });
  });

  it("accepts the confirmation built for this payment and no other", () => {
    const confirmation = confirmationFor(confirmAbove)!;
    expect(confirmation).toMatchObject({ tool: "weather_forecast", amount: "100000", seq: "42" });
    expect(checkAll({ ...confirmAbove, confirmation })).toEqual({ ok: true });
    const later = structuredClone(confirmAbove) as GuardContext & { requirement: { seq: string } };
    later.requirement.seq = "43";
    expect(checkAll({ ...later, confirmation })).toMatchObject({ ok: false, code: "G7_CONFIRMATION_MISMATCH" });
  });

  it("refuses a requirement for a tool other than the one forwarded", () => {
    const other = { ...base, forwardedCall: { tool: "cheap_tool", at: base.nowSeconds } };
    expect(checkAll(other)).toMatchObject({ ok: false, guard: "G12", code: "G12_OTHER_TOOL" });
  });
});

describe("guardAndBuild (M1)", () => {
  const ctx: Omit<GuardContext, "network"> = Object.fromEntries(
    Object.entries(base).filter(([k]) => k !== "network"),
  ) as Omit<GuardContext, "network">;

  it("signs exactly the guarded values with the built-in production network", () => {
    const r = guardAndBuild(ctx, base.nowSeconds, "production");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const req = base.requirement as { amount: { amount: string }; seq: string; payer: string; provider: string };
    expect(r.typedData.message.amount).toBe(BigInt(req.amount.amount));
    expect(r.typedData.message.seq).toBe(BigInt(req.seq));
    expect(r.typedData.message.payer).toBe(getAddress(req.payer.split(":")[2]!));
    expect(r.typedData.message.provider).toBe(getAddress(req.provider.split(":")[2]!));
    expect(r.typedData.domain).toMatchObject({ chainId: 46630, verifyingContract: getAddress(base.network!.escrow.split(":")[2]!) });
  });

  it("returns the guard refusal and builds nothing", () => {
    const r = guardAndBuild(apply(ctx, find("seq 2^53").changes), base.nowSeconds, "production");
    expect(r).toMatchObject({ ok: false, guard: "G9" });
  });

  it("checks the requirement against the built-in entry of the environment it signs for", () => {
    // The staging entry's escrow is still a placeholder, so nothing can be paid there.
    expect(guardAndBuild(ctx, base.nowSeconds, "staging")).toMatchObject({ ok: false, guard: "G2", code: "G2_PAY_TO" });
  });

  it("works on a frozen copy and leaves the caller's requirement alone", () => {
    const mine = structuredClone(ctx);
    guardAndBuild(mine, base.nowSeconds, "production");
    expect(Object.isFrozen(mine.requirement)).toBe(false);
    expect(mine).toEqual(ctx);
  });
});

describe("usdToAtomic", () => {
  it("converts dollars at the asset's decimals", () => {
    expect(usdToAtomic("0.50", 6)).toBe(500000n);
    expect(usdToAtomic("5", 6)).toBe(5000000n);
    expect(usdToAtomic(".5", 6)).toBe(500000n);
    expect(usdToAtomic("155", 6)).toBe(155000000n);
    expect(usdToAtomic("0.000001", 6)).toBe(1n);
  });

  it("refuses anything that is not a plain non-negative decimal", () => {
    for (const v of ["", "abc", "-1", "1e3", "0.0000001", "1.", " 1", "1,5", "0x10", "Infinity"]) {
      expect(usdToAtomic(v, 6), v).toBeNull();
    }
    expect(usdToAtomic(0.5 as unknown as string, 6)).toBeNull();
  });
});

describe("builtInNetwork", () => {
  it("returns the entry with its id, or null", () => {
    const prod = builtInDeployments().production;
    const n = builtInNetwork(prod, "eip155:46630");
    expect(n).toMatchObject({ id: "eip155:46630", decimals: 6 });
    expect(builtInNetwork(prod, "eip155:1")).toBeNull();
    expect(builtInNetwork(prod, "__proto__")).toBeNull();
    expect(builtInNetwork(prod, "toString")).toBeNull();
  });
});
