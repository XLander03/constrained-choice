import type { ExtractedLine, IncomingOrder, OrderUnit, Sku } from "../types.ts";

/** Stage 1 contract. Rules-based now; an LLM structured-output extractor can implement the same interface. */
export interface LineExtractor {
  extract(order: IncomingOrder): Promise<ExtractedLine[]>;
  /** Optional: extractors that call a paid model also report what it cost. */
  extractDetailed?(order: IncomingOrder): Promise<{ lines: ExtractedLine[]; usage: ExtractionUsage }>;
}
export interface ExtractionUsage { requests: number; inputTokens: number; outputTokens: number; costUsd: number; llmLines: number }
export const NO_EXTRACTION_USAGE: ExtractionUsage = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, llmLines: 0 };

const NUM_WORDS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6, saat: 7, aath: 8, nau: 9, das: 10,
  gyarah: 11, barah: 12, bees: 20, pachees: 25, pachas: 50, aadha: 0.5, adha: 0.5, half: 0.5, dedh: 1.5, dhai: 2.5,
};
// Unit vocabulary -> canonical unit. bori / bora / crate / bag = case is the distributor policy confirmed in milestone 3.
export const UNIT_WORDS: Record<string, OrderUnit> = {
  peti: "case", pet: "case", petti: "case", ctn: "case", ctns: "case", carton: "case", cartons: "case", case: "case", cases: "case",
  cs: "case", box: "case", boxes: "case", dabba: "case", dabbe: "case", crate: "case", crates: "case", bori: "case", bora: "case", bag: "case", bags: "case",
  dozen: "dozen", dzn: "dozen", doz: "dozen", darjan: "dozen", dz: "dozen",
  pc: "pc", pcs: "pc", piece: "pc", pieces: "pc", nos: "pc", no: "pc", pkt: "pc", pkts: "pc", packet: "pc", packets: "pc",
  ladi: "strip", strip: "strip", strips: "strip",
};
const NUM = `(\\d+(?:\\.\\d+)?|${Object.keys(NUM_WORDS).join("|")})`;
const UNIT = `(${Object.keys(UNIT_WORDS).sort((a, b) => b.length - a.length).join("|")})`;
const RE_QTY_UNIT = new RegExp(`(?:^|[\\s\\-=:,(])${NUM}\\s*${UNIT}(?=$|[\\s,.)!])`, "gi");
const RE_X_QTY = /(?:^|\s)x\s*(\d+)\b/i;
const RE_SIZE = /(\d+(?:\.\d+)?)\s*(g|gm|gms|gram|grams|kg|kilo|kgs|ml|l|ltr|litre|liter)\b/i;
const RE_PRICE = /(?:\brs\.?\s*|₹\s*)(\d+)\b|\b(\d+)\s*(?:rs|rupees?|rupay|wala|wale|wali)\b/i;
const CHATTER = /^(subject:|dear\b|regards|please supply|thanks|thank you|hi\b|hello|namaste|jai\b|order\b|sir\b|bhai order|bhaiya ye)/i;

const toNum = (s: string) => (/^\d/.test(s) ? Number(s) : NUM_WORDS[s.toLowerCase()]);
const normSizeUnit = (u: string) => ({ gm: "g", gms: "g", gram: "g", grams: "g", kilo: "kg", kgs: "kg", ltr: "L", litre: "L", liter: "L", l: "L" } as Record<string, string>)[u.toLowerCase()] ?? u.toLowerCase();

export class RulesExtractor implements LineExtractor {
  private protectedPhrases: RegExp[];
  /** Catalog is used only to protect numeric brand names ("5 star", "50 50") from being read as quantities. */
  constructor(catalog: Sku[]) {
    const ph = new Set<string>();
    for (const s of catalog) for (const a of [s.product, ...s.aliases]) {
      const m = a.toLowerCase().match(/\b\d+[\s-]?(star|minute)\b|\b50[\s-]50\b|\b5050\b/);
      if (m) ph.add(m[0]);
    }
    this.protectedPhrases = [...ph].map(p => new RegExp(`\\b${p.replace(/[-\s]/g, "[\\s-]?")}\\b`, "gi"));
  }

  async extract(order: IncomingOrder): Promise<ExtractedLine[]> {
    const out: ExtractedLine[] = [];
    let lines = order.text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    // Drop email signature block (everything after "Regards").
    const reg = lines.findIndex(l => /^regards/i.test(l)); if (reg >= 0) lines = lines.slice(0, reg);
    for (const l0 of lines) {
      let l = l0.replace(/^\d+[.)]\s+/, "").replace(/^[^:]{0,40}:\s*(?=\S.*\d)/, m => (CHATTER.test(m) || /sirf|ye|order/i.test(m) ? "" : m));
      for (const part of this.splitSegments(l)) {
        const e = this.parseSegment(part, order.orderId, out.length);
        if (e) out.push(e);
      }
    }
    return out;
  }

  /** Split a physical line into item segments on commas / "aur" / "+" when each side carries its own quantity. */
  private splitSegments(l: string): string[] {
    const parts = l.split(/\s*,\s*|\s+\+\s+|\s+aur\s+|\s+and\s+|\s*;\s*/i).filter(Boolean);
    if (parts.length > 1 && parts.every(p => this.hasQty(p))) return parts;
    // "2 peti maggi 70 wala ek peti yippee" style: split before every qty+unit after the first one that follows text
    return [l];
  }
  private hasQty(p: string) { return new RegExp(RE_QTY_UNIT.source, "i").test(p) || RE_X_QTY.test(p) || /\b\d+\b/.test(this.mask(p)); }
  private mask(p: string) { let m = p; for (const r of this.protectedPhrases) m = m.replace(r, " "); return m.replace(RE_SIZE, " ").replace(RE_PRICE, " "); }

  private parseSegment(seg: string, orderId: string, idx: number): ExtractedLine | null {
    const raw = seg.trim();
    if (!raw || (CHATTER.test(raw) && !/\d/.test(raw))) return null;
    const lower = raw.toLowerCase().replace(/₹\s*(\d+)/g, "rs $1");
    const sizeM = lower.match(RE_SIZE);
    const priceM = lower.match(RE_PRICE);
    let qty: number | null = null; let unit: OrderUnit = "unspecified"; let qtySpan: [number, number] | null = null;
    const matches = [...lower.matchAll(new RegExp(RE_QTY_UNIT.source, "gi"))];
    if (matches.length) {
      const m = matches[matches.length - 1];               // last qty+unit wins; earlier ones ("20 pcs") describe the pack
      qty = toNum(m[1]); unit = UNIT_WORDS[m[2].toLowerCase()];
      const start = m.index! + m[0].indexOf(m[1]); qtySpan = [start, m.index! + m[0].length];
    } else if (RE_X_QTY.test(lower)) {
      const m = lower.match(RE_X_QTY)!; qty = Number(m[1]); unit = "pc"; qtySpan = [m.index!, m.index! + m[0].length];
    } else {
      const masked = this.maskKeepLength(lower);
      const bare = [...masked.matchAll(new RegExp(`(?:^|\\s)${NUM}(?=$|\\s)`, "gi"))];
      if (bare.length) { const m = bare[bare.length - 1]; qty = toNum(m[1]); unit = "unspecified"; qtySpan = [m.index!, m.index! + m[0].length]; }
    }
    if (qty === null && !/[a-z]{3,}/.test(lower)) return null;
    // Pure chatter with no quantity and no product-looking token is dropped.
    if (qty === null && (CHATTER.test(lower) || /\b(bill|payment|bhejna|bhej|jaldi|cancel|thanks)\b/.test(lower))) return null;
    let item = qtySpan ? lower.slice(0, qtySpan[0]) + " " + lower.slice(qtySpan[1]) : lower;
    item = item.replace(/[=\-–:]+/g, " ").replace(/\b(extra|bhai|bhaiya|sirf|ye|pls|please|bhej do)\b/g, " ").replace(/\s+/g, " ").trim();
    let priceHint: number | null = null;
    if (priceM) priceHint = Number(priceM[1] ?? priceM[2]);
    return {
      lineId: `${orderId}#${idx}`, orderId, raw, itemText: item, qty, unit,
      sizeHint: sizeM ? { value: Number(sizeM[1]), unit: normSizeUnit(sizeM[2]) } : null,
      priceHint, extractor: "rules",
    };
  }
  private maskKeepLength(p: string) {
    let m = p;
    const blank = (s: string) => " ".repeat(s.length);
    for (const r of this.protectedPhrases) m = m.replace(r, blank);
    return m.replace(new RegExp(RE_SIZE.source, "gi"), blank).replace(new RegExp(RE_PRICE.source, "gi"), blank);
  }
}
