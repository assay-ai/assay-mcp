import { describe, expect, it } from "vitest";
import {
  ENVIRONMENTS,
  builtInDeployments,
  devModeWarning,
  isPlaceholder,
  parseCaip10,
  parseCaip19Erc20,
  sharedProductionEscrows,
  validateDeployment,
  validateDeployments,
  type Deployment,
} from "../src/deployments.js";
import { sdkNetworkErrors } from "../src/guards/sign.js";

const table = builtInDeployments();
const ESCROW = "eip155:46630:0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f";
const STAGING_ESCROW = "eip155:46630:0x343606d8Db3872EEC5Ea56cb43b9F4606Bfdf71f";
const PROD_ESCROW = "eip155:46630:0xE68A6E2810027dB5da48c2110bd3993eD8177115";
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
    expect(table.production.mcp).toBe("https://mcp.goassay.ai");
    expect(table.production.issuer).toBe("https://mcp.goassay.ai");
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

  it("production and staging each have their own 46630 escrow; e2e and anvil share the local fixture escrow; all use the same asset", () => {
    expect(table.production.networks["eip155:46630"]!.escrow).toBe(PROD_ESCROW);
    expect(table.staging.networks["eip155:46630"]!.escrow).toBe(STAGING_ESCROW);
    for (const env of ["e2e", "anvil"] as const) {
      expect(table[env].networks["eip155:46630"]!.escrow).toBe(ESCROW);
    }
    for (const env of ENVIRONMENTS) expect(table[env].networks["eip155:46630"]!.asset).toBe(ASSET);
  });

  it("has no placeholder left in any entry", () => {
    expect(validateDeployments(table, false)).toEqual([]);
  });

  // Same chain id and same verifyingContract (the escrow) mean the same EIP-712 domain: a
  // voucher or AuthorizeDelegate signed for staging would also be valid on production.
  it("staging and production escrows must differ", () => {
    expect(table.staging.networks["eip155:46630"]!.escrow).not.toBe(table.production.networks["eip155:46630"]!.escrow);
    const shared = structuredClone(table);
    shared.staging.networks["eip155:46630"]!.escrow = PROD_ESCROW;
    expect(sharedProductionEscrows(shared)).toEqual([
      "staging.networks.eip155:46630.escrow: must differ from the production escrow (same EIP-712 domain)",
    ]);
    expect(validateDeployments(shared)).toContain(
      "staging.networks.eip155:46630.escrow: must differ from the production escrow (same EIP-712 domain)",
    );
    const distinct = structuredClone(table);
    distinct.staging.networks["eip155:46630"]!.escrow = "eip155:46630:0x000000000000000000000000000000000000dEaD";
    expect(sharedProductionEscrows(distinct)).toEqual([]);
    expect(sharedProductionEscrows(table)).toEqual([]);
  });

  it("accepts contract placeholders outside production only", () => {
    const prod = structuredClone(table.production);
    prod.networks["eip155:46630"]!.escrow = "<escrow>";
    prod.networks["eip155:46630"]!.asset = "<asset>";
    expect(validateDeployment("production", prod)).toEqual([
      "production.networks.eip155:46630.escrow: not a checksummed CAIP-10 account",
      "production.networks.eip155:46630.asset: not a checksummed CAIP-19 erc20 asset",
    ]);
    const staging = structuredClone(table.staging);
    staging.networks["eip155:46630"]!.escrow = "<escrow>";
    staging.networks["eip155:46630"]!.asset = "<asset>";
    expect(validateDeployment("staging", staging)).toEqual([]);
    expect(validateDeployment("staging", staging, false).some((e) => e.includes("escrow"))).toBe(true);
  });

  it("production rpc has 2 distinct hosts", () => {
    const rpc = table.production.networks["eip155:46630"]!.rpc;
    expect(rpc).toHaveLength(2);
    expect(rpc.every((r) => r.startsWith("https://") && !isPlaceholder(r))).toBe(true);
    expect(new Set(rpc.map(hostOf)).size).toBe(2);
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

  it("outside dev, RPCs must be https on distinct hosts; dev entries may use loopback http", () => {
    const withRpc = (d: Deployment, rpc: string[]): Deployment => ({
      ...d,
      networks: { "eip155:46630": { ...d.networks["eip155:46630"]!, rpc } },
    });
    for (const env of ["production", "staging"] as const) {
      const where = `${env}.networks.eip155:46630.rpc`;
      expect(validateDeployment(env, withRpc(table[env], ["https://a.example.com", "http://localhost:8547"]))).toContain(
        `${where}: http://localhost:8547 must be https`,
      );
      expect(
        validateDeployment(env, withRpc(table[env], ["https://rpc.example.com/a", "https://RPC.example.com/b"])),
      ).toContain(`${where}: RPCs must be distinct hosts`);
      expect(
        validateDeployment(env, withRpc(table[env], ["https://a.example.com", "https://b.example.org"])).filter((e) =>
          e.startsWith(where),
        ),
      ).toEqual([]);
    }
    expect(validateDeployment("anvil", table.anvil)).toEqual([]);
  });
});

describe("deployments: mcp and SDK agree", () => {
  const withRpc = (env: "e2e" | "anvil" | "staging", rpc: string[]) => {
    const t = structuredClone(table);
    t[env].networks["eip155:46630"]!.rpc = rpc;
    return t;
  };

  it("the built-in table passes the SDK as well", () => {
    expect(sdkNetworkErrors(table)).toEqual([]);
  });

  it("an RPC the SDK refuses is refused by validateDeployments too, in every environment", () => {
    for (const bad of [
      "http://rpc.example.com",
      "http://rpc.internal.example:8545",
      "https://user:pass@rpc.example.com",
      "https://rpc.example.com/?key=x",
      "https://rpc.example.com/#x",
      "ws://localhost:8545",
    ]) {
      const t = withRpc("e2e", [bad]);
      expect(sdkNetworkErrors(t).length, bad).toBeGreaterThan(0);
      expect(validateDeployments(t).some((e) => e.startsWith("e2e.networks.eip155:46630.rpc")), bad).toBe(true);
    }
    for (const ok of ["http://127.0.0.1:8547", "http://localhost:8547", "http://[::1]:8547", "https://rpc.example.com/v1"]) {
      const t = withRpc("anvil", [ok]);
      expect(sdkNetworkErrors(t), ok).toEqual([]);
      expect(validateDeployments(t), ok).toEqual([]);
    }
  });

  it("refuses the same RPC listed twice", () => {
    expect(validateDeployments(withRpc("e2e", ["http://localhost:8547", "http://localhost:8547"]))).toContain(
      "e2e.networks.eip155:46630.rpc: lists the same RPC twice",
    );
  });

  it("names the environment and the entry the SDK refuses", () => {
    const t = withRpc("staging", ["<operator RPC>", "<public RPC>"]);
    expect(validateDeployments(t)).toEqual([]);
    expect(sdkNetworkErrors(t)).toEqual(["staging: networks.eip155:46630.rpcUrls must list at least one https RPC URL"]);
  });
});

describe("CAIP parsing", () => {
  it("refuses wrong forms and bad checksums", () => {
    expect(parseCaip10("0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f")).toBeNull();
    expect(parseCaip10("eip155:46630:0x1edb0e45747cfef778bdb4f4418319efc0dd814")).toBeNull();
    expect(parseCaip10("eip155:46630:0x1eDb0E45747cfEf778bDB4f4418319efc0DD814F")).toBeNull();
    expect(parseCaip19Erc20("eip155:46630:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3")).toBeNull();
    expect(parseCaip19Erc20("eip155:46630/erc721:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3")).toBeNull();
  });

  it("refuses an escrow on another chain than its network key", () => {
    const d = structuredClone(table.e2e);
    d.networks["eip155:46630"]!.escrow = "eip155:1:0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f";
    expect(validateDeployment("e2e", d)).toContain("e2e.networks.eip155:46630.escrow: chain does not match eip155:46630");
  });

  it("treats only <...> values as placeholders", () => {
    expect(isPlaceholder("<operator RPC>")).toBe(true);
    expect(isPlaceholder("https://example.com")).toBe(false);
    const prod = structuredClone(table.production);
    prod.networks["eip155:46630"]!.rpc = ["<operator RPC>", "<public RPC>"];
    expect(validateDeployment("production", prod, false).some((e) => e.includes("placeholder"))).toBe(true);
    expect(validateDeployment("production", table.production, false)).toEqual([]);
  });
});
