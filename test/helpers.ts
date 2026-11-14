import { loadCatalog } from "../src/catalog/load.ts";
import { NONE, type Candidate, type ExtractedLine, type LineDecision, type Sku } from "../src/types.ts";

export const catalog = loadCatalog(new URL("../data/catalog.csv", import.meta.url).pathname);
export const sku = (id: string) => catalog.find(s => s.skuId === id)!;
export const cands = (...skus: Sku[]): Candidate[] => skus.map((s, i) => ({ sku: s, score: 1 - i * 0.1, lexicalRank: i + 1, vectorRank: i + 1 }));
export const line = (p: Partial<ExtractedLine> & { raw: string }): ExtractedLine => ({
  lineId: "T#0", orderId: "T", itemText: p.raw.toLowerCase(), qty: 1, unit: "case", sizeHint: null, priceHint: null, extractor: "rules", ...p });
export const decision = (choice: string, confidence: number): LineDecision => ({
  lineId: "T#0", choice, confidence, refused: false, probabilities: [{ skuId: choice, p: confidence }, { skuId: NONE, p: 1 - confidence }] });
