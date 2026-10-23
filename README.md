# assay-mcp

`assay-mcp` is a local MCP server (stdio) that connects your AI app to [Assay](https://mcp.goassay.ai). It runs on your computer, keeps your agent's payment key in the OS keychain, and signs each payment itself within limits you set in a terminal. Assay's servers never hold a key that can sign a payment.

npm package: **`@goassay-ai/mcp`**. The binary is `assay-mcp`.

> **Status:** pre-release. The package is not published to npm yet. The commands below show the canonical form. Each command pins an exact version.

## Install

Every command pins `@goassay-ai/mcp` to an exact version. Do not run an unpinned or unscoped form, and do not trust a page that shows a different command from this README.

These examples connect the default URL `/`, under the server name `assay`. For another URL, add `--url <url>` and use its server name, for example `--url /c/weather --name assay-weather`.

| Client | Command |
|---|---|
| Claude Code | `claude mcp add --scope user assay -- npx -y @goassay-ai/mcp@0.2.0 --name assay` |
| Codex CLI | `codex mcp add assay -- npx -y @goassay-ai/mcp@0.2.0 --name assay` |
| Gemini CLI | `gemini mcp add --scope user assay npx -y @goassay-ai/mcp@0.2.0 --name assay` |
| VS Code | `code --add-mcp '{"name":"assay","type":"stdio","command":"npx","args":["-y","@goassay-ai/mcp@0.2.0","--name","assay"]}'` |

**Cursor** (`~/.cursor/mcp.json`), **Windsurf** (`~/.config/devin/mcp_config.json`) and **Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "assay": {
      "command": "npx",
      "args": ["-y", "@goassay-ai/mcp@0.2.0", "--name", "assay"]
    }
  }
}
```

To install any URL into any client and also allow it for paid calls, run this in a terminal:

```sh
npx -y @goassay-ai/mcp@0.2.0 add /c/weather --client claude-code
```

Client ids: `claude-code`, `codex`, `cursor`, `vscode`, `windsurf`, `gemini`, `claude-desktop`.

Node.js 20 or newer is required.

### Free-only remote connection

Hosted apps (claude.ai, ChatGPT and Claude Desktop connectors) connect to `https://mcp.goassay.ai/?free=1` with OAuth. They can use free tools only. Paid calls need `assay-mcp` on your computer.

## How it works

1. **Sign in.** On first use, the app shows one tool, `assay_sign_in`. Calling it opens your browser to approve this app for your Assay agent. The tokens are stored in the OS keychain. If the sign-in is later ended on the Assay website (or expires), `assay-mcp` does not open your browser by itself: tool calls answer with a sign-in link and the command to run in a terminal, `npx -y @goassay-ai/mcp@0.2.0 login` (add `--profile <name>` for a named profile). The tools come back once you sign in again, without restarting the app.
2. **Free calls** are forwarded to Assay as they are.
3. **First paid call.** `assay-mcp` creates a payment key on this computer, registers it with your agent, and shows a link and the key's fingerprint (for example `1A2B 9F3C`). Open the link, check that the page shows the same fingerprint, and approve the limits with your wallet.
4. **Later paid calls.** `assay-mcp` checks every payment request against its local guards, then signs it. It signs at most one payment per tool call.

## Security model

- **The key stays here.** The payment key is created on this computer and stored only in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). It is never sent anywhere, printed or logged. Without a keychain, `assay-mcp` refuses to start.
- **Plain statement:** Any program you run as your user can use this key, within its limits. On macOS the keychain item's access list names the `node` binary, so other Node scripts can read it without a prompt. After a Node upgrade, macOS asks again; choose carefully before clicking "Always Allow". On Linux and Windows, an unlocked store gives the item to any process of your user.
- **Local guards.** Before signing, `assay-mcp` checks that the payment goes to the built-in escrow contract, in the built-in asset, on a built-in network; that the amount is no more than the quoted price; and that it is within your on-chain limits (read from two RPC endpoints that must agree) and your local limits. A refused payment is never signed.
- **Built-in hosts.** The MCP, API, web and RPC addresses come only from the built-in [`deployments.json`](deployments.json). Your credentials are sent only to the built-in Assay hosts. Redirects are never followed.
- **One bundle.** The npm package is a single bundled file. Its only runtime dependency is `@napi-rs/keyring`, pinned exactly, with prebuilt binaries and no install scripts.
- **No telemetry.** Logs go to stderr only and never contain tokens, keys, signatures, tool arguments or results.
- **Residual risk (T11): the name `assay-mcp`.** The unscoped npm name `assay-mcp` belongs to a third party, not to Assay. Every command here is written as `npx -y @goassay-ai/mcp@0.2.0 …` (the current version), and so is every hint the tool prints. If you run the bare name through `npx` yourself, or follow a page or message that tells you to, you run someone else's code on the computer that holds your payment key. Copy commands from this README, check the scope `@goassay-ai`, and never use `latest`.

See [SECURITY.md](SECURITY.md) to report a vulnerability or verify a release.

## Limits

Spending is bounded in layers:

| Limit | Default | Set where |
|---|---|---|
| Per call (local) | $0.50 | `npx -y @goassay-ai/mcp@0.2.0 limits set --per-call <usd> --per-day <usd>` in a terminal |
| Per rolling 24 hours (local) | $5 | `npx -y @goassay-ai/mcp@0.2.0 limits set --per-call <usd> --per-day <usd>` in a terminal |
| Confirm above (local) | off | `npx -y @goassay-ai/mcp@0.2.0 limits set --per-call <usd> --per-day <usd> --confirm-above <usd>\|off` |
| Payment key caps (on chain) | $0.50 a call, $5 per 24 hours, for 30 days | the "Enable paid calls" page, signed by your wallet |

The most a payment key can spend before it expires is `per-24h cap × (1 + days)`: $155 at the defaults. One budget covers every Assay server on this computer. Your agent's limits apply across all your computers.

Local limits change only from an interactive terminal. No server response, web page, project config or flag can change them.

## Commands

```
npx -y @goassay-ai/mcp@0.2.0 [serve] [--url <url|/path>] [--name <name>] [--profile <name>] [--no-paid] [--log-level <level>] [--log-file <path>]
npx -y @goassay-ai/mcp@0.2.0 add <url|/path> [--client <id>] [--name <name>] [--scope user|project] [--profile <name>] [--force]
npx -y @goassay-ai/mcp@0.2.0 list
npx -y @goassay-ai/mcp@0.2.0 remove <name> [--client <id>] [--scope user|project]
npx -y @goassay-ai/mcp@0.2.0 login [--profile <name>] [--url <url|/path>]
npx -y @goassay-ai/mcp@0.2.0 logout | status [--profile <name>]
npx -y @goassay-ai/mcp@0.2.0 enable-paid [--profile <name>]
npx -y @goassay-ai/mcp@0.2.0 limits [set --per-call <usd> --per-day <usd> [--confirm-above <usd>|off] [--providers <0x...,...>|off]] [--profile <name>]
npx -y @goassay-ai/mcp@0.2.0 allow-paid <url> | disallow-paid <url> [--profile <name>]
npx -y @goassay-ai/mcp@0.2.0 dev allow <origin>
npx -y @goassay-ai/mcp@0.2.0 settings [set --allow-env-proxy on|off] [--profile <name>]
npx -y @goassay-ai/mcp@0.2.0 doctor [--profile <name>]
npx -y @goassay-ai/mcp@0.2.0 --version
```

Exit codes: 0 at the end of input, 1 on a fatal startup error, 2 on a usage error.

`limits set`, `allow-paid`, `disallow-paid`, `dev allow` and `settings set` run only in an interactive terminal; anything else (an agent, a script, your MCP app) is refused with exit code 2. `settings set --allow-env-proxy on` (which asks you to type the profile name) lets `assay-mcp` use an HTTP proxy from its environment, which it refuses by default because a project config can set that environment. `doctor` checks project configs and this terminal for settings that change how `assay-mcp` runs.

Paid calls go only through URLs your profile allows: `/` is allowed when you sign in, any other URL only after `allow-paid` in a terminal (or `add --scope user` on a TTY, which asks you to type the profile name). This holds for every client config, a project config included: a project install can pay through `/`, and its other URLs stay free-only until you allow them.

On Windows, `npx -y @goassay-ai/mcp@0.2.0 add` runs a client CLI (`claude`, `codex`, `gemini`) only from your home directory and refuses a project-scope install through it; use `--scope user` or a file client. It also refuses a CLI path or URL with characters outside plain ASCII letters, digits and URL punctuation (for example a user name with accents, or `%`), because `cmd.exe` would interpret them; add the server in that client's own settings instead.

## Repository layout

| Path | Content |
|---|---|
| `deployments.json` | The built-in table of hosts, networks, contracts and RPCs. The one source for every build. |
| `vectors/` | Shared test vectors for every implementation. |
| `node/` | The `@goassay-ai/mcp` package. Its payment core (guards, vouchers, EIP-712 types) comes from `@goassay-ai/sdk/core`, bundled in. |
| `placeholders/` | Packages that reserve look-alike names and point to `@goassay-ai/mcp`. |

## Development

```sh
npm ci
npm run lint && npm run typecheck && npm test && npm run build
node node/dist/cli.js --version
```
