# @goassay-ai/mcp

`assay-mcp` is a local MCP server (stdio) for [Assay](https://mcp.goassay.ai). It keeps your agent's payment key in the OS keychain and signs each payment itself within limits you set in a terminal.

Install it in Claude Code with an exact version:

```sh
claude mcp add --scope user assay -- npx -y @goassay-ai/mcp@0.2.3 --name assay
```

The canonical install commands for every client, the security model and the limits are in the [repository README](https://github.com/assay-ai/assay-mcp#readme). If a page shows a different command, trust the README.
