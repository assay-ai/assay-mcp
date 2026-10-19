import { inspect } from "node:util";
import { getAddress, isAddress, type Account, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Environment } from "@assay-core/deployments.js";
import { generate } from "@assay-core/signer/keygen.js";
import { openOsKeychain } from "@assay-core/profile/keychain.js";
import { withLock } from "@assay-core/profile/lock.js";
import { configDir, isValidProfileName } from "@assay-core/profile/paths.js";
import type { TypedDataSigner } from "@assay-core/proxy/delegate-bind.js";

/**
 * Payment signers (spec §10.2, R-SDK-3). A `Signer` signs EIP-712 data only: the voucher the
 * guards accepted and the key-binding proof. Its secret is never readable from the object:
 * `JSON.stringify`, `util.inspect`, `String()` and spreads show the kind and, once known, the
 * address.
 */

export type SignerKind = "account" | "keychain" | "privateKey";

/** How a signer reaches its key, per environment. Module-private: never reachable from a `Signer`. */
type Resolver = (environment: Environment) => Promise<TypedDataSigner>;
const RESOLVERS = new WeakMap<Signer, Resolver>();
/** Records the address a keychain signer turned out to have. Module-private. */
const LEARN = new WeakMap<Signer, (address: Address) => void>();

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export class SignerError extends Error {
  override readonly name = "SignerError";
}

/** A payment signer. Build one with {@link Signers}. */
export class Signer {
  readonly kind: SignerKind;
  #address: Address | null;

  /** @internal */
  constructor(kind: SignerKind, address: Address | null, resolver: Resolver) {
    this.kind = kind;
    this.#address = address;
    RESOLVERS.set(this, resolver);
    LEARN.set(this, (a) => {
      this.#address = a;
    });
    Object.freeze(this);
  }

  /** The key's address, or `null` for a keychain signer before its first use. */
  get address(): Address | null {
    return this.#address;
  }

  toJSON(): { kind: SignerKind; address: Address | null } {
    return { kind: this.kind, address: this.#address };
  }

  toString(): string {
    return `Signer(${this.kind}${this.#address ? ` ${this.#address}` : ""})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** The signing account of `signer` for `environment`. SDK-internal (not exported from the package). */
export async function resolveSigner(signer: Signer, environment: Environment): Promise<TypedDataSigner> {
  const resolver = signer instanceof Signer ? RESOLVERS.get(signer) : undefined;
  if (!resolver) throw new SignerError("signer must come from Signers.fromAccount, Signers.fromKeychain or Signers.fromPrivateKey");
  const account = await resolver(environment);
  LEARN.get(signer)!(getAddress(account.address));
  return account;
}

export function isSigner(value: unknown): value is Signer {
  return value instanceof Signer && RESOLVERS.has(value);
}

/** Only `address` and `signTypedData` of an account: nothing else of it is kept or used. */
function signingOnly(address: Address, sign: TypedDataSigner["signTypedData"]): TypedDataSigner {
  return Object.freeze({ address, signTypedData: sign });
}

/**
 * A fresh payment key, as `Signers.keygen()` returns it. `privateKey` is read by name only: it is
 * an ES private field behind a getter, so logging, `util.inspect`, `JSON.stringify` and spreads
 * show the address alone.
 */
export class GeneratedKey {
  readonly address: Address;
  readonly #privateKey: Hex;

  /** @internal */
  constructor(address: Address, privateKey: Hex) {
    this.address = address;
    this.#privateKey = privateKey;
    Object.freeze(this);
  }

  /** The private key. Store it in a secret store or KMS; never print it. */
  get privateKey(): Hex {
    return this.#privateKey;
  }

  toJSON(): { address: Address } {
    return { address: this.address };
  }

  toString(): string {
    return `GeneratedKey(${this.address})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export const Signers = Object.freeze({
  /**
   * The preferred signer: a viem `Account` whose key lives in a KMS or HSM (for example one built
   * with viem's `toAccount`). Only its `signTypedData` is called.
   */
  fromAccount(account: Account): Signer {
    const a = account as Partial<Account> | null | undefined;
    if (!a || typeof a !== "object" || typeof a.address !== "string" || !isAddress(a.address, { strict: false })) {
      throw new SignerError("fromAccount needs a viem Account with an address");
    }
    if (typeof a.signTypedData !== "function") throw new SignerError("fromAccount needs an Account that can signTypedData");
    const address = getAddress(a.address);
    const sign = a.signTypedData.bind(a) as TypedDataSigner["signTypedData"];
    const resolved = signingOnly(address, sign);
    return new Signer("account", address, async () => resolved);
  },

  /**
   * The payment key of an `assay-mcp` profile in the OS keychain (service `ai.assay.mcp`, account
   * `{profile}@{environment}/delegate_key`). When the profile has no key yet, one is generated
   * and stored under the profile lock. Use a profile of its own (e.g. `"ci"`), not the one an
   * MCP client uses: a key binds to one API key or sign-in at a time.
   *
   * Needs the `@napi-rs/keyring` package installed next to the SDK.
   */
  fromKeychain(options: { profile: string }): Signer {
    const profile = options?.profile;
    if (typeof profile !== "string" || !isValidProfileName(profile)) throw new SignerError("fromKeychain needs a valid profile name");
    const cache = new Map<Environment, Promise<TypedDataSigner>>();
    const load = async (environment: Environment): Promise<TypedDataSigner> => {
      const keychain = (await openOsKeychain()).forScope({ profile, environment });
      let pk = await keychain.get("delegate_key");
      if (pk === null) {
        pk = await withLock({ dir: configDir(), name: profile }, async (lock) => {
          const again = await keychain.get("delegate_key");
          if (again !== null) return again;
          const key = generate();
          await keychain.set(lock, "delegate_key", key.privateKey);
          return key.privateKey;
        });
      }
      if (!PRIVATE_KEY_RE.test(pk)) throw new SignerError("the payment key stored in the keychain is unreadable");
      const local = privateKeyToAccount(pk as Hex);
      return signingOnly(local.address, local.signTypedData);
    };
    return new Signer("keychain", null, (environment) => {
      let p = cache.get(environment);
      if (!p) {
        p = load(environment);
        cache.set(environment, p);
        p.catch(() => cache.delete(environment));
      }
      return p;
    });
  },

  /**
   * FOR TESTS AND LOCAL DEVELOPMENT ONLY. A raw private key in process memory: anything that can
   * read the process environment or memory can spend with it, within its on-chain caps. In
   * production use {@link Signers.fromAccount} with a KMS-backed account.
   *
   * The key is never kept on the returned object and never appears in an error or a log.
   */
  fromPrivateKey(privateKey: Hex): Signer {
    if (typeof privateKey !== "string" || !PRIVATE_KEY_RE.test(privateKey)) {
      throw new SignerError("fromPrivateKey needs a 0x-prefixed 32-byte hex key");
    }
    let local;
    try {
      local = privateKeyToAccount(privateKey);
    } catch {
      throw new SignerError("fromPrivateKey needs a valid secp256k1 private key");
    }
    const resolved = signingOnly(local.address, local.signTypedData);
    return new Signer("privateKey", local.address, async () => resolved);
  },

  /**
   * A fresh, dedicated payment key from the platform CSPRNG. Store `privateKey` in a secret store
   * or KMS; never reuse a wallet key. Logging or serialising the result shows the address only.
   */
  keygen(): GeneratedKey {
    const key = generate();
    return new GeneratedKey(key.address, key.privateKey);
  },
});
