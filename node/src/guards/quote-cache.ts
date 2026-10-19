import type { Quote } from "./types.js";

/**
 * The G3 quote cache (spec §7.7 step 2, §7.8 G3): `assay/price` seen in `tools/list`,
 * `search_tools` and `get_tool` results, kept 60 s per tool name (the remote's original name,
 * never an alias). A quote older than that is gone, and the proxy asks `get_tool` itself.
 *
 * Bounded: at most {@link MAX_QUOTES} names; the oldest entry goes first.
 */

export const QUOTE_TTL_MS = 60_000;
export const MAX_QUOTES = 2_048;

export class QuoteCache {
  private readonly entries = new Map<string, { quote: Quote; at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = QUOTE_TTL_MS,
  ) {}

  set(tool: string, quote: Quote): void {
    this.entries.delete(tool);
    this.entries.set(tool, { quote: { maxAmount: quote.maxAmount, asset: quote.asset }, at: this.now() });
    while (this.entries.size > MAX_QUOTES) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  setAll(pairs: readonly (readonly [string, Quote])[]): void {
    for (const [name, quote] of pairs) this.set(name, quote);
  }

  /** The quote for `tool` when it is at most 60 s old, else `null` (and it is dropped). */
  get(tool: string): Quote | null {
    const e = this.entries.get(tool);
    if (!e) return null;
    const age = this.now() - e.at;
    if (age < 0 || age > this.ttlMs) {
      this.entries.delete(tool);
      return null;
    }
    return { ...e.quote };
  }

  get size(): number {
    return this.entries.size;
  }
}
