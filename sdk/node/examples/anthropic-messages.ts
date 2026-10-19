// Anthropic Messages API with tool use. Run: ANTHROPIC_MODEL=<model id> ANTHROPIC_API_KEY=… ASSAY_API_KEY=… node examples/anthropic-messages.ts
import Anthropic from "@anthropic-ai/sdk";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AssayClient } from "../src/index.js";
import { clientFromEnv, connectFromEnv } from "./client.js";

export async function run(assay: AssayClient, anthropic: Anthropic = new Anthropic()): Promise<void> {
  const tools = (await assay.listTools()).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "What's the weather in Lisbon?" }];
  for (;;) {
    const msg = await anthropic.messages.create({ model: process.env.ANTHROPIC_MODEL!, max_tokens: 1024, tools, messages });
    messages.push({ role: "assistant", content: msg.content });
    const uses = msg.content.filter((b) => b.type === "tool_use");
    if (uses.length === 0) break;
    messages.push({ role: "user", content: await Promise.all(uses.map(async (u) => {
      const r = await assay.callTool(u.name, u.input as Record<string, unknown>);
      return { type: "tool_result" as const, tool_use_id: u.id, content: JSON.stringify(r.structuredContent ?? r.content), is_error: !r.ok };
    })) });
  }
  const last = messages[messages.length - 1];
  const text = Array.isArray(last?.content) ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
  console.log(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (!process.env.ANTHROPIC_MODEL?.trim()) {
    console.error("ANTHROPIC_MODEL is not set: put the model id you want to use in it. The example pins none.");
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
