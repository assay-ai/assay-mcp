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
