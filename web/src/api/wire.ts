// Wire format of the decision-engine HTTP API, transcribed from /workspace/decision-engine/API.md (milestone 5). Fields added after milestone 2 are optional so older servers still parse.
// snake_case on purpose: these types describe JSON on the wire. The UI works with the camelCase types in types.ts,
// and map.ts is the only place that converts. Both HttpClient and MockClient produce exactly these shapes.

export type WireUnit = "pc" | "dozen" | "case" | "strip" | "unspecified";
export type WireChannel = "whatsapp" | "email" | "manual";
export type WireReason = "none_of_these" | "refused" | "qty_missing" | "unit_unspecified" | "pack_size_ambiguous" | "variant_ambiguous" | "low_confidence" | "low_overlap";

export interface WireSku {
  sku_id: string; label: string; brand: string; product: string; variant: string;
  pack_size: number; pack_unit: string; mrp_inr: number; case_qty: number; strip_qty: number | null;
}

export interface WireAlternative { sku_id: string | null; label: string; none_of_these: boolean; p: number; mrp_inr: number | null }

export interface WireLine {
  line_id: string; line_no: number; raw: string; item_text: string;
  qty: number | null; unit: WireUnit;
  /** milestone 3: bare number, unit came from the distributor default (case). Optional so milestone-2 servers still parse. */
  unit_defaulted?: boolean; extracted_by?: "rules" | "llm";
  size_hint: { value: number; unit: string } | null; price_hint: number | null;
  sku: WireSku | null; none_of_these: boolean;
  confidence: number; calibrated_confidence: number;
  /** milestone 5: share of the line's words the picked SKU explains (0–1), null when there is no pick / nothing to judge. */
  lexical_overlap?: number | null;
  /** milestone 5: false when the catalog was replaced after parsing and no longer has the picked SKU; null without a pick. */
  sku_in_current_catalog?: boolean | null;
  needs_review: boolean; review_reasons: string[];   // WireReason values; kept as string so unknown future codes don't break parsing
  ambiguous_with: string[];
  alternatives: WireAlternative[];
}

export interface WireApprovedLine {
  line_id: string; line_no: number; status: "ok" | "skipped"; sku_id: string | null; label: string;
  qty: number; unit: WireUnit; units_total: number | null; mrp_inr: number | null; source: "auto" | "reviewed";
}
export interface WireApproveWarning { line_id: string; code: "sku_not_in_current_catalog" | string; sku_id: string; message: string }
export interface WireApproved { order_id: string; approved_by: string; approved_at: string; lines: WireApprovedLine[]; warnings?: WireApproveWarning[] }

export interface WireSummary { lines: number; auto: number; needs_review: number }
export interface WireLlmFallbackUsage { requests: number; input_tokens: number; output_tokens: number; lines: number; cost_usd: number }
export interface WireUsage { requests: number; input_tokens: number; cost_usd: number; cost_inr_at_88: number; llm_fallback?: WireLlmFallbackUsage | null }

export type WireSource =
  | { kind: "paste" }
  | { kind: "whatsapp_export"; import_id: string; sender: string; first_at: string; last_at: string; message_count: number; first_line: number };

export interface WireOrder {
  order_id: string; status: "parsed" | "approved"; retailer_id: string | null; channel: WireChannel; text: string; created_at: string;
  adapter: string; catalog_version: string; catalog_stale?: boolean; threshold: number; summary: WireSummary; usage: WireUsage;
  lines: WireLine[]; source?: WireSource; approved: WireApproved | null;
}

export interface WireOrderListItem {
  order_id: string; status: "parsed" | "approved"; created_at: string; retailer_id: string | null; summary: WireSummary;
  channel?: WireChannel; text_preview?: string; source_kind?: WireSource["kind"];
}
export interface WireOrderList { orders: WireOrderListItem[] }
/** GET /orders?detail=1 */
export interface WireOrderDetailList { orders: WireOrder[] }

export interface WireParseRequest { text: string; channel?: WireChannel; retailer_id?: string; order_id?: string }
export interface WireImportOptions { group?: "burst" | "message"; burst_minutes?: number; exclude_senders?: string[]; date_order?: "auto" | "dmy" | "mdy" }
export interface WireImportSkipped { sender: string; at: string; reason: "no_product_lines" | "text_too_long" | string; text: string }
export interface WireImportResult {
  import_id: string; format: "android" | "ios" | "mixed" | "unknown"; date_order: "dmy" | "mdy"; group: "burst" | "message"; burst_minutes: number;
  messages: number; system_lines: number; media_skipped: number;
  summary: { orders: number; skipped: number; lines: number; auto: number; needs_review: number; cost_inr_at_88: number };
  orders: WireOrder[]; skipped: WireImportSkipped[];
}
export interface WireSheetsResult { location: string; updatedRange?: string; rows?: number }

export interface WireApproveRequest {
  approved_by?: string;
  lines: { line_id: string; sku_id: string | null; qty?: number; unit?: Exclude<WireUnit, "unspecified"> }[];
}

export interface WireCatalogInfo { source: "synthetic" | "uploaded"; version: string; sku_count: number; loaded_at: string; data_label: "SYNTHETIC" | "UPLOADED" }
export interface WireCatalogSearch extends WireCatalogInfo { items: WireSku[] }
export interface WireCatalogUpload extends WireCatalogInfo { warnings: string[]; columns: Record<string, string | null>; note: string }

export interface WireHealth {
  ok: boolean; adapter: string; threshold: number; top_k: number; allow_unspecified_unit: boolean;
  default_unit?: Exclude<WireUnit, "unspecified"> | null; llm_fallback?: boolean; sheets_status?: string;
  limits?: { max_body_bytes: number; max_order_chars: number; max_lines_per_order: number };
  min_lexical_overlap?: number; auth_required?: boolean;
  calibration: { file: string; data_label: string; target_precision: number; threshold: number } | null;
  catalog: WireCatalogInfo; sheets_export_configured: boolean;
}

export interface WireError { error: { code: string; message: string; details?: Record<string, unknown> } }
