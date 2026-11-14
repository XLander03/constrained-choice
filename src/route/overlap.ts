// Provider-independent sanity check (milestone 5): how much of what the retailer wrote does the picked SKU actually explain?
// "red bull 250ml" vs Brooke Bond Red Label Tea shares only "red"; "bull" is not in that SKU at all, so the pick can't auto-accept.
// Words are weighted by how rare they are in the catalog (IDF), so a brand word counts more than "red" or "masala".
// Typos are tolerated (edit distance ≤ 1 for words of 4+ letters, prefix ≥ 3 letters for shorthand like "parl" / "colg").
import type { Sku } from "../types.ts";

const UNIT_OR_FILLER = new Set([
  // units / packaging words the extractor may leave in item text
  "g", "gm", "gms", "gram", "grams", "kg", "kgs", "kilo", "ml", "l", "ltr", "litre", "liter", "pc", "pcs", "piece", "pieces", "pkt", "packet", "packets",
  "pack", "peti", "petti", "ladi", "strip", "strips", "dozen", "dzn", "doz", "case", "cases", "box", "boxes", "bori", "crate", "bag", "bags", "carton", "rs", "wala", "wale", "wali",
  // Hinglish / English filler around order lines
  "bhai", "bhaiya", "aur", "ka", "ki", "ke", "ko", "do", "de", "dena", "dedo", "bhejo", "bhej", "order", "the", "and", "of", "x", "se", "me", "mein", "hai", "chahiye",
  "please", "pls", "plz", "bhi", "ek", "sir", "ji", "n", "a", "an", "for", "send", "need", "add", "also", "wala", "vala", "small", "big", "bada", "chota",
]);
const words = (s: string) => s.toLowerCase().replace(/&/g, " ").replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2")
  .split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !/^\d+$/.test(w));
const content = (s: string) => words(s).filter(w => !UNIT_OR_FILLER.has(w));
export const skuWords = (s: Sku) => new Set(words([s.brand, s.product, s.variant, ...s.aliases].join(" ")));

function within1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, e = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++e > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++;
    else if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } else { i++; j++; }
  }
  return e + (a.length - i) + (b.length - j) <= 1;
}
const close = (t: string, w: string) => t === w || (t.length >= 4 && w.length >= 4 && within1(t, w)) || (t.length >= 3 && w.length > t.length && w.startsWith(t));

/** IDF over the catalog vocabulary. Unknown words (not in any SKU) get the maximum weight. */
export class OverlapScorer {
  private df = new Map<string, number>(); private n: number; private maxIdf: number;
  constructor(catalog: Sku[]) {
    this.n = catalog.length;
    for (const s of catalog) for (const w of skuWords(s)) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    this.maxIdf = Math.log(1 + this.n);
  }
  private idf(t: string): number {
    let df = this.df.get(t);
    if (df === undefined) for (const [w, d] of this.df) if (close(t, w)) { df = Math.max(df ?? 0, d); }
    return df === undefined ? this.maxIdf : Math.log(1 + this.n / df);
  }
  /** Share (0..1, IDF-weighted) of the line's content words that the SKU explains. null = no content words to judge. */
  score(itemText: string, sku: Sku): number | null {
    const ts = [...new Set(content(itemText))]; if (!ts.length) return null;
    const sw = [...skuWords(sku)]; let tot = 0, hit = 0;
    for (const t of ts) { const w = this.idf(t); tot += w; if (sw.some(x => close(t, x))) hit += w; }
    return tot ? hit / tot : null;
  }
}

/** Unweighted share of the line's content words that the SKU explains (used by the offline mock, which has no catalog-wide IDF). */
export function plainOverlap(itemText: string, sku: Sku): number | null {
  const ts = [...new Set(content(itemText))]; if (!ts.length) return null;
  const sw = [...skuWords(sku)];
  return ts.filter(t => sw.some(x => close(t, x))).length / ts.length;
}
