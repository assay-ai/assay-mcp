import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtInDeployments } from "@assay-core/deployments.js";
import { API_KEY, FakeAssay, type NetworkEntry } from "../../../node/test/helpers/fake-assay.js";
import { AssayClient, Signers } from "../src/index.js";
import { run as runAnthropic } from "../examples/anthropic-messages.js";
import { run as runOpenAI } from "../examples/openai-responses.js";

/**
 * The two spec §10.3 examples with a stubbed LLM loop against the fake Assay: one free call and
 * one paid call each. No network beyond loopback, no LLM key, no keychain, no real profile. The
 * real run (a live model against the e2e stack) is the CI `examples` job.
 */
const E2E_MCP = "http://localhost:3200";
const E2E_API = "http://localhost:3000";
const E2E = builtInDeployments().e2e;
const B = E2E.networks["eip155:46630"]!;
const NETWORK: NetworkEntry = { id: "eip155:46630", escrow: B.escrow, asset: B.asset, decimals: B.decimals };
const RPC = new Set(B.rpc.map((r) => new URL(r).origin));
const realFetch = globalThis.fetch;

let fake: FakeAssay;
let client: AssayClient;

beforeEach(async () => {
  fake = new FakeAssay(NETWORK);
  await fake.start();
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const base = `http://127.0.0.1:${fake.port}`;
    if (u.origin === E2E_MCP || u.origin === E2E_API) return realFetch(`${base}${u.pathname}${u.search}`, init);
    if (RPC.has(u.origin)) return realFetch(`${base}/__rpc`, init);
    throw new TypeError(`no network in tests: ${u.origin}`);
  }) as typeof fetch);
  const pk = generatePrivateKey();
  const address = getAddress(privateKeyToAccount(pk).address);
  fake.delegate = address;
  fake.grant(address);
  client = new AssayClient({ url: `${E2E_MCP}/`, apiKey: API_KEY, dev: { origins: [E2E_MCP] }, signer: Signers.fromPrivateKey(pk), maxPerCall: "0.50", maxPerDay: "5" });
  await client.connect();
  vi.stubEnv("ANTHROPIC_MODEL", "test-model");
  vi.stubEnv("OPENAI_MODEL", "test-model");
});

afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fake.stop();
});

const logged = () => vi.spyOn(console, "log").mockImplementation(() => {});

describe("anthropic-messages example", () => {
  it("completes a free call and a paid call through the tool-use loop", async () => {
    const out = logged();
    const turns = [
      [{ type: "tool_use", id: "t1", name: "echo", input: { a: 1 } }],
      [{ type: "tool_use", id: "t2", name: "weather", input: { city: "Lisbon" } }],
      [{ type: "text", text: "done" }],
    ];
    const seenResults: unknown[] = [];
    const stub = {
      messages: {
        create: vi.fn(async (p: { messages: { content: unknown }[]; tools: { name: string; input_schema: unknown }[] }) => {
          expect(p.tools.map((t) => t.name).sort()).toEqual(["echo", "owe", "weather"]);
          const last = p.messages[p.messages.length - 1]!.content;
          if (Array.isArray(last) && last[0]?.type === "tool_result") seenResults.push(last[0]);
          return { content: turns.shift()! };
        }),
      },
    };
    await runAnthropic(client, stub as never);
    expect(stub.messages.create).toHaveBeenCalledTimes(3);
    expect(seenResults).toHaveLength(2);
    expect(seenResults.every((r) => (r as { is_error: boolean }).is_error === false)).toBe(true);
    expect(fake.accepted).toHaveLength(1);
    expect(out).toHaveBeenCalledWith("done");
  });
});

describe("openai-responses example", () => {
  it("completes a free call and a paid call through the function-calling loop", async () => {
    const out = logged();
    const responses = [
      { id: "r1", output: [{ type: "function_call", call_id: "c1", name: "echo", arguments: "{}" }] },
      { id: "r2", output: [{ type: "function_call", call_id: "c2", name: "weather", arguments: '{"city":"Lisbon"}' }] },
      { id: "r3", output: [{ type: "message" }], output_text: "done" },
    ];
    const inputs: unknown[] = [];
    const stub = {
      responses: {
        create: vi.fn(async (p: { input: unknown }) => {
          inputs.push(p.input);
          return responses.shift()!;
        }),
      },
    };
    await runOpenAI(client, stub as never);
    expect(stub.responses.create).toHaveBeenCalledTimes(3);
    expect(fake.accepted).toHaveLength(1);
    expect(JSON.stringify(inputs[2])).toContain("sunny");
    expect(out).toHaveBeenCalledWith("done");
  });
});
