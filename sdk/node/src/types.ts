import type { Account } from "viem";

/** Options of {@link AssayClient}. */
export interface AssayClientOptions {
  /** The Assay MCP URL, e.g. `https://mcp.assay.ai/?tools=get_weather`. Production unless `dev.origins` lists its origin. */
  url: string;
  /** The API key. Required: it is the only way the SDK authenticates (R-SDK-2). */
  apiKey: string;
  /** Pays for calls by signing locally. Omit for free calls only. */
  signer?: Account;
  /** Dollars per call, e.g. `"0.50"`. Required with a signer. */
  maxPerCall?: string;
  /** Dollars per rolling 24 hours, e.g. `"5"`. Required with a signer. */
  maxPerDay?: string;
  /** Explicit allow list of MCP URLs that may be paid (replaces guard G11). */
  urls?: readonly string[];
  /** Development only: extra origins, set in code and never read from the environment or a file. */
  dev?: { origins: readonly string[] };
}

/** A tool as `listTools` returns it. */
export interface AssayTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A guard's refusal to sign a payment. */
export interface Refusal {
  guard: string;
  reason: string;
}

/** The result of `callTool`. */
export interface CallResult {
  ok: boolean;
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  /** The receipt reference the server returned with the result, when there is one. */
  receipt?: unknown;
  /** The server's error code and message when the call failed. */
  error?: { code?: string; message: string };
  /** Set when a local guard refused to pay. */
  refused?: Refusal;
}
