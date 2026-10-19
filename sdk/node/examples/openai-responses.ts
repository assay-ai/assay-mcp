// OpenAI Responses API with function calling. Run: OPENAI_MODEL=<model id> OPENAI_API_KEY=… ASSAY_API_KEY=… node examples/openai-responses.ts
import OpenAI from "openai";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AssayClient } from "../src/index.js";
import { clientFromEnv, connectFromEnv } from "./client.js";

export async function run(assay: AssayClient, openai: OpenAI = new OpenAI()): Promise<void> {
  const tools = (await assay.listTools()).map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
  let resp = await openai.responses.create({ model: process.env.OPENAI_MODEL!, input: "Weather in Lisbon?", tools });
  for (;;) {
    const calls = resp.output.filter((o) => o.type === "function_call");
    if (calls.length === 0) break;
    const outputs = await Promise.all(calls.map(async (c) => {
      const r = await assay.callTool(c.name, JSON.parse(c.arguments));
      return { type: "function_call_output" as const, call_id: c.call_id, output: JSON.stringify(r.structuredContent ?? r.content) };
    }));
    resp = await openai.responses.create({ model: process.env.OPENAI_MODEL!, previous_response_id: resp.id, input: outputs, tools });
  }
  console.log(resp.output_text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (!process.env.OPENAI_MODEL?.trim()) {
    console.error("OPENAI_MODEL is not set: put the model id you want to use in it. The example pins none.");
    process.exit(2);
  }
  const assay = clientFromEnv();
  await connectFromEnv(assay);
  try {
    await run(assay);
  } finally {
    await assay.close();
  }
}
