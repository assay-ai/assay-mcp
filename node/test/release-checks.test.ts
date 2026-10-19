import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { checkLockRuntime, checkManifest, checkPackFiles } from "../../scripts/check-pack.mjs";
import { containsUnscoped, findUnscoped } from "../../scripts/check-no-unscoped.mjs";
import { checkReleaseDeployments } from "../../scripts/check-deployments.mjs";
import { checkBundle } from "../../scripts/check-bundle.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, p), "utf8")) as Record<string, unknown>;
const pkg = readJson("node/package.json") as { version: string; dependencies: Record<string, string>; scripts: Record<string, string> };
// Built from parts so that this test file does not contain the forbidden form.
const UNSCOPED = ["npx", "-y", "assay-mcp"].join(" ");

describe("check-pack", () => {
  it("accepts the package manifest and lockfile as committed", () => {
    expect(checkManifest(pkg)).toEqual([]);
    expect(checkLockRuntime(readJson("package-lock.json"))).toEqual([]);
  });

  it('check-pack fails on "^1.2.3" and on a postinstall', () => {
    const ranged = { ...pkg, dependencies: { "@napi-rs/keyring": "^1.2.3" } };
    expect(checkManifest(ranged)).toContain('dependencies.@napi-rs/keyring is "^1.2.3", not an exact version');
    const scripted = { ...pkg, scripts: { ...pkg.scripts, postinstall: "node x.js" } };
    expect(checkManifest(scripted)).toContain('install script "postinstall" is not allowed');
  });

  it("fails on any other dependency, peer or optional dependency", () => {
    expect(checkManifest({ ...pkg, dependencies: { ...pkg.dependencies, viem: "2.57.3" } })).toContain("dependency viem is not allowed");
    expect(checkManifest({ ...pkg, optionalDependencies: { x: "1.0.0" } })).toContain("optionalDependencies.x is not allowed");
  });

  it("fails on a runtime lock entry with an install script or a range", () => {
    const lock = {
      packages: {
        "node_modules/@napi-rs/keyring": { version: "2.1.0", optionalDependencies: { "@napi-rs/keyring-linux-x64-gnu": "~2.1.0" } },
        "node_modules/@napi-rs/keyring-linux-x64-gnu": { version: "2.1.0", optional: true, hasInstallScript: true },
        "node_modules/left-pad": { version: "1.0.0" },
      },
    };
    expect(checkLockRuntime(lock)).toEqual([
      '@napi-rs/keyring depends on @napi-rs/keyring-linux-x64-gnu@"~2.1.0", not an exact version',
      "runtime package @napi-rs/keyring-linux-x64-gnu has an install script",
      "runtime package left-pad is not allowed",
    ]);
  });

  it("ships only the bundle", () => {
    expect(checkPackFiles([{ path: "package.json" }, { path: "dist/cli.js" }, { path: "README.md" }])).toEqual([]);
    expect(checkPackFiles([{ path: "package.json" }, { path: "src/cli.ts" }])).toEqual([
      "unexpected file in package: src/cli.ts",
      "dist/cli.js is missing; run the build first",
    ]);
  });
});

describe("check-no-unscoped", () => {
  it(`no tracked file contains "${UNSCOPED}"`, () => {
    expect(findUnscoped(ROOT)).toEqual([]);
  });

  it("detects the unscoped form and accepts the scoped one", () => {
    expect(containsUnscoped(`run ${UNSCOPED} add /`)).toBe(true);
    expect(containsUnscoped(UNSCOPED.replace(/ /g, "  "))).toBe(true);
    expect(containsUnscoped("npx -y @assay-ai/mcp@1.2.3")).toBe(false);
  });

  it("finds the form in a new file of a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-mcp-check-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "doc.md"), `Install: ${UNSCOPED}\n`);
      writeFileSync(join(dir, "ok.md"), "Install: npx -y @assay-ai/mcp@1.2.3\n");
      expect(findUnscoped(dir)).toEqual(["doc.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("README install commands", () => {
  it("pin @assay-ai/mcp to the package version exactly", () => {
    for (const file of ["README.md", "node/README.md"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const pins = [...text.matchAll(/@assay-ai\/mcp@([^\s"'`,\]]+)/g)].map((m) => m[1]);
      expect(pins.length, file).toBeGreaterThan(0);
      for (const v of pins) expect(v, file).toBe(pkg.version);
    }
  });
});

describe("check-deployments (release)", () => {
  const table = readJson("deployments.json") as { production: { networks: Record<string, { rpc: string[] }> } };
  const filled = () => {
    const t = structuredClone(table) as typeof table & { production: Record<string, unknown> };
    Object.assign(t.production, { api: "https://api.example.com/api/v1", web: "https://app.example.com" });
    t.production.networks["eip155:46630"]!.rpc = ["https://rpc-a.example.com", "https://rpc-b.example.net"];
    return t;
  };

  it("refuses the committed placeholders", () => {
    const errors = checkReleaseDeployments(table);
    expect(errors).toContain("production.api is a placeholder: <API from ops config>");
    expect(errors).toContain("production.networks.eip155:46630.rpc has a placeholder: <operator RPC>");
  });

  it("accepts a filled entry with 2 distinct hosts", () => {
    expect(checkReleaseDeployments(filled())).toEqual([]);
  });

  it("refuses two RPCs on one host, and a single RPC", () => {
    const same = filled();
    same.production.networks["eip155:46630"]!.rpc = ["https://rpc.example.com/a", "https://RPC.example.com/b"];
    expect(checkReleaseDeployments(same)).toEqual(["production.networks.eip155:46630.rpc needs two distinct hosts"]);
    const one = filled();
    one.production.networks["eip155:46630"]!.rpc = ["https://rpc.example.com"];
    expect(checkReleaseDeployments(one)).toEqual(["production.networks.eip155:46630.rpc needs two distinct hosts"]);
  });

  it("refuses a production network other than eip155:46630", () => {
    const extra = filled();
    extra.production.networks["eip155:1"] = { rpc: ["https://a.example.com", "https://b.example.com"] };
    expect(checkReleaseDeployments(extra)).toContain("production networks are [eip155:46630, eip155:1], expected [eip155:46630]");
  });
});

describe("check-bundle", () => {
  it("allows built-ins and the keyring only", () => {
    expect(checkBundle('import { Entry } from "@napi-rs/keyring";\nimport fs from "node:fs";\nrequire("path");')).toEqual([]);
    expect(checkBundle('const v = require("viem");')).toEqual(['require of "viem"']);
    expect(checkBundle('const v = __require("viem");')).toEqual(['require of "viem"']);
    expect(checkBundle('await import("undici");')).toEqual(['dynamic import of "undici"']);
    expect(checkBundle("require(name);")).toEqual(["non-literal require(name"]);
  });
});
