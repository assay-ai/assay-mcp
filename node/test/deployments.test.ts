import { describe, expect, it } from "vitest";
import {
  ENVIRONMENTS,
  builtInDeployments,
  devModeWarning,
  isPlaceholder,
  parseCaip10,
  parseCaip19Erc20,
  validateDeployment,
  validateDeployments,
  type Deployment,
} from "../src/deployments.js";

const table = builtInDeployments();
const ESCROW = "eip155:46630:0x1D2625efD87c2fc10b8563f3F0890072845Fcf41";
const ASSET = "eip155:46630/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3";

function hostOf(url: string): string {
  return new URL(url).hostname;
}

describe("deployments.json", () => {
  it("has every environment and a valid shape", () => {
    expect(Object.keys(table).sort()).toEqual([...ENVIRONMENTS].sort());
    expect(validateDeployments(table)).toEqual([]);
  });

  it("production lists only eip155:46630", () => {
    expect(Object.keys(table.production.networks)).toEqual(["eip155:46630"]);
  });

  it("production MCP and issuer are the public host", () => {
    expect(table.production.mcp).toBe("https://mcp.assay.ai");
    expect(table.production.issuer).toBe("https://mcp.assay.ai");
  });

  it("every escrow is CAIP-10 and asset CAIP-19", () => {
    for (const env of ENVIRONMENTS) {
      for (const [caip2, n] of Object.entries(table[env].networks)) {
        const chainId = Number(caip2.split(":")[1]);
        expect(parseCaip10(n.escrow), `${env} escrow`).toMatchObject({ chainId });
        expect(parseCaip19Erc20(n.asset), `${env} asset`).toMatchObject({ chainId });
        expect(n.decimals).toBe(6);
      }
    }
  });

  it("uses the 46630 escrow and asset everywhere", () => {
    for (const env of ENVIRONMENTS) {
      const n = table[env].networks["eip155:46630"]!;
      expect(n.escrow).toBe(ESCROW);
      expect(n.asset).toBe(ASSET);
    }
  });

  it("production rpc has 2 distinct hosts", () => {
    const rpc = table.production.networks["eip155:46630"]!.rpc;
    expect(rpc).toHaveLength(2);
    expect(new Set(rpc).size).toBe(2);
    // Until ops config fills them in, both are placeholders, and the release check refuses
    // them (release-checks.test.ts). Filled-in values must name two different hosts.
    const filled = rpc.filter((r) => !isPlaceholder(r));
    expect(new Set(filled.map(hostOf)).size).toBe(filled.length);
  });

  it("e2e and anvil are the local stack values", () => {
    const local = { mcp: "http://localhost:3200", issuer: "http://localhost:3200", api: "http://localhost:3000/api/v1", web: "http://localhost:4000" };
    expect(table.e2e).toMatchObject(local);
    expect(table.anvil).toMatchObject(local);
    expect(table.e2e.networks["eip155:46630"]!.rpc).toEqual(["https://rpc.testnet.chain.robinhood.com"]);
    expect(table.anvil.networks["eip155:46630"]!.rpc).toEqual(["http://127.0.0.1:8547", "http://localhost:8547"]);
  });

  it("allows a single RPC in dev entries only, and the dev warning says so", () => {
    const one = (d: Deployment): Deployment => ({
      ...d,
      networks: { "eip155:46630": { ...d.networks["eip155:46630"]!, rpc: ["https://rpc.example.com"] } },
    });
    expect(validateDeployment("e2e", one(table.e2e))).toEqual([]);
    expect(validateDeployment("staging", one(table.staging))).toContain("staging.networks.eip155:46630.rpc: needs at least 2");
    expect(validateDeployment("production", one(table.production))).toContain("production.networks.eip155:46630.rpc: needs at least 2");
    expect(devModeWarning("e2e")).toMatch(/single RPC.*dev entries only/);
    expect(devModeWarning("anvil")).not.toMatch(/single RPC/);
  });
});

describe("CAIP parsing", () => {
  it("refuses wrong forms and bad checksums", () => {
    expect(parseCaip10("0x1D2625efD87c2fc10b8563f3F0890072845Fcf41")).toBeNull();
    expect(parseCaip10("eip155:46630:0x1d2625efd87c2fc10b8563f3f0890072845fcf4")).toBeNull();
    expect(parseCaip10("eip155:46630:0x1D2625efD87c2fc10b8563f3F0890072845FCF41")).toBeNull();
    expect(parseCaip19Erc20("eip155:46630:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3")).toBeNull();
    expect(parseCaip19Erc20("eip155:46630/erc721:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3")).toBeNull();
  });

  it("refuses an escrow on another chain than its network key", () => {
    const d = structuredClone(table.e2e);
    d.networks["eip155:46630"]!.escrow = "eip155:1:0x1D2625efD87c2fc10b8563f3F0890072845Fcf41";
    expect(validateDeployment("e2e", d)).toContain("e2e.networks.eip155:46630.escrow: chain does not match eip155:46630");
  });

  it("treats only <...> values as placeholders", () => {
    expect(isPlaceholder("<operator RPC>")).toBe(true);
    expect(isPlaceholder("https://example.com")).toBe(false);
    expect(validateDeployment("production", table.production, false).some((e) => e.includes("placeholder"))).toBe(true);
  });
});
