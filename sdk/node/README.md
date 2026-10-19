# @assay-ai/sdk

Node SDK for [Assay](https://mcp.assay.ai). It calls Assay tools with an API key over Streamable HTTP. Only the built-in origin is reachable (a development origin must be listed in `dev.origins` in code), redirects are an error, and the key is sent to pinned origins only.

```ts
import { AssayClient } from "@assay-ai/sdk";

const assay = new AssayClient({ url: "https://mcp.assay.ai/?tools=get_weather", apiKey: process.env.ASSAY_API_KEY! });
await assay.connect();
const tools = await assay.listTools(); // [{ name, description, inputSchema }]
const res = await assay.callTool("get_weather", { city: "Lisbon" }); // { ok, content, structuredContent, receipt?, error?, refused? }
await assay.close();
```

This version makes free calls only. The signer and guards are the `assay-mcp` modules, bundled in at build time and never copied.
