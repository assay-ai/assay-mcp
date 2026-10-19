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

## binding.json and vouchers.json

- `binding.json`: `DelegateBinding` challenges in the backend's wire form (F4 step 3). Each `valid` case is accepted under `context` and gives the typed data to sign (integers as decimal strings), its digest and the test key's signature. Each `invalid` case applies one change to `valid[0].challenge` (`set` the value at `path`, or `delete` it) and must be refused, naming `field`.
- `vouchers.json`: rail-B requirements plus `issuedAt`, the wire voucher, the EIP-712 typed data, the domain separator, the struct hash, the digest and the test key's signature. `backend-cast-golden` reproduces the backend's own cast-computed voucher vector.
- `guards.json`: the local guards G1 to G12 (spec §7.8). `base` is a context that passes every guard. Each case applies `changes` to a copy of `base` in order (`set` the value at `path`, or `delete` it) and runs the guards in order G1 to G12. `expect` is `{ok: true}` or the first refusal, `{ok: false, guard, code}`, plus the exact `reason` where the text is part of the contract (`G4_PAYER_CHANGED`). Every guard has at least one passing and one failing case, and every refusal code has at least one case. Codes are stable: never rename or reuse one.
- `seq.json`: G9, `1 <= seq < 2^53` with `seq` a canonical decimal string. Each case sets `requirement.seq` in the `base` of `guards.json`; `ok: false` means refused with `G9` / `G9_SEQ`. It includes `2^53 - 1` (passes), `2^53` and `2^64 - 1` (refused).

Guard order: G1 to G12 (G7 here checks only the caps), then the G7 `confirmAbove` confirmation last, so the user is never asked about a payment another guard refuses. A `confirmation` must equal, key for key, `{tool, provider, amount, asset, network, payTo, seq}` of the payment. A requirement must answer `forwardedCall` (at most 120 s old) and its `resource` must be exactly `/mcp/tools/{forwardedCall.tool}`. The chain read must be for the local key and at most 600 s old. G7 sums every `signed` entry with `at > now - 86400`, including future-dated ones.

Conventions in the guard vectors: amounts, caps and spend are atomic units as decimal strings (6 decimals); local limits are dollars as decimal strings, converted exactly (no floating point); times are Unix seconds on the local clock; `resource` length counts Unicode code points; addresses from the server are checksummed CAIP-10, and addresses the proxy holds itself may be bare `0x` addresses in any case.

Every digest and signature in `binding.json` and `vouchers.json` was recomputed independently with foundry `cast` (EIP-712 built by hand with `cast abi-encode` and `cast keccak`, and `cast wallet sign --data`), and accepted by the backend's EVM verifier (`buildVoucherMessage`, `verifyVoucherSignature`, `delegateBindingTypedData`, `verifyDelegateBindingSignature`).

The signing key in `binding.json` and `vouchers.json` is **test only**: the well-known public anvil/hardhat default account 0. The addresses in `guards.json` are the public anvil/hardhat default accounts 0 to 4, also test only. Never fund them or use them for anything real.
