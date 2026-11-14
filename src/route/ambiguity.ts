// Deterministic pack-size / variant ambiguity check (milestone 2).
// The smoke test showed the model confidently picks *a* pack when the retailer never said which ("maggi 2 peti").
// That is a business-policy question, not a model question, so we detect it from the catalog and route to review.
import type { Candidate, ExtractedLine, Sku } from "../types.ts";

const toBase = (v: number, u: string): [number, string] => {
  const l = u.toLowerCase(); return l === "kg" ? [v * 1000, "g"] : l === "l" ? [v * 1000, "ml"] : [v, l];
};
const words = (s: string) => s.toLowerCase().replace(/&/g, " n ").replace(/[^a-z0-9 ]+/g, " ").replace(/(\d)([a-z])/g, "$1 $2").split(/\s+/).filter(w => w && !/^\d+$/.test(w));
const numbers = (s: string) => [...s.toLowerCase().matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0]));

/** Edit distance ≤ 1 (typo tolerance) for words of length ≥ 4, exact otherwise. */
function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++;
    else if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
const mentions = (text: string[], phrase: string) => { const p = words(phrase); return p.length > 0 && p.every(w => text.some(t => near(t, w))); };

export const sameFamily = (a: Sku, b: Sku) => a.brand === b.brand && a.product === b.product;

/** Does the line's size/price hint fit this SKU? No hint → fits everything. */
export function hintFits(line: ExtractedLine, s: Sku): boolean {
  if (line.sizeHint) {
    const [a, ua] = toBase(line.sizeHint.value, line.sizeHint.unit), [b, ub] = toBase(s.packSize, s.packUnit);
    if (ua !== ub || Math.abs(a - b) > 1e-6) return false;
  }
  if (line.priceHint != null && line.priceHint !== s.mrpInr) {
    // A price hint that matches no family member is probably not a price ("lux sabun 10" = qty) → ignore it.
    return false;
  }
  return true;
}

/** Words that name this SKU's variant: the variant itself plus aliases that siblings of other variants don't share. */
function variantPhrases(s: Sku, family: Sku[]): string[] {
  if (!s.variant) return [];
  const others = new Set(family.filter(f => f.variant !== s.variant).flatMap(f => f.aliases.map(a => a.toLowerCase())));
  return [s.variant, ...s.aliases.filter(a => !/\d/.test(a) && !others.has(a.toLowerCase()))];
}

export interface AmbiguityResult { ambiguous: boolean; kind: "pack_size" | "variant" | null; consistent: string[] }

/**
 * The chosen SKU is ambiguous when ≥2 SKUs of its family (same brand + product) fit everything the line says:
 * the size/price hint and the variant words. Returns the skuIds that fit, for the reviewer's dropdown.
 */
export function checkAmbiguity(line: ExtractedLine, chosen: Sku, candidates: Candidate[]): AmbiguityResult {
  const family = candidates.map(c => c.sku).filter(s => sameFamily(s, chosen));
  if (!family.some(s => s.skuId === chosen.skuId)) family.push(chosen);
  if (family.length < 2) return { ambiguous: false, kind: null, consistent: [chosen.skuId] };
  const text = words(line.itemText || line.raw);
  // Hints: if the hint fits nobody in the family, drop it (e.g. a bare quantity misread as a price).
  let fits = family.filter(s => hintFits(line, s));
  // A hint that contradicts every family member ("maggi 70 wala" when no ₹70 pack exists) means we'd be guessing
  // which pack was meant, so the line is ambiguous by definition.
  if (!fits.length) return { ambiguous: true, kind: "pack_size", consistent: family.map(s => s.skuId) };
  // Leftover numbers in the item text ("20 pcs", "7 pad", "coke 750", "1 lite") that match the pack size or MRP of
  // some family members narrow the pool, even when the extractor didn't recognise their unit.
  const variantNums = new Set(family.flatMap(s => numbers(s.variant)));   // "Lifebuoy Total 10": 10 is a name, not a size
  const nums = numbers(line.itemText || "").filter(n => !variantNums.has(n));
  if (nums.length) { const byNum = fits.filter(s => nums.some(n => n === s.packSize || n === s.mrpInr)); if (byNum.length) fits = byNum; }
  const variantNamed = fits.filter(s => variantPhrases(s, family).some(p => mentions(text, p)));
  const variants = new Set(fits.map(s => s.variant));
  const pool = variantNamed.length ? fits.filter(s => variantNamed.some(v => v.variant === s.variant)) : fits;
  const consistent = pool.map(s => s.skuId);
  if (consistent.length < 2) return { ambiguous: false, kind: null, consistent };
  const kind = !variantNamed.length && variants.size > 1 ? "variant" : "pack_size";
  return { ambiguous: true, kind, consistent };
}
