// UI domain types (camelCase). Built from the wire format in wire.ts by map.ts.

export type OrderUnit = "pc" | "dozen" | "case" | "strip" | "unspecified";
export type KnownUnit = Exclude<OrderUnit, "unspecified">;
export const KNOWN_UNITS: readonly KnownUnit[] = ["pc", "dozen", "case", "strip"] as const;
export type Channel = "whatsapp" | "email" | "manual";

/** Why a line was routed to review (API.md review_reasons). */
export type ReviewReason = "none_of_these" | "refused" | "qty_missing" | "unit_unspecified" | "pack_size_ambiguous" | "variant_ambiguous" | "low_confidence" | "low_overlap";
export const REVIEW_REASONS: readonly ReviewReason[] = ["none_of_these", "refused", "qty_missing", "unit_unspecified", "pack_size_ambiguous", "variant_ambiguous", "low_confidence", "low_overlap"];

/** Minimum we know about a SKU from an alternative: id, label, MRP. */
export interface SkuRef { skuId: string; label: string; mrpInr: number | null }
/** Full SKU (parse `sku`, catalog search items). */
export interface SkuSummary extends SkuRef {
  brand: string; product: string; variant: string; packSize: number; packUnit: string;
  mrpInr: number; caseQty: number; stripQty: number | null;
}
export const isFullSku = (s: SkuRef | SkuSummary | null | undefined): s is SkuSummary => !!s && "caseQty" in s;

export interface Alternative { sku: SkuRef; p: number; /** in ambiguous_with: fits everything the line says */ fits: boolean }

export interface ParsedLine {
  lineId: string; lineNo: number; raw: string; itemText: string;
  qty: number | null; unit: OrderUnit;
  /** Retailer wrote a bare number; the unit is the distributor default ("assumed case"). Not a review reason by itself. */
  unitDefaulted: boolean;
  /** "llm" = the paid fallback read this line because the rules couldn't. */
  extractedBy: "rules" | "llm";
  sizeHint: { value: number; unit: string } | null; priceHint: number | null;
  /** Model's pick, or null for none_of_these / refusal. */
  choice: SkuSummary | null;
  noneOfThese: boolean;
  rawConfidence: number;
  /** Calibrated probability the pick is right; routing compares this to the order's threshold. */
  confidence: number;
  /** Share of the line's words the picked SKU explains (0–1); null when not judged. Below the server floor → low_overlap. */
  lexicalOverlap: number | null;
  /** false = the catalog was replaced after parsing and no longer has the picked SKU. null = no pick / older server. */
  skuInCurrentCatalog: boolean | null;
  route: "auto" | "review";
  reasons: ReviewReason[];
  /** Codes we don't have a label for yet (forward compatibility). */
  otherReasons: string[];
  ambiguousWith: string[];
  /** ambiguous_with first, then by probability. Excludes the none_of_these option. */
  alternatives: Alternative[];
  /** Probability on the none_of_these option, if the API returned it. */
  pNone: number | null;
}

export interface Usage {
  requests: number; inputTokens: number; costUsd: number; costInr: number;
  /** Paid LLM fallback for unparseable lines, when it ran (already included in costUsd / costInr). */
  llmFallback: { requests: number; inputTokens: number; outputTokens: number; lines: number; costUsd: number } | null;
}

export type OrderSource =
  | { kind: "paste" }
  | { kind: "whatsapp_export"; importId: string; sender: string; firstAt: string; lastAt: string; messageCount: number; firstLine: number };
export type OrderStatus = "parsed" | "approved";

export interface ApprovedLine {
  lineId: string; lineNo: number; status: "ok" | "skipped"; skuId: string | null; label: string;
  qty: number; unit: OrderUnit; unitsTotal: number | null; mrpInr: number | null; source: "auto" | "reviewed";
  /** units_total × MRP when both are known. */
  amountInr: number | null;
  /** Reviewer changed SKU, qty or unit versus the parse. */
  changed: boolean;
}
export interface ApproveWarning { lineId: string; code: string; skuId: string; message: string }
export interface Approval { approvedBy: string; approvedAt: string; lines: ApprovedLine[]; totalInr: number; warnings: ApproveWarning[] }

export interface Order {
  orderId: string; status: OrderStatus; retailer: string | null; channel: Channel; text: string; createdAt: string;
  adapter: string; catalogVersion: string; threshold: number;
  /** Parsed on an older catalog version than the one loaded now. */
  catalogStale: boolean;
  summary: { lines: number; auto: number; needsReview: number };
  usage: Usage; lines: ParsedLine[]; source: OrderSource; approved: Approval | null;
}

export interface ImportOptions { group: "burst" | "message"; burstMinutes: number; excludeSenders: string[]; dateOrder: "auto" | "dmy" | "mdy" }
export interface ImportResult {
  importId: string; format: "android" | "ios" | "mixed" | "unknown"; dateOrder: "dmy" | "mdy"; group: "burst" | "message"; burstMinutes: number;
  messages: number; systemLines: number; mediaSkipped: number;
  summary: { orders: number; skipped: number; lines: number; auto: number; needsReview: number; costInr: number };
  orders: Order[]; skipped: { sender: string; at: string; reason: string; text: string }[];
}

export interface OrderListItem {
  orderId: string; status: OrderStatus; createdAt: string; retailer: string | null; summary: Order["summary"];
  /** milestone 5 list fields (null from older servers). */
  channel: Channel | null; textPreview: string | null; sourceKind: OrderSource["kind"] | null;
}

/** Mock-only: an incoming WhatsApp/email message that hasn't been parsed yet (the backend has no intake queue yet). */
export interface IncomingMessage { messageId: string; channel: Channel; retailer: string; receivedAt: string; text: string }

export interface ParseRequest { text: string; channel: Channel; retailer?: string; orderId?: string }

export type LineDecisionInput = { lineId: string; skuId: string | null; qty?: number; unit?: KnownUnit };
export interface ApproveInput { approvedBy?: string; lines: LineDecisionInput[] }

export interface CatalogInfo { source: "synthetic" | "uploaded"; version: string; skuCount: number; loadedAt: string; dataLabel: "SYNTHETIC" | "UPLOADED" }
export interface CatalogUploadResult extends CatalogInfo { warnings: string[]; columns: Record<string, string | null>; note: string }

export interface Health {
  adapter: string; threshold: number; topK: number; allowUnspecifiedUnit: boolean;
  calibration: { file: string; dataLabel: string; targetPrecision: number; threshold: number } | null;
  catalog: CatalogInfo; sheetsExportConfigured: boolean;
  /** Unit applied to bare numbers ("maggi 5"); null = they go to review. */
  defaultUnit: KnownUnit | null;
  llmFallback: boolean;
  /** Why Sheets export is off ("ready" when configured). */
  sheetsStatus: string;
  limits: { maxBodyBytes: number; maxOrderChars: number; maxLinesPerOrder: number };
  minLexicalOverlap: number | null;
  authRequired: boolean;
}

export class ApiError extends Error {
  readonly status: number; readonly code: string; readonly details?: Record<string, unknown>;
  constructor(message: string, status: number, code = "error", details?: Record<string, unknown>) {
    super(message); this.name = "ApiError"; this.status = status; this.code = code; this.details = details;
  }
  /** 422 unresolved_lines → per-line problems. */
  get lineProblems(): { lineId: string; problem: string }[] {
    const l = this.details?.lines;
    return Array.isArray(l) ? l.flatMap(x => (x && typeof x === "object" && "line_id" in x) ? [{ lineId: String((x as { line_id: unknown }).line_id), problem: String((x as { problem?: unknown }).problem ?? "") }] : []) : [];
  }
  /** Auth / access problems the whole app reacts to (token prompt, blocked origin). */
  get isAuth(): boolean { return this.status === 401; }
  get isOriginBlocked(): boolean { return this.status === 403 && (this.code === "origin_not_allowed" || this.code === "host_not_allowed"); }
  /** Only a 502 (provider failed / timed out) or a network drop is worth retrying as-is. */
  get retryable(): boolean { return this.status === 502 || this.status === 0; }
  /** 422 invalid_catalog → row errors. */
  get catalogErrors(): string[] { const e = this.details?.errors; return Array.isArray(e) ? e.map(String) : []; }
}
