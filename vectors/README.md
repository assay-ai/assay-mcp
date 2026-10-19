# Test vectors

Language-neutral test vectors, shared by every implementation (`node/`, `sdk/node/` and later ports):

- delegate binding typed data, each valid case and each bad field;
- vouchers and their EIP-712 digests;
- payment requirements and every local guard (G1 to G12), passing and failing;
- `seq` bounds: `2^53 - 1` passes, `2^53` and `2^64 - 1` are refused;
- the profile lock protocol;
- server names and tool aliases.

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
