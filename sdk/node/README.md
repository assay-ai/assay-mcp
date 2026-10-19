# @assay-ai/sdk

Node SDK for [Assay](https://mcp.assay.ai). It calls Assay tools with an API key over Streamable HTTP. Only the built-in origin is reachable (a development origin must be listed in `dev.origins` in code), redirects are an error, and the key is sent to pinned origins only.

```ts
import { AssayClient, Signers } from "@assay-ai/sdk";

const signer = Signers.fromAccount(kmsAccount); // preferred: a KMS-backed viem Account

const assay = new AssayClient({
  url: "https://mcp.assay.ai/?tools=get_weather",
  apiKey: process.env.ASSAY_API_KEY!,
  signer, // omit for free calls only
  maxPerCall: "0.50", // required with a signer
  maxPerDay: "5", // required with a signer
});
await assay.connect();
await assay.bindDelegate(); // challenge + bind, idempotent
assay.enablePaidCallsUrl(); // {WEB}/agents/enable-paid?credential=…#key=… : approve the key there
const tools = await assay.listTools(); // [{ name, description, inputSchema }]
const res = await assay.callTool("get_weather", { city: "Lisbon" }); // { ok, content, structuredContent, receipt?, error?, refused? }
await assay.close();
```

## Signers

- `Signers.fromAccount(account)`: a viem `Account` whose key is in a KMS or HSM. Only its `signTypedData` is called. Use this in production.
- `Signers.fromKeychain({ profile })`: the payment key of an `assay-mcp` profile in the OS keychain, created on first use. Use a profile of its own (for example `"ci"`): a key is bound to one API key at a time. Needs `@napi-rs/keyring` installed next to the SDK; it is tested with 2.1.0.
- `Signers.fromPrivateKey(hex)`: for tests and CI only.
- `Signers.keygen()`: `{ address, privateKey }`, a fresh dedicated key. Never reuse a wallet key.

Generate a dedicated key with `Signers.keygen()` or in a KMS, never print the environment in CI, and rotate by binding a new key and approving it on the enable-paid page.

The published type declarations import types from `viem` (for example `Account`). Install `viem` in your project, or your editor will show those types as `any`.

## What is checked before a payment is signed

Every payment request runs the same local guards as `assay-mcp` (G1 to G12), on the same modules, bundled in at build time and never copied. A voucher is signed only when all of them pass, for exactly the amount, payee, asset, chain and escrow they checked, and at most once per call.

- `maxPerCall` and `maxPerDay` (dollars) are the local caps. The 24-hour total is counted in this process, per payment key; the on-chain caps you approve on the enable-paid page bound the key across processes.
- `urls` lists the MCP URLs paid calls may go through. It defaults to `[url]`.
- A signer whose address is the payer is refused.
- A refused payment comes back as `ok: false` with `refused: { guard, reason }`. Nothing was signed.

The API key and the signer's key are never shown by `console.log`, `util.inspect`, `JSON.stringify` or `String()`.

## Examples

`examples/anthropic-messages.ts` (Anthropic Messages API, tool use) and `examples/openai-responses.ts` (OpenAI Responses API, function calling) each ask a model for the weather in Lisbon and answer its tool calls through `assay.callTool`. Both run from this directory:

```sh
npm run example -- anthropic-messages   # needs ANTHROPIC_API_KEY and ANTHROPIC_MODEL
npm run example -- openai-responses     # needs OPENAI_API_KEY and OPENAI_MODEL
```

- Model ids come only from `ANTHROPIC_MODEL` and `OPENAI_MODEL`. The examples pin none: without one they exit with a message.
- `ASSAY_API_KEY` is the Assay API key (required). `ASSAY_URL` defaults to `https://mcp.assay.ai/`.
- To run against a local stack, set `ASSAY_DEV_ORIGIN` to its origin (it goes to `dev.origins` in code).
- `ASSAY_EXAMPLE_TEST_KEY` (a throwaway key, test stacks only) switches paid calls on through `Signers.fromPrivateKey`; the examples call `bindDelegate()` for it first, and it still needs the approval at `enablePaidCallsUrl()` once. Real code uses `Signers.fromAccount`.
- Nothing prints a key. Do not print the environment in CI.
