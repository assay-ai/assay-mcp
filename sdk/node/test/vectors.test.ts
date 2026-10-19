import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it, vi } from "vitest";
import bindingVectors from "../../../vectors/binding.json" with { type: "json" };
import guardVectors from "../../../vectors/guards.json" with { type: "json" };
import lockVectors from "../../../vectors/lock-protocol.json" with { type: "json" };
import seqVectors from "../../../vectors/seq.json" with { type: "json" };
import voucherVectors from "../../../vectors/vouchers.json" with { type: "json" };
import { builtInDeployments, type Environment } from "@assay-core/deployments.js";
import type { GuardContext } from "@assay-core/guards/types.js";
import { DEFAULT_TIMEOUT_MS, HEARTBEAT_MS, LOCK_DIR_SUFFIX, OWNER_FILE, RECLAIM_SUFFIX, RETRY_MS, STALE_MS } from "@assay-core/profile/lock.js";
import { BindError, bindDelegateKey } from "@assay-core/proxy/delegate-bind.js";
import { checkBindingChallenge } from "@assay-core/signer/binding.js";
import { buildVoucher, type VoucherRequirement } from "@assay-core/signer/voucher.js";
import { guardVoucher } from "../src/paid.js";
import { resolveSigner, Signers } from "../src/signers.js";

/**
 * R-SDK-7: the SDK passes every file in `vectors/`, through the code the SDK runs: its guard step
 * (`guardVoucher`), its signers and the shared binding flow. A new vector file fails here until
 * it is listed below.
 */

const VECTORS_DIR = fileURLToPath(new URL("../../../vectors/", import.meta.url));
const SDK_VECTORS = ["binding.json", "guards.json", "lock-protocol.json", "seq.json", "vouchers.json"];
/** `assay-mcp`-only subjects: the SDK installs nothing into MCP clients and names no MCP server. */
const NOT_SDK = { "commands.json": "install commands of the MCP clients", "server-names.json": "MCP server names and tool aliases" };

type Path = (string | number)[];
interface Change {
  op: string;
  path: Path;
  value?: unknown;
}

function apply<T>(source: T, changes: Change[]): T {
  const copy = structuredClone(source) as Record<string | number, unknown>;
  for (const { op, path, value } of changes) {
    let node = copy;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
    const last = path[path.length - 1]!;
    if (op === "delete") delete node[last];
    else if (op === "set") node[last] = structuredClone(value);
    else throw new Error(`unknown op ${op}`);
  }
  return copy as T;
}

/** Integers given as decimal strings in the vectors, as the typed data takes them. */
function typed(t: Record<string, unknown>): never {
  const message = { ...(t.message as Record<string, unknown>) };
  for (const k of ["amount", "seq", "issuedAt", "expiresAt"]) if (typeof message[k] === "string") message[k] = BigInt(message[k] as string);
  return { ...t, message } as never;
}

const PRODUCTION: Environment = "production";
const base = guardVectors.base as unknown as GuardContext;

/**
 * The SDK's guard step on a vector context; `{ok}` or the refusal, as the vector states it. The
 * SDK takes no `network` input: it is always the built-in entry for the requirement's network. A
 * vector whose table has no entry (`network: null`) is therefore run as a requirement on a
 * network the built-in table does not have.
 */
function sdkGuards(ctx: GuardContext) {
  const { network, ...rest } = ctx;
  if (network === null) rest.requirement = { ...(rest.requirement as Record<string, unknown>), network: "eip155:1" };
  const r = guardVoucher(rest, ctx.nowSeconds, PRODUCTION);
  return r.ok ? { ok: true } : { ok: false, guard: r.guard, code: r.code, reason: r.reason };
}

describe("every vector file is covered", () => {
  it("lists each file in vectors/", () => {
    const files = readdirSync(VECTORS_DIR).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual([...SDK_VECTORS, ...Object.keys(NOT_SDK)].sort());
  });
});

describe("guards.json through the SDK's guard step", () => {
  const cases = guardVectors.cases as unknown as { guard: string; name: string; changes: Change[]; expect: { ok: boolean; guard?: string; code?: string; reason?: string } }[];
  it.each(cases.map((c) => [`${c.guard} ${c.name}`, c] as const))("%s", (_, c) => {
    const result = sdkGuards(apply(base, c.changes));
    if (c.expect.ok) return void expect(result).toEqual({ ok: true });
    expect({ ok: result.ok, guard: result.guard, code: result.code }).toEqual({ ok: false, guard: c.expect.guard, code: c.expect.code });
    if (c.expect.reason !== undefined) expect(result.reason).toBe(c.expect.reason);
  });
});

describe("seq.json through the SDK's guard step", () => {
  it.each(seqVectors.cases.map((c) => [c.seq, c] as const))("seq %s", (_, c) => {
    const result = sdkGuards(apply(base, [{ op: "set", path: ["requirement", "seq"], value: c.seq }]));
    expect(result.ok ? { ok: true } : { ok: false, guard: result.guard, code: result.code }).toEqual(c.ok ? { ok: true } : { ok: false, guard: "G9", code: "G9_SEQ" });
  });
});

describe("vouchers.json through the SDK signer", () => {
  let builtInCases = 0;
  afterAll(() => expect(builtInCases).toBe(2));
  const signer = Signers.fromPrivateKey(voucherVectors.testKey.privateKey as Hex);
  it.each(voucherVectors.cases.map((c) => [c.name, c] as const))("%s", async (_, c) => {
    const account = await resolveSigner(signer, PRODUCTION);
    expect(account.address).toBe(voucherVectors.testKey.address);
    const data = typed(c.typedData as Record<string, unknown>);
    expect(hashTypedData(data)).toBe(c.digest);
    expect(await account.signTypedData(data)).toBe(c.signature);
    // Cases on the built-in escrow: the voucher the SDK's path builds is exactly the vector's.
    const net = c.network as { caip2: string; escrow: string };
    if (builtInDeployments().production.networks[net.caip2]?.escrow === net.escrow) {
      builtInCases++;
      const built = buildVoucher(c.requirement as unknown as VoucherRequirement, c.issuedAt, PRODUCTION);
      expect(hashTypedData(built.typedData)).toBe(c.digest);
      expect(built.wire).toEqual(c.wire);
    }
  });
});

describe("binding.json through the shared binding flow and the SDK signer", () => {
  const ctx = bindingVectors.context;
  const local = privateKeyToAccount(bindingVectors.testKey.privateKey as Hex);

  /** The SDK's binding: a stub API answering `challenge`, the KMS-style signer, and a spy. */
  async function bindWith(challenge: unknown) {
    const signTypedData = vi.fn(local.signTypedData);
    const answer = { data: { credentialId: ctx.credentialId, delegate: `${ctx.network}:${local.address}` } };
    const api = vi.fn(async (_m: string, path: string) =>
      path.endsWith("/challenge") ? { body: { data: challenge }, date: new Date(ctx.nowSeconds * 1000).toUTCString() } : { body: answer, date: null },
    );
    const run = bindDelegateKey({
      account: { address: local.address, signTypedData: signTypedData as never },
      api,
      environment: ctx.environment as Environment,
      network: ctx.network,
      credentialId: ctx.credentialId,
      now: () => ctx.nowSeconds * 1000,
    });
    return { run, signTypedData, api };
  }

  it.each(bindingVectors.valid.map((c) => [c.name, c] as const))("valid %s", async (_, c) => {
    const signer = Signers.fromPrivateKey(bindingVectors.testKey.privateKey as Hex);
    const account = await resolveSigner(signer, PRODUCTION);
    const data = checkBindingChallenge(c.challenge, { ...ctx, environment: ctx.environment as Environment });
    expect(hashTypedData(data)).toBe(c.digest);
    expect(await account.signTypedData(data)).toBe(c.signature);
    const { run, signTypedData } = await bindWith(c.challenge);
    await run;
    expect(await signTypedData.mock.results[0]!.value).toBe(c.signature);
  });

  it.each(bindingVectors.invalid.map((c) => [c.name, c] as const))("invalid %s: refused, nothing signed", async (_, c) => {
    const challenge = apply(bindingVectors.valid[0]!.challenge, [{ op: c.op, path: c.path as Path, value: (c as { value?: unknown }).value }]);
    const { run, signTypedData, api } = await bindWith(challenge);
    await expect(run).rejects.toBeInstanceOf(BindError);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(api.mock.calls.every(([, path]) => path.endsWith("/challenge"))).toBe(true);
  });
});

describe("lock-protocol.json: the lock the keychain signer takes is the shared module's", () => {
  it("uses the vector's names and timings", () => {
    expect(lockVectors.lockDir).toBe(`profiles/{profile}${LOCK_DIR_SUFFIX}`);
    expect(lockVectors.reclaimDir).toBe(`profiles/{profile}${LOCK_DIR_SUFFIX}${RECLAIM_SUFFIX}`);
    expect(lockVectors.ownerFile).toBe(OWNER_FILE);
    expect([lockVectors.heartbeatMs, lockVectors.staleMs, lockVectors.retryMs, lockVectors.timeoutMs]).toEqual([HEARTBEAT_MS, STALE_MS, RETRY_MS, DEFAULT_TIMEOUT_MS]);
  });
});
