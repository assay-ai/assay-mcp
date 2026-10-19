/**
 * The payment key's fingerprint (spec §3): the last 8 hex characters of the delegate address,
 * upper case, in two groups of four, e.g. `1A2B 9F3C`. It is shown in the terminal, the tool
 * text, the enable-paid page and the wallet copy (R-WEB-6), so a user can match them.
 */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function fingerprint(address: string): string {
  if (!ADDRESS_RE.test(address)) throw new TypeError("not an address");
  const tail = address.slice(-8).toUpperCase();
  return `${tail.slice(0, 4)} ${tail.slice(4)}`;
}
