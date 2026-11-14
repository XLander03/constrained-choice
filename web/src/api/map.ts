// The only wire → UI conversion. Shared by HttpClient and MockClient so the mock can't drift from the contract silently.
import { REVIEW_REASONS, type Alternative, type ApprovedLine, type CatalogInfo, type CatalogUploadResult, type Health, type Order, type OrderListItem, type ParsedLine, type ReviewReason, type SkuSummary } from "./types.ts";
import type { ImportResult, OrderSource } from "./types.ts";
import type { WireCatalogInfo, WireCatalogUpload, WireHealth, WireImportResult, WireLine, WireOrder, WireOrderListItem, WireSku, WireSource } from "./wire.ts";

export const mapSku = (s: WireSku): SkuSummary => ({
  skuId: s.sku_id, label: s.label, brand: s.brand, product: s.product, variant: s.variant, packSize: s.pack_size,
  packUnit: s.pack_unit, mrpInr: s.mrp_inr, caseQty: s.case_qty, stripQty: s.strip_qty,
});

const isReason = (r: string): r is ReviewReason => (REVIEW_REASONS as readonly string[]).includes(r);

export function mapLine(l: WireLine): ParsedLine {
  const amb = new Set(l.ambiguous_with);
  const alts: Alternative[] = l.alternatives.filter(a => !a.none_of_these && a.sku_id)
    .map(a => ({ sku: { skuId: a.sku_id!, label: a.label, mrpInr: a.mrp_inr }, p: a.p, fits: amb.has(a.sku_id!) }));
  // The model's own pick is not in alternatives (API returns the others); offer it too so 1–n covers every fitting pack.
  if (l.sku && amb.size && !alts.some(a => a.sku.skuId === l.sku!.sku_id)) alts.push({ sku: mapSku(l.sku), p: l.confidence, fits: true });
  alts.sort((a, b) => Number(b.fits) - Number(a.fits) || b.p - a.p);
  const none = l.alternatives.find(a => a.none_of_these);
  return {
    lineId: l.line_id, lineNo: l.line_no, raw: l.raw, itemText: l.item_text, qty: l.qty, unit: l.unit,
    unitDefaulted: !!l.unit_defaulted, extractedBy: l.extracted_by === "llm" ? "llm" : "rules",
    sizeHint: l.size_hint, priceHint: l.price_hint, choice: l.sku ? mapSku(l.sku) : null, noneOfThese: l.none_of_these,
    rawConfidence: l.confidence, confidence: l.calibrated_confidence,
    lexicalOverlap: l.lexical_overlap ?? null, skuInCurrentCatalog: l.sku_in_current_catalog ?? null, route: l.needs_review ? "review" : "auto",
    reasons: l.review_reasons.filter(isReason), otherReasons: l.review_reasons.filter(r => !isReason(r)),
    ambiguousWith: l.ambiguous_with, alternatives: alts, pNone: none ? none.p : null,
  };
}

export function mapOrder(o: WireOrder): Order {
  const lines = o.lines.map(mapLine);
  const byId = new Map(lines.map(l => [l.lineId, l]));
  let approved: Order["approved"] = null;
  if (o.approved) {
    const al: ApprovedLine[] = o.approved.lines.map(a => {
      const p = byId.get(a.line_id);
      const changed = !!p && (a.sku_id !== (p.choice?.skuId ?? null) || a.qty !== (p.qty ?? 0) || a.unit !== p.unit);
      return {
        lineId: a.line_id, lineNo: a.line_no, status: a.status, skuId: a.sku_id, label: a.label, qty: a.qty, unit: a.unit,
        unitsTotal: a.units_total, mrpInr: a.mrp_inr, source: a.source,
        amountInr: a.units_total != null && a.mrp_inr != null ? a.units_total * a.mrp_inr : null, changed,
      };
    });
    approved = { approvedBy: o.approved.approved_by, approvedAt: o.approved.approved_at, lines: al, totalInr: al.reduce((s, l) => s + (l.amountInr ?? 0), 0),
      warnings: (o.approved.warnings ?? []).map(w => ({ lineId: w.line_id, code: w.code, skuId: w.sku_id, message: w.message })) };
  }
  return {
    orderId: o.order_id, status: o.status, retailer: o.retailer_id, channel: o.channel, text: o.text, createdAt: o.created_at,
    adapter: o.adapter, catalogVersion: o.catalog_version, catalogStale: !!o.catalog_stale, threshold: o.threshold,
    summary: { lines: o.summary.lines, auto: o.summary.auto, needsReview: o.summary.needs_review },
    usage: { requests: o.usage.requests, inputTokens: o.usage.input_tokens, costUsd: o.usage.cost_usd, costInr: o.usage.cost_inr_at_88,
      llmFallback: o.usage.llm_fallback ? { requests: o.usage.llm_fallback.requests, inputTokens: o.usage.llm_fallback.input_tokens,
        outputTokens: o.usage.llm_fallback.output_tokens, lines: o.usage.llm_fallback.lines, costUsd: o.usage.llm_fallback.cost_usd } : null },
    lines, source: mapSource(o.source), approved,
  };
}

const mapSource = (s: WireSource | undefined): OrderSource => s && s.kind === "whatsapp_export"
  ? { kind: "whatsapp_export", importId: s.import_id, sender: s.sender, firstAt: s.first_at, lastAt: s.last_at, messageCount: s.message_count, firstLine: s.first_line }
  : { kind: "paste" };

export const mapImport = (r: WireImportResult): ImportResult => ({
  importId: r.import_id, format: r.format, dateOrder: r.date_order, group: r.group, burstMinutes: r.burst_minutes,
  messages: r.messages, systemLines: r.system_lines, mediaSkipped: r.media_skipped,
  summary: { orders: r.summary.orders, skipped: r.summary.skipped, lines: r.summary.lines, auto: r.summary.auto, needsReview: r.summary.needs_review, costInr: r.summary.cost_inr_at_88 },
  orders: r.orders.map(mapOrder), skipped: r.skipped,
});

export const mapListItem = (o: WireOrderListItem): OrderListItem => ({
  orderId: o.order_id, status: o.status, createdAt: o.created_at, retailer: o.retailer_id,
  summary: { lines: o.summary.lines, auto: o.summary.auto, needsReview: o.summary.needs_review },
  channel: o.channel ?? null, textPreview: o.text_preview ?? null, sourceKind: o.source_kind ?? null,
});

export const mapCatalogInfo = (c: WireCatalogInfo): CatalogInfo => ({ source: c.source, version: c.version, skuCount: c.sku_count, loadedAt: c.loaded_at, dataLabel: c.data_label });
export const mapCatalogUpload = (c: WireCatalogUpload): CatalogUploadResult => ({ ...mapCatalogInfo(c), warnings: c.warnings, columns: c.columns, note: c.note });

export const mapHealth = (h: WireHealth): Health => ({
  adapter: h.adapter, threshold: h.threshold, topK: h.top_k, allowUnspecifiedUnit: h.allow_unspecified_unit,
  calibration: h.calibration ? { file: h.calibration.file, dataLabel: h.calibration.data_label, targetPrecision: h.calibration.target_precision, threshold: h.calibration.threshold } : null,
  catalog: mapCatalogInfo(h.catalog), sheetsExportConfigured: h.sheets_export_configured,
  defaultUnit: h.default_unit === undefined ? null : h.default_unit, llmFallback: !!h.llm_fallback,
  limits: { maxBodyBytes: h.limits?.max_body_bytes ?? 5 * 1024 * 1024, maxOrderChars: h.limits?.max_order_chars ?? 20_000, maxLinesPerOrder: h.limits?.max_lines_per_order ?? 400 },
  minLexicalOverlap: h.min_lexical_overlap ?? null, authRequired: !!h.auth_required,
  sheetsStatus: h.sheets_status ?? (h.sheets_export_configured ? "ready" : "Google Sheets export isn't configured on the server"),
});
