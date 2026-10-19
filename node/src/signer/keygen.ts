import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface DelegateKey {
  readonly address: Address;
  /** Non-enumerable: `JSON.stringify`, `util.inspect`, spreads and `Object.keys` never show it. */
  readonly privateKey: Hex;
}

/**
 * A fresh secp256k1 delegate key (F4 step 2). viem's `generatePrivateKey` draws from the
 * platform CSPRNG (`crypto.getRandomValues`). The caller stores `privateKey` in the OS keychain
 * and shows only `address`.
 *
 * The key is a JS string, so it cannot be zeroised; keep references to it short-lived.
 */
export function generate(): DelegateKey {
  const privateKey = generatePrivateKey();
  const key = { address: privateKeyToAccount(privateKey).address };
  Object.defineProperty(key, "privateKey", { value: privateKey, enumerable: false, writable: false });
  return key as DelegateKey;
}
