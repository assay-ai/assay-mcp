import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findForks, findForksIn, findForksInRepo } from "../../scripts/check-no-fork.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A throwaway repo root holding `files` (path → text). */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "no-fork-"));
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("no local copy of the SDK's payment core", () => {
  it("node/src and scripts/ define no guard, voucher builder or EIP-712 type of their own", () => {
    expect(findForksInRepo(ROOT)).toEqual([]);
  });

  it.each([
    "function g4(ctx: GuardContext) {",
    "export function checkAll(ctx) {",
    "export const REFUSAL_CODES = {",
    '  G4_PAYER_CHANGED: "G4",',
    "export function buildVoucherFor(req, at, net) {",
    "export function checkBindingChallenge(c, ctx) {",
    'const DOMAIN = "Assay Settlement";',
    '{ name: "resourceHash", type: "bytes32" },',
    '  primaryType: "DelegateBinding",',
    "export const VOUCHER_TYPES = {",
  ])("catches %s", (line) => {
    expect(findForksIn(line).length).toBeGreaterThan(0);
  });

  it.each([
    ["an arrow function in a const", "const g4 = (ctx: GuardContext) => null;"],
    ["an arrow function with one bare parameter", "export const g12 = ctx =>\n  ctx.ok;"],
    ["a class method", "class Guards {\n  g4(ctx: GuardContext): Refusal | null {\n    return null;\n  }\n}"],
    ["a static async class method", "class Guards { static async checkAll(ctx) { return ok; } }"],
    ["a class field holding a function", "class Guards {\n  private g7 = (ctx) => null;\n}"],
    ["an object method", "const guards = {\n  confirmationFor(req) {\n    return null;\n  },\n};"],
    ["an object property holding a function", "export default { usdToAtomic: function (v) { return 0n; } };"],
    ["a generic function", "export function checkAll<T extends object>(ctx: T) {"],
    ["a line break before the parenthesis", "export function checkAll\n  (ctx) {"],
    ["a line break after the name of a builder", "function buildVoucher\n(\n  req,\n) {"],
    ["an EIP-712 type split across lines", '{\n  name:\n    "resourceHash",\n  type: "bytes32",\n}'],
    ["an EIP-712 type with quoted keys", '{ "name" : "requestHash" , "type" : "bytes32" }'],
    ["an EIP-712 type with type first", '{ type: "uint64", name: "expiresAt" }'],
    ["a primary type split across lines", "primaryType\n  :\n  'Voucher'"],
    ["a domain name built from two literals", 'const name = "Assay " + "Settlement";'],
    ["a domain name built across lines", "const name = 'GoAssay Agent' +\n  ` Binding`;"],
    ["a refusal code split across lines", 'const codes = {\n  "G4_PAYER_CHANGED"\n    : "G4",\n};'],
    ["a type table split across lines", "export const DELEGATE_BINDING_TYPES\n  =\n  {};"],
  ])("catches %s", (_what, text) => {
    expect(findForksIn(text).length, text).toBeGreaterThan(0);
  });

  it("allows using the SDK's exports and naming refusal codes", () => {
    for (const line of [
      'import { checkAll, guardAndBuild as coreGuardAndBuild } from "@goassay-ai/sdk/core";',
      'return { kind: "refused", guard: "G5", code: "G5_DELEGATE_MISMATCH", reason: "x" };',
      "export function guardAndBuild(ctx, issuedAt, env) {",
      "const result = checkAll({ ...ctx, requirement, network }, opts);\nif (!result.ok) {\n  return result;\n}",
      "if (g4(ctx)) {\n  return refuse();\n}",
      "const value = usdToAtomic(limit, 6);",
    ]) {
      expect(findForksIn(line), line).toEqual([]);
    }
  });

  it.each(["tsx", "jsx", "mts", "cts", "mjs", "cjs"])("scans .%s files", (ext) => {
    const root = repo({ [`node/src/ui/guards.${ext}`]: "export function g4(ctx) { return null; }\n", "scripts/ok.mjs": "export {};\n" });
    expect(findForksInRepo(root)).toEqual([`node/src/ui/guards.${ext}: guard function`]);
  });

  it("scans scripts/ as well as node/src, but not itself", () => {
    const root = repo({
      "scripts/sign-helper.mjs": 'export const DOMAIN = { name: "Assay Settlement" };\n',
      "scripts/check-no-fork.mjs": 'const DOMAIN = "Assay Settlement";\n',
      "node/src/ok.ts": "export const x = 1;\n",
    });
    expect(findForksInRepo(root)).toEqual(["scripts/sign-helper.mjs: EIP-712 domain name"]);
  });

  it.skipIf(process.platform === "win32")("refuses a symbolic link instead of skipping it", () => {
    const outside = repo({ "core/guards.ts": "export function checkAll(ctx) {}\n" });
    const root = repo({ "node/src/ok.ts": "export const x = 1;\n" });
    symlinkSync(join(outside, "core"), join(root, "node/src/core"));
    symlinkSync(join(outside, "core/guards.ts"), join(root, "node/src/guards.ts"));
    expect(findForks(join(root, "node/src"), root).sort()).toEqual([
      "node/src/core: symbolic link (not followed; not allowed here)",
      "node/src/guards.ts: symbolic link (not followed; not allowed here)",
    ]);
  });
});
