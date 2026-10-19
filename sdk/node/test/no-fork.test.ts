import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findForks } from "../../../scripts/check-no-fork.mjs";
import { checkSdkManifest } from "../../../scripts/check-pack.mjs";

describe("check-no-fork", () => {
  it("passes on the committed sdk source", () => {
    expect(findForks(join(import.meta.dirname, "../src"))).toEqual([]);
  });

  it("fails on a copied signer or guards directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-fork-"));
    try {
      mkdirSync(join(dir, "lib/signer"), { recursive: true });
      writeFileSync(join(dir, "guards.ts"), "");
      expect(findForks(dir).sort()).toEqual(["guards.ts", join("lib", "signer")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("check-no-fork symlinks (4.1 M9)", () => {
  it("fails on a symlink under any name", () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-fork-"));
    try {
      mkdirSync(join(dir, "real"));
      symlinkSync(join(dir, "real"), join(dir, "helpers"));
      expect(findForks(dir)).toEqual(["helpers"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("check-pack for the sdk", () => {
  it("refuses runtime dependencies", () => {
    expect(checkSdkManifest({ name: "@assay-ai/sdk", version: "0.1.0", dependencies: { viem: "2.57.3" } })).toEqual([
      "dependencies.viem is not allowed: the SDK bundles everything",
    ]);
  });
});
