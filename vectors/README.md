# Test vectors

Language-neutral test vectors, shared by every implementation (`node/`, `sdk/node/` and later ports):

- delegate binding typed data, each valid case and each bad field;
- vouchers and their EIP-712 digests;
- payment requirements and every local guard (G1 to G12), passing and failing;
- `seq` bounds: `2^53 - 1` passes, `2^53` and `2^64 - 1` are refused;
- the profile lock protocol;
- server names and tool aliases.

The vector files are added with the features that use them.

## Files

- `binding.json`: `DelegateBinding` challenges in the backend's wire form (F4 step 3). Each `valid` case is accepted under `context` and gives the typed data to sign (integers as decimal strings), its digest and the test key's signature. Each `invalid` case applies one change to `valid[0].challenge` (`set` the value at `path`, or `delete` it) and must be refused, naming `field`.
- `vouchers.json`: rail-B requirements plus `issuedAt`, the wire voucher, the EIP-712 typed data, the domain separator, the struct hash, the digest and the test key's signature. `backend-cast-golden` reproduces the backend's own cast-computed voucher vector.

Every digest and signature was recomputed independently with foundry `cast` (EIP-712 built by hand with `cast abi-encode` and `cast keccak`, and `cast wallet sign --data`), and accepted by the backend's EVM verifier (`buildVoucherMessage`, `verifyVoucherSignature`, `delegateBindingTypedData`, `verifyDelegateBindingSignature`).

The signing key in both files is **test only**: the well-known public anvil/hardhat default account 0. Never fund it or use it for anything real.
