import { getAddress, isAddress } from "viem";
import builtIn from "../../deployments.json" with { type: "json" };

/** Environments in the built-in table. Only `production` is used outside dev mode. */
export const ENVIRONMENTS = ["production", "staging", "e2e", "anvil"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Dev entries may list a single RPC; every other entry needs two. */
export const DEV_ENVIRONMENTS: readonly Environment[] = ["e2e", "anvil"];

export interface Network {
  escrow: string;
  asset: string;
  decimals: number;
  rpc: string[];
}

export interface Deployment {
  mcp: string;
  issuer: string;
  api: string;
  web: string;
  networks: Record<string, Network>;
}

export type Deployments = Record<Environment, Deployment>;

/** A value still to be filled from ops config at release time, e.g. `<operator RPC>`. */
export function isPlaceholder(value: string): boolean {
  return /^<[^<>]+>$/.test(value);
}

const CAIP2 = /^eip155:([1-9][0-9]*)$/;
const CAIP10 = /^eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/;
const CAIP19_ERC20 = /^eip155:([1-9][0-9]*)\/erc20:(0x[0-9a-fA-F]{40})$/;

function checksummed(address: string): boolean {
  return isAddress(address, { strict: false }) && getAddress(address) === address;
}

/** Parses a CAIP-10 account id on eip155; returns null when it is not one. */
export function parseCaip10(value: string): { chainId: number; address: string } | null {
  const m = CAIP10.exec(value);
  if (!m || !checksummed(m[2]!)) return null;
  return { chainId: Number(m[1]), address: m[2]! };
}

/** Parses a CAIP-19 ERC-20 asset id on eip155; returns null when it is not one. */
export function parseCaip19Erc20(value: string): { chainId: number; address: string } | null {
  const m = CAIP19_ERC20.exec(value);
  if (!m || !checksummed(m[2]!)) return null;
  return { chainId: Number(m[1]), address: m[2]! };
}

/** Loopback hosts an RPC may reach over plain http (as `URL.hostname` spells them). */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The SDK's rule for a usable RPC URL (`isUsableRpcUrl` in `@goassay-ai/sdk/core`, which the
 * SDK applies when it builds the network map): https, or http to a loopback host only; no
 * credentials, query or fragment. Kept identical so this check and the SDK never disagree.
 */
export function isUsableRpcUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
}

function checkUrl(errors: string[], where: string, value: unknown, allowPlaceholder: boolean): void {
  if (typeof value !== "string") {
    errors.push(`${where}: missing`);
    return;
  }
  if (isPlaceholder(value)) {
    if (!allowPlaceholder) errors.push(`${where}: placeholder ${value}`);
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${where}: not a URL`);
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") errors.push(`${where}: not http(s)`);
  if (url.username || url.password || url.search || url.hash) errors.push(`${where}: must be a bare origin or path`);
}

/**
 * Checks the shape of one entry. Placeholders are allowed (the release check refuses them
 * separately); everything that is filled in must be valid.
 */
export function validateDeployment(env: Environment, d: Deployment, allowPlaceholder = true): string[] {
  const errors: string[] = [];
  for (const key of ["mcp", "issuer", "api", "web"] as const) checkUrl(errors, `${env}.${key}`, d[key], allowPlaceholder);
  const networks = Object.entries(d.networks ?? {});
  if (networks.length === 0) errors.push(`${env}.networks: empty`);
  for (const [caip2, n] of networks) {
    const where = `${env}.networks.${caip2}`;
    const chain = CAIP2.exec(caip2);
    if (!chain) {
      errors.push(`${where}: key is not a CAIP-2 eip155 chain id`);
      continue;
    }
    const chainId = Number(chain[1]);
    // Contract placeholders are allowed only outside production: production always names its
    // escrow and asset, and the guards (G2) and the EIP-712 domain are built from them.
    const contractPlaceholderOk = allowPlaceholder && env !== "production";
    if (!(contractPlaceholderOk && isPlaceholder(n.escrow))) {
      const escrow = parseCaip10(n.escrow);
      if (!escrow) errors.push(`${where}.escrow: not a checksummed CAIP-10 account`);
      else if (escrow.chainId !== chainId) errors.push(`${where}.escrow: chain does not match ${caip2}`);
    }
    if (!(contractPlaceholderOk && isPlaceholder(n.asset))) {
      const asset = parseCaip19Erc20(n.asset);
      if (!asset) errors.push(`${where}.asset: not a checksummed CAIP-19 erc20 asset`);
      else if (asset.chainId !== chainId) errors.push(`${where}.asset: chain does not match ${caip2}`);
    }
    if (!Number.isInteger(n.decimals) || n.decimals < 0 || n.decimals > 36) errors.push(`${where}.decimals: invalid`);
    const minRpc = DEV_ENVIRONMENTS.includes(env) ? 1 : 2;
    if (!Array.isArray(n.rpc) || n.rpc.length < minRpc) errors.push(`${where}.rpc: needs at least ${minRpc}`);
    else {
      n.rpc.forEach((r, i) => {
        checkUrl(errors, `${where}.rpc[${i}]`, r, allowPlaceholder);
        // In every environment, the SDK's rule as well: http only to a loopback host.
        if (typeof r === "string" && !isPlaceholder(r) && !isUsableRpcUrl(r)) errors.push(`${where}.rpc[${i}]: must be https, or http to a loopback host`);
      });
      const filled = n.rpc.filter((r) => typeof r === "string" && !isPlaceholder(r));
      // The SDK's chain reader reads each RPC once and gives no answer for a list with a repeat.
      if (new Set(filled).size !== filled.length) errors.push(`${where}.rpc: lists the same RPC twice`);
      if (!DEV_ENVIRONMENTS.includes(env)) {
        // Outside dev: https only, and the RPCs must be different hosts, so that two agreeing
        // answers are two independent answers (chain reads, G4).
        const hosts = new Set<string>();
        for (const r of filled) {
          if (!r.startsWith("https://")) errors.push(`${where}.rpc: ${r} must be https`);
          try {
            hosts.add(new URL(r).hostname.toLowerCase());
          } catch {
            // checkUrl reported it.
          }
        }
        if (hosts.size !== filled.length) errors.push(`${where}.rpc: RPCs must be distinct hosts`);
      }
    }
  }
  return errors;
}

export function validateDeployments(table: Deployments, allowPlaceholder = true): string[] {
  const errors: string[] = [];
  for (const env of ENVIRONMENTS) {
    const d = table[env];
    if (!d) errors.push(`${env}: missing`);
    else errors.push(...validateDeployment(env, d, allowPlaceholder));
  }
  errors.push(...sharedProductionEscrows(table));
  return errors;
}

/**
 * Staging must never share production's escrow on the same chain. The EIP-712 domain is
 * (chainId, verifyingContract = escrow), so a voucher or AuthorizeDelegate signed against
 * staging would also be valid on the production escrow, and the reverse.
 */
export function sharedProductionEscrows(table: Deployments): string[] {
  const errors: string[] = [];
  const prod = table.production?.networks ?? {};
  for (const env of ENVIRONMENTS) {
    if (env === "production" || DEV_ENVIRONMENTS.includes(env)) continue;
    for (const [caip2, n] of Object.entries(table[env]?.networks ?? {})) {
      const p = prod[caip2];
      if (!p || isPlaceholder(n.escrow) || isPlaceholder(p.escrow)) continue;
      if (n.escrow.toLowerCase() === p.escrow.toLowerCase()) {
        errors.push(`${env}.networks.${caip2}.escrow: must differ from the production escrow (same EIP-712 domain)`);
      }
    }
  }
  return errors;
}

/** The warning printed on every start in dev mode. */
export function devModeWarning(env: Environment): string {
  const single = Object.values(builtInDeployments()[env].networks).some((n) => n.rpc.length < 2);
  return (
    `assay-mcp is in dev mode (${env}). Do not use it with real funds.` +
    (single ? " This entry reads the chain through a single RPC, which is allowed in dev entries only." : "")
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Frozen once at load: nothing in the process can change what the signer signs for. */
const BUILT_IN: Deployments = deepFreeze(builtIn as Deployments);

/** The built-in table bundled into `dist/cli.js`. It is the only source of hosts and RPCs. Deep-frozen. */
export function builtInDeployments(): Deployments {
  return BUILT_IN;
}
