# Test vectors

Language-neutral test vectors, shared by every implementation (`node/`, `sdk/node/` and later ports):

- delegate binding typed data, each valid case and each bad field;
- vouchers and their EIP-712 digests;
- payment requirements and every local guard (G1 to G12), passing and failing;
- `seq` bounds: `2^53 - 1` passes, `2^53` and `2^64 - 1` are refused;
- the profile lock protocol;
- server names and tool aliases.

The vector files are added with the features that use them.
