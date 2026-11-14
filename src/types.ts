// Core data model. Plain types only (no enums) so Node can run .ts files directly via type stripping.

/** Canonical order units. "unspecified" = retailer wrote a bare number; a distributor policy resolves it. */
export type OrderUnit = "pc" | "dozen" | "case" | "strip" | "unspecified";

export interface Sku {
  skuId: string;
  brand: string;
  product: string;
  variant: string;          // "" when none
  packSize: number;         // e.g. 70
  packUnit: string;         // g | kg | ml | L | pcs | pack
  mrpInr: number;
  caseQty: number;          // selling units per case ("peti")
  stripQty: number | null;  // sachets per strip ("ladi"), if sold that way
  category: string;
  aliases: string[];
}

/** One raw message from a retailer (WhatsApp paste, email body, later WhatsApp Business webhook). */
export interface IncomingOrder {
  orderId: string;
  channel: "whatsapp" | "email" | "manual";
  retailerId?: string;
  receivedAt?: string;      // ISO 8601
  text: string;
}

/** Output of stage 1: one candidate order line with numbers pulled out deterministically. */
export interface ExtractedLine {
  lineId: string;           // `${orderId}#${index}`
  orderId: string;
  raw: string;              // the span the line came from
  itemText: string;         // raw minus qty/unit tokens; what retrieval searches
  qty: number | null;
  unit: OrderUnit;
  sizeHint: { value: number; unit: string } | null;  // "70g", "1 kg"
  priceHint: number | null;                           // "10 wala", "rs 10"
  extractor: "rules" | "llm";
  unitDefaulted?: boolean;  // bare number: unit came from the distributor default (config), not the text
}

export interface Candidate {
  sku: Sku;
  score: number;            // fused retrieval score (higher = better), not a probability
  lexicalRank: number | null;
  vectorRank: number | null;
  lexicalScore?: number;    // raw BM25
  vectorScore?: number;     // cosine similarity 0-1
}

export const NONE = "__none__" as const;
export type SkuChoice = string | typeof NONE;

/** What a decision adapter returns for one line. */
export interface LineDecision {
  lineId: string;
  choice: SkuChoice;                                 // skuId or NONE
  probabilities: { skuId: SkuChoice; p: number }[];  // over shortlist + NONE, sums to ~1
  confidence: number;                                // provider-reported confidence (0-1)
  refused: boolean;
}

export interface DecisionUsage { inputTokens: number; cachedTokens: number; requests: number; costUsd: number }

export type Route = "auto" | "review";

export interface ResolvedLine {
  line: ExtractedLine;
  candidates: Candidate[];
  decision: LineDecision;
  calibratedConfidence: number;
  route: Route;
  reason: string;           // why it went to review, e.g. "low_confidence", "none_of_these", "qty_missing", "pack_size_ambiguous"
  ambiguousWith?: string[]; // skuIds that all fit the line equally (pack size / variant not stated)
  lexicalOverlap?: number | null; // IDF-weighted share of the line's words the picked SKU explains (null = nothing to judge / no pick)
}

export interface ResolvedOrder {
  order: IncomingOrder;
  lines: ResolvedLine[];
  usage: DecisionUsage;
  extractionUsage?: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; llmLines: number };
}

/** Gold label format used by data/orders.jsonl. */
export interface GoldLine {
  raw: string;
  sku_id: string | null;            // null = ambiguous or out-of-catalog
  qty: number | null;
  unit: OrderUnit;
  ambiguous?: boolean;
  acceptable_sku_ids?: string[];    // for ambiguous lines: any of these is a defensible pick
  out_of_catalog?: boolean;
}
export interface GoldOrder {
  order_id: string;
  data_label: "SYNTHETIC";
  channel: "whatsapp" | "email";
  retailer: string;
  text: string;
  tags: string[];
  lines: GoldLine[];
}
