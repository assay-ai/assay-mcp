import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface DelegateKey {
  address: Address;
  privateKey: Hex;
}

/**
 * A fresh secp256k1 delegate key (F4 step 2). viem's `generatePrivateKey` draws from the
 * platform CSPRNG (`crypto.getRandomValues`). The caller stores `privateKey` in the OS keychain
 * and shows only `address`.
 */
export function generate(): DelegateKey {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
}
