import type { Candidate, ExtractedLine, Sku } from "../types.ts";

/** Stage 2 contract: return the top-k SKUs worth showing the decision model. */
export interface CandidateRetriever {
  shortlist(line: ExtractedLine, k: number): Candidate[];
}

/** Embedding seam. Local char-trigram stand-in now; swap in a real multilingual embedding model later. */
export interface EmbeddingProvider {
  embed(texts: string[]): Map<string, number>[] | Promise<number[][]>;
}

const UNIT_NORM: Record<string, string> = { gm: "g", gms: "g", gram: "g", grams: "g", kilo: "kg", kgs: "kg", ltr: "l", litre: "l", liter: "l", rs: "rs", wala: "rs", wale: "rs" };
export function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/&/g, " and ").replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2")
    .split(/[^a-z0-9.]+/).map(t => t.replace(/^\.+|\.+$/g, "")).filter(Boolean).map(t => UNIT_NORM[t] ?? t);
}
const skuDoc = (s: Sku) => [s.brand, s.product, s.variant, `${s.packSize} ${s.packUnit}`, `rs ${s.mrpInr}`, ...s.aliases].join(" ");

/** Char-trigram "embedding" (typo-tolerant). Free and local; a placeholder for real embeddings. */
export class TrigramEmbedder implements EmbeddingProvider {
  embed(texts: string[]) { return texts.map(t => trigrams(t)); }
}
function trigrams(t: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(x => x.length > 1 && !/^\d+$/.test(x))) {
    const p = ` ${w} `; for (let i = 0; i < p.length - 2; i++) { const g = p.slice(i, i + 3); m.set(g, (m.get(g) ?? 0) + 1); }
  }
  let norm = 0; for (const v of m.values()) norm += v * v; norm = Math.sqrt(norm) || 1;
  for (const [k, v] of m) m.set(k, v / norm);
  return m;
}
const cos = (a: Map<string, number>, b: Map<string, number>) => { let s = 0; const [x, y] = a.size < b.size ? [a, b] : [b, a]; for (const [k, v] of x) s += v * (y.get(k) ?? 0); return s; };

const toBase = (v: number, u: string): [number, string] => { const l = u.toLowerCase(); return l === "kg" ? [v * 1000, "g"] : l === "l" ? [v * 1000, "ml"] : [v, l]; };

/** BM25 lexical + trigram vector similarity, fused with reciprocal-rank fusion, then size/price hint boosts. */
export class HybridRetriever implements CandidateRetriever {
  private docs: string[][]; private df = new Map<string, number>(); private avgLen: number; private vecs: Map<string, number>[];
  private catalog: Sku[];
  constructor(catalog: Sku[], embedder = new TrigramEmbedder()) {
    this.catalog = catalog;
    this.docs = catalog.map(s => tokenize(skuDoc(s)));
    for (const d of this.docs) for (const t of new Set(d)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.docs.reduce((a, d) => a + d.length, 0) / this.docs.length;
    this.vecs = embedder.embed(catalog.map(s => [s.brand, s.product, s.variant, ...s.aliases.filter(a => !/\d/.test(a))].join(" "))) as Map<string, number>[];
  }
  private bm25(q: string[], i: number) {
    const d = this.docs[i]; const N = this.docs.length; let s = 0;
    for (const t of new Set(q)) {
      const f = d.filter(x => x === t).length; if (!f) continue;
      const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / this.avgLen));
    }
    return s;
  }
  shortlist(line: ExtractedLine, k = 20): Candidate[] {
    const q = tokenize(line.itemText); const qv = trigrams(line.itemText);
    const lex = this.catalog.map((_, i) => ({ i, s: this.bm25(q, i) }));
    const vec = this.catalog.map((_, i) => ({ i, s: cos(qv, this.vecs[i]) }));
    const lr = new Map([...lex].sort((a, b) => b.s - a.s).map((x, r) => [x.i, r] as const));
    const vr = new Map([...vec].sort((a, b) => b.s - a.s).map((x, r) => [x.i, r] as const));
    const scored = this.catalog.map((sku, i) => {
      let s = 1 / (60 + lr.get(i)!) + 1 / (60 + vr.get(i)!);
      s += 0.004 * lex[i].s + 0.02 * vec[i].s;
      if (line.sizeHint) { const [a, ua] = toBase(line.sizeHint.value, line.sizeHint.unit); const [b, ub] = toBase(sku.packSize, sku.packUnit); if (ua === ub && Math.abs(a - b) < 1e-6) s += 0.02; }
      if (line.priceHint != null && line.priceHint === sku.mrpInr) s += 0.015;
      return { sku, score: s, lexicalRank: lr.get(i)! + 1, vectorRank: vr.get(i)! + 1, lexicalScore: lex[i].s, vectorScore: vec[i].s };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
