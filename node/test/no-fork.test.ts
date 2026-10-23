import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findForks, findForksIn } from "../../scripts/check-no-fork.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

describe("no local copy of the SDK's payment core", () => {
  it("node/src defines no guard, voucher builder or EIP-712 type of its own", () => {
    expect(findForks(resolve(ROOT, "node/src"), ROOT)).toEqual([]);
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

  it("allows using the SDK's exports and naming refusal codes", () => {
    for (const line of [
      'import { checkAll, guardAndBuild as coreGuardAndBuild } from "@goassay-ai/sdk/core";',
      'return { kind: "refused", guard: "G5", code: "G5_DELEGATE_MISMATCH", reason: "x" };',
      "export function guardAndBuild(ctx, issuedAt, env) {",
    ]) {
      expect(findForksIn(line), line).toEqual([]);
    }
  });
});
