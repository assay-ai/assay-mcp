# Test vectors

Language-neutral test vectors, shared by every implementation (`node/`, `sdk/node/` and later ports):

- delegate binding typed data, each valid case and each bad field;
- vouchers and their EIP-712 digests;
- payment requirements and every local guard (G1 to G12), passing and failing;
- `seq` bounds: `2^53 - 1` passes, `2^53` and `2^64 - 1` are refused;
- the profile lock protocol;
- server names and tool aliases;
- install commands, links and config entries per client.

The vector files are added with the features that use them.

## server-names.json

The server-name rule of spec 8.3.1 (`budget 64`, `overhead 7`): maximum length, validity, `fits`, `L`, default names, uniqueness, the refusal message and runtime aliases.

- Source of truth. Implementations test against this file and must not copy its values.
- Consumers:
  - `node/test/server-name.test.ts` (this repo, `node/src/clients/server-name.ts`);
  - the frontend Connect sheet (`assay-frontend/src/features/connect/mcp-url.ts`, Task 3.2), which still has the old 9-character rule;
  - the backend `serverName` DTO and `agent_connect_urls.server_name` (Part 3) carry only the pattern and the 56-character length, not the per-URL rule.

Correction to the Task 2.10 brief: the root URL in search mode has L 13, not 12, because `assay_sign_in` is always counted, so its maximum name length is 44, not 45.

Notes for consumers (fix round 1):
- `rule.pattern` and `rule.maxLength` are machine-readable: assert your own regex and length against them, do not copy them.
- Whole-string anchors: `assay\n` is invalid. `assay-` and `a--b` are valid by the pattern, as the spec states.
- Tool names are ASCII `[A-Za-z0-9_-]`; `L` is measured in UTF-8 bytes. A tool that is not ASCII, or a server name that leaves no room for a prefix character, has no alias (`null`).
- Refusals have two kinds, `invalid` and `tooLong`; a suggestion, when present, always fits.

## binding.json and vouchers.json

- `binding.json`: `DelegateBinding` challenges in the backend's wire form (F4 step 3). Each `valid` case is accepted under `context` and gives the typed data to sign (integers as decimal strings), its digest and the test key's signature. Each `invalid` case applies one change to `valid[0].challenge` (`set` the value at `path`, or `delete` it) and must be refused, naming `field`.
- `vouchers.json`: rail-B requirements plus `issuedAt`, the wire voucher, the EIP-712 typed data, the domain separator, the struct hash, the digest and the test key's signature. `backend-cast-golden` reproduces the backend's own cast-computed voucher vector.

Every digest and signature was recomputed independently with foundry `cast` (EIP-712 built by hand with `cast abi-encode` and `cast keccak`, and `cast wallet sign --data`), and accepted by the backend's EVM verifier (`buildVoucherMessage`, `verifyVoucherSignature`, `delegateBindingTypedData`, `verifyDelegateBindingSignature`).

The signing key in both files is **test only**: the well-known public anvil/hardhat default account 0. Never fund it or use it for anything real.

## commands.json

The spec 7.12 install commands for every client, with `V = 1.2.3` standing in for the version.

- `install`: per client and URL, the paid-capable user-scope `command` (a POSIX shell line, or the config object for Cursor, Windsurf and Claude Desktop), the `entry` that lands in the client config under the server name, the one-click `link` (Cursor, VS Code) and the free-only `remote` alternative.
- `project`: the args `add --scope project` writes (R-MU-4): the pinned package, `--url` and a non-default `--profile` only.
- `add`: the `npx -y @assay-ai/mcp@V add {url} --client {id}` one-liner.
- `ownership`: which stored entries `remove` treats as written by `assay-mcp` (by command and args, never by name).
- Consumers:
  - `node/test/clients.test.ts` (`node/src/clients/install-command.ts`, and `add`'s written entries, R-MU-9);
  - the README install table, with `1.2.3` replaced by the package version (R-WEB-7, this repo's half);
  - the frontend Connect UI commands (`assay-frontend/src/features/buyer-money/mcp-config.ts`, Part 3).
- Shell words are single-quoted only when a POSIX shell would change them (a URL with `?` or `&`). The Cursor link percent-encodes its base64 `config`.
