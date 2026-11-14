// In-browser stand-in for src/server/app.ts. Same pipeline, same calibrator and threshold file, same serialisers and
// approve rules, same CSV exporter, so the JSON it returns is the API.md wire format. All backend imports live here.
import { catalogFromCsv, skuLabel } from "../../../../src/catalog/load.ts";
import { MockDecisionAdapter } from "../../../../src/decide/mock.ts";
import { orderToCsv, unitsTotal, type ApprovedLine, type ApprovedOrder } from "../../../../src/export/exporter.ts";
import { RulesExtractor } from "../../../../src/extract/extractor.ts";
import { groupMessages, parseWhatsAppExport } from "../../../../src/intake/whatsapp.ts";
import { MAX_LINES_PER_ORDER, TooManyLinesError, processOrder } from "../../../../src/pipeline.ts";
import { HybridRetriever } from "../../../../src/retrieve/retriever.ts";
import { IsotonicCalibrator } from "../../../../src/route/calibrate.ts";
import { OverlapScorer } from "../../../../src/route/overlap.ts";
import { NONE, type IncomingOrder, type OrderUnit, type ResolvedLine, type Sku } from "../../../../src/types.ts";
import calibration from "../../../../reports/eval-mock.calibration.json";
import appConfig from "../../../../config/app.json";
import type { WireApproveRequest, WireCatalogInfo, WireCatalogUpload, WireHealth, WireImportOptions, WireImportResult, WireImportSkipped, WireLine, WireOrder, WireParseRequest, WireSku, WireSource } from "../wire.ts";

const UNITS: OrderUnit[] = ["pc", "dozen", "case", "strip"];
const MAX_ORDER_CHARS = 20_000, MAX_BODY = 5 * 1024 * 1024;
const MIN_OVERLAP: number = (appConfig.decision as { minLexicalOverlap?: number }).minLexicalOverlap ?? 0.55;   // app.ts default 0.55
// Runtime defaults come from the backend's own config/app.json, as main.ts reads them (env overrides don't apply in the browser).
const TOP_K = appConfig.decision.topK;
const DEFAULT_UNIT = (["pc", "dozen", "case", "strip"] as const).find(u => u === appConfig.units.defaultUnitForBareNumber) ?? null;
const DESC_STYLE = appConfig.decision.descStyle as NonNullable<ConstructorParameters<typeof MockDecisionAdapter>[1]>["descStyle"];            // milestone 3 server default (config/app.json defaultUnit)
const MAX_ORDERS_PER_IMPORT = appConfig.whatsappImport.maxOrdersPerImport;
export const SHEETS_STATUS = "no spreadsheet id (config sheets.spreadsheetId or env SHEETS_SPREADSHEET_ID)";
const round = (n: number, d = 4) => Number(n.toFixed(d));

export class WireError extends Error {
  status: number; code: string; details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) { super(message); this.status = status; this.code = code; this.details = details; }
}

const skuJson = (s: Sku): WireSku => ({ sku_id: s.skuId, label: skuLabel(s), brand: s.brand, product: s.product, variant: s.variant,
  pack_size: s.packSize, pack_unit: s.packUnit, mrp_inr: s.mrpInr, case_qty: s.caseQty, strip_qty: s.stripQty });

/** What we persist per order: the wire JSON plus the SKUs it references (so approve works after a catalog swap). */
export interface StoredOrder { wire: WireOrder; skus: Record<string, Sku>; routes: ("auto" | "review")[]; reasons: string[] }

export class MockServer {
  private skus: Sku[] = []; private byId = new Map<string, Sku>();
  private extractor!: RulesExtractor; private retriever!: HybridRetriever; private overlap!: OverlapScorer;
  private decider = new MockDecisionAdapter(0.5, { descStyle: DESC_STYLE });   // same arguments as src/server/main.ts
  private calibrator = IsotonicCalibrator.fromJSON(calibration.calibrator);
  readonly threshold: number = calibration.threshold;
  info!: WireCatalogInfo;

  constructor(catalogCsv: string, source: "synthetic" | "uploaded", loadedAt?: string) { this.setCatalog(catalogCsv, source, loadedAt); }

  setCatalog(csv: string, source: "synthetic" | "uploaded", loadedAt = new Date().toISOString()) {
    const r = catalogFromCsv(csv);
    if (r.errors.length) throw new WireError(422, "invalid_catalog", "Catalog rejected; the current catalog is unchanged.", { errors: r.errors.slice(0, 50), warnings: r.warnings, columns: r.columns });
    this.skus = r.skus; this.byId = new Map(r.skus.map(s => [s.skuId, s]));
    this.extractor = new RulesExtractor(r.skus); this.retriever = new HybridRetriever(r.skus); this.overlap = new OverlapScorer(r.skus);
    this.info = { source, version: `${source === "synthetic" ? "syn" : "up"}-${Date.parse(loadedAt).toString(36)}`, sku_count: r.skus.length, loaded_at: loadedAt, data_label: source === "synthetic" ? "SYNTHETIC" : "UPLOADED" };
    return r;
  }

  health(): WireHealth {
    return { ok: true, adapter: this.decider.name, threshold: this.threshold, top_k: TOP_K, default_unit: DEFAULT_UNIT, allow_unspecified_unit: false, llm_fallback: false,
      calibration: { file: "reports/eval-mock.calibration.json", data_label: calibration.data_label, target_precision: calibration.target_precision, threshold: calibration.threshold },
      catalog: this.info, sheets_export_configured: false, sheets_status: SHEETS_STATUS,
      limits: { max_body_bytes: MAX_BODY, max_order_chars: MAX_ORDER_CHARS, max_lines_per_order: MAX_LINES_PER_ORDER }, min_lexical_overlap: MIN_OVERLAP, auth_required: false };
  }

  private lineJson(l: ResolvedLine, i: number): WireLine {
    const chosen = l.decision.choice === NONE ? null : this.byId.get(l.decision.choice) ?? l.candidates.find(c => c.sku.skuId === l.decision.choice)?.sku ?? null;
    const candById = new Map(l.candidates.map(c => [c.sku.skuId, c.sku]));
    const ranked = [...l.decision.probabilities].sort((a, b) => b.p - a.p);
    const alternatives = ranked.filter(p => p.skuId !== l.decision.choice).slice(0, 5).map(p => {
      const s = p.skuId === NONE ? null : candById.get(p.skuId) ?? this.byId.get(p.skuId) ?? null;
      return { sku_id: p.skuId === NONE ? null : p.skuId, label: s ? skuLabel(s) : "None of these", none_of_these: p.skuId === NONE, p: round(p.p), mrp_inr: s?.mrpInr ?? null };
    });
    for (const id of l.ambiguousWith ?? []) if (id !== l.decision.choice && !alternatives.some(a => a.sku_id === id)) {
      const s = candById.get(id) ?? this.byId.get(id);
      if (s) alternatives.push({ sku_id: id, label: skuLabel(s), none_of_these: false, p: round(l.decision.probabilities.find(p => p.skuId === id)?.p ?? 0), mrp_inr: s.mrpInr });
    }
    return {
      line_id: l.line.lineId, line_no: i + 1, raw: l.line.raw, item_text: l.line.itemText, qty: l.line.qty, unit: l.line.unit,
      unit_defaulted: !!l.line.unitDefaulted, extracted_by: l.line.extractor, size_hint: l.line.sizeHint, price_hint: l.line.priceHint, sku: chosen ? skuJson(chosen) : null, none_of_these: l.decision.choice === NONE,
      confidence: round(l.decision.confidence), calibrated_confidence: round(l.calibratedConfidence),
      lexical_overlap: l.lexicalOverlap == null ? null : round(l.lexicalOverlap, 3), sku_in_current_catalog: chosen ? this.byId.has(chosen.skuId) : null,
      needs_review: l.route === "review", review_reasons: l.reason === "ok" ? [] : l.reason.split(","), ambiguous_with: l.ambiguousWith ?? [], alternatives,
    };
  }

  async parse(body: WireParseRequest, existing: Set<string>, now = new Date().toISOString()): Promise<StoredOrder> {
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) throw new WireError(400, "text_required", "Body must include a non-empty 'text' (the pasted order).");
    if (text.length > MAX_ORDER_CHARS) throw new WireError(413, "text_too_long", `Order text is over ${MAX_ORDER_CHARS} characters.`);
    const channel = body.channel && ["whatsapp", "email", "manual"].includes(body.channel) ? body.channel : "manual";
    if (body.order_id != null && !(typeof body.order_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.order_id)))
      throw new WireError(400, "bad_order_id", "'order_id' must be 1–64 characters of A–Z, a–z, 0–9, '_' or '-'. Leave it out to get a generated id.");
    const orderId: string = body.order_id ?? `ord_${crypto.randomUUID().slice(0, 8)}`;
    if (existing.has(orderId)) throw new WireError(409, "order_exists", `Order ${orderId} already exists.`);
    const retailerId = typeof body.retailer_id === "string" ? body.retailer_id.slice(0, 64) : undefined;
    return this.runOrder({ orderId, channel, retailerId, text, receivedAt: now }, { kind: "paste" });
  }

  private async runOrder(incoming: IncomingOrder, source: WireSource): Promise<StoredOrder> {
    const { orderId, retailerId, channel, text } = incoming;
    let r: Awaited<ReturnType<typeof processOrder>>;
    try {
      r = await processOrder(incoming, { extractor: this.extractor, retriever: this.retriever, decider: this.decider, calibrator: this.calibrator,
        policy: { threshold: this.threshold, allowUnspecifiedUnit: false, ambiguity: "review", overlap: MIN_OVERLAP > 0 ? { scorer: this.overlap, floor: MIN_OVERLAP } : undefined },
        topK: TOP_K, defaultUnit: DEFAULT_UNIT });
    } catch (e) {
      if (e instanceof TooManyLinesError) throw new WireError(422, "too_many_lines", e.message, { lines: e.lines, max_lines: e.max });
      throw new WireError(502, "decision_provider_error", e instanceof Error ? e.message : String(e));
    }
    const lines = r.lines.map((l, i) => this.lineJson(l, i));
    const skus: Record<string, Sku> = {};
    for (const l of r.lines) for (const c of l.candidates) skus[c.sku.skuId] = c.sku;
    const x = r.extractionUsage; const usd = r.usage.costUsd + (x?.costUsd ?? 0);
    const wire: WireOrder = {
      order_id: orderId, status: "parsed", retailer_id: retailerId ?? null, channel, text, created_at: incoming.receivedAt!, adapter: this.decider.name,
      catalog_version: this.info.version, catalog_stale: false, threshold: this.threshold,
      summary: { lines: lines.length, auto: lines.filter(l => !l.needs_review).length, needs_review: lines.filter(l => l.needs_review).length },
      usage: { requests: r.usage.requests, input_tokens: r.usage.inputTokens, cost_usd: round(usd, 7), cost_inr_at_88: round(usd * 88, 5),
        llm_fallback: x && x.requests ? { requests: x.requests, input_tokens: x.inputTokens, output_tokens: x.outputTokens, lines: x.llmLines, cost_usd: round(x.costUsd, 7) } : null },
      lines, source, approved: null,
    };
    return { wire, skus, routes: r.lines.map(l => l.route), reasons: r.lines.map(l => l.reason) };
  }

  /** Port of app.ts importWhatsApp(): parse the export, group by sender burst (or message), one order per group with product lines. */
  async importWhatsApp(raw: string, q: WireImportOptions, existing: Set<string>): Promise<{ result: WireImportResult; stored: StoredOrder[] }> {
    if (!raw.trim()) throw new WireError(400, "text_required", "Send the exported chat .txt as the body (text/plain) or JSON {\"text\": \"...\"}.");
    const group = q.group === "message" || q.group === "burst" ? q.group : appConfig.whatsappImport.group as "burst" | "message";
    const burstMinutes = Number.isFinite(Number(q.burst_minutes)) && Number(q.burst_minutes) > 0 ? Number(q.burst_minutes) : appConfig.whatsappImport.burstMinutes;
    const exclude = (q.exclude_senders ?? []).map(String).filter(Boolean);
    const parsed = parseWhatsAppExport(raw, { dateOrder: q.date_order === "dmy" || q.date_order === "mdy" ? q.date_order : "auto" });
    if (!parsed.messages.length) throw new WireError(422, "no_messages", "No WhatsApp messages found. Expected lines like '14/11/26, 9:05 am - Name: text' (Android) or '[14/11/26, 9:05:12 AM] Name: text' (iOS).");
    const groups = groupMessages(parsed.messages, { group, burstMinutes, exclude });
    if (groups.length > MAX_ORDERS_PER_IMPORT) throw new WireError(413, "too_many_orders", `Export has ${groups.length} candidate orders; the limit per import is ${MAX_ORDERS_PER_IMPORT}. Trim the export or raise whatsappImport.maxOrdersPerImport.`);
    let importId = `wa_${crypto.randomUUID().slice(0, 8)}`; while (existing.has(`${importId}_1`)) importId = `wa_${crypto.randomUUID().slice(0, 8)}`;
    const stored: StoredOrder[] = []; const skipped: WireImportSkipped[] = [];
    for (const [i, g] of groups.entries()) {
      if (g.text.length > MAX_ORDER_CHARS) { skipped.push({ sender: g.sender, at: g.firstAt, reason: "text_too_long", text: g.text.slice(0, 200) }); continue; }
      let o: StoredOrder;
      try {
        o = await this.runOrder({ orderId: `${importId}_${i + 1}`, channel: "whatsapp", retailerId: g.sender.slice(0, 64), text: g.text, receivedAt: g.firstAt },
          { kind: "whatsapp_export", import_id: importId, sender: g.sender, first_at: g.firstAt, last_at: g.lastAt, message_count: g.messageCount, first_line: g.firstLine });
      } catch (e) {
        // Same as app.ts: an oversized group is skipped; any other failure aborts the whole import and nothing is stored.
        if (e instanceof WireError && e.code === "too_many_lines") { skipped.push({ sender: g.sender, at: g.firstAt, reason: "too_many_lines", text: g.text.slice(0, 200) }); continue; }
        if (e instanceof WireError) throw new WireError(e.status, e.code, `${e.message} Nothing from this import was saved; it is safe to retry.`, { import_id: importId, failed_group: i + 1, orders_saved: 0 });
        throw e;
      }
      if (!o.wire.lines.length) { skipped.push({ sender: g.sender, at: g.firstAt, reason: "no_product_lines", text: g.text.slice(0, 200) }); continue; }
      stored.push(o);
    }
    const js = stored.map(o => o.wire);
    return { stored, result: { import_id: importId, format: parsed.format, date_order: parsed.dateOrder, group, burst_minutes: burstMinutes,
      messages: parsed.messages.length, system_lines: parsed.systemLines, media_skipped: parsed.skippedMedia,
      summary: { orders: js.length, skipped: skipped.length, lines: js.reduce((a, o) => a + o.summary.lines, 0),
        auto: js.reduce((a, o) => a + o.summary.auto, 0), needs_review: js.reduce((a, o) => a + o.summary.needs_review, 0),
        cost_inr_at_88: round(js.reduce((a, o) => a + o.usage.cost_inr_at_88, 0), 5) },
      orders: js, skipped } };
  }

  /** Same rules as app.ts approve(): unlisted review lines are unresolved, overrides win, qty/unit validated. */
  approve(o: StoredOrder, body: WireApproveRequest, now = new Date().toISOString()): WireOrder {
    if (o.wire.status === "approved") throw new WireError(409, "already_approved", `Order ${o.wire.order_id} is already approved.`);
    if (!o.wire.lines.length) throw new WireError(422, "no_product_lines", "This order has no product lines, so there is nothing to approve.");
    const overrides = new Map<string, WireApproveRequest["lines"][number]>();
    for (const x of Array.isArray(body?.lines) ? body.lines : []) {
      if (typeof x?.line_id !== "string") throw new WireError(400, "bad_line", "Each entry in 'lines' needs a 'line_id'.");
      overrides.set(x.line_id, x);
    }
    const known = new Set(o.wire.lines.map(l => l.line_id));
    const unknown = [...overrides.keys()].filter(k => !known.has(k));
    if (unknown.length) throw new WireError(400, "unknown_line", "Unknown line_id(s).", { line_ids: unknown });
    const unresolved: { line_id: string; problem: string }[] = []; const lines: ApprovedLine[] = [];
    o.wire.lines.forEach((l, i) => {
      const ov = overrides.get(l.line_id);
      if (!ov && o.routes[i] === "review") { unresolved.push({ line_id: l.line_id, problem: `needs review (${o.reasons[i]})` }); return; }
      const skuId: string | null = ov ? (ov.sku_id ?? null) : l.sku?.sku_id ?? null;
      const sku = skuId ? this.byId.get(skuId) ?? o.skus[skuId] : undefined;
      if (skuId && !sku) { unresolved.push({ line_id: l.line_id, problem: `unknown sku_id ${skuId}` }); return; }
      const qty = ov?.qty ?? l.qty; const unit: OrderUnit = ov?.unit ?? l.unit;
      if (skuId) {
        if (typeof qty !== "number" || !(qty > 0) || qty > 100000) { unresolved.push({ line_id: l.line_id, problem: "qty must be a positive number" }); return; }
        if (!UNITS.includes(unit)) { unresolved.push({ line_id: l.line_id, problem: `unit must be one of ${UNITS.join(", ")}` }); return; }
      }
      lines.push({ lineNo: i + 1, lineId: l.line_id, raw: l.raw, skuId, label: sku ? skuLabel(sku) : "", qty: qty ?? 0, unit,
        unitsTotal: sku && typeof qty === "number" ? unitsTotal(qty, unit, sku.caseQty, sku.stripQty) : null, mrpInr: sku?.mrpInr ?? null, source: ov ? "reviewed" : "auto" });
    });
    if (unresolved.length) throw new WireError(422, "unresolved_lines", "Some lines still need a decision.", { lines: unresolved });
    const approvedBy = typeof body?.approved_by === "string" && body.approved_by.trim() ? body.approved_by.trim().slice(0, 64) : "reviewer";
    const a: ApprovedOrder = { orderId: o.wire.order_id, retailerId: o.wire.retailer_id ?? undefined, approvedBy, approvedAt: now, lines };
    o.wire.status = "approved";
    o.wire.approved = { order_id: a.orderId, approved_by: a.approvedBy, approved_at: a.approvedAt,
      lines: a.lines.map(l => ({ line_id: l.lineId, line_no: l.lineNo, status: l.skuId ? "ok" : "skipped", sku_id: l.skuId, label: l.label, qty: l.qty, unit: l.unit, units_total: l.unitsTotal, mrp_inr: l.mrpInr, source: l.source })),
      // The catalog may have been replaced since parsing; flag SKUs the current item master doesn't have (app.ts approveWarnings).
      warnings: lines.filter(l => l.skuId && !this.byId.has(l.skuId)).map(l => ({ line_id: l.lineId, code: "sku_not_in_current_catalog", sku_id: l.skuId!,
        message: `${l.skuId} is not in the current catalog (${this.info.version}); a DMS/Tally import may reject it.` })) };
    return this.view(o);
  }

  /** Wire JSON as the server would serialise it now: catalog_stale and sku_in_current_catalog are computed against the loaded catalog. */
  view(o: StoredOrder): WireOrder {
    const w = structuredClone(o.wire);
    w.catalog_stale = w.catalog_version !== this.info.version;
    for (const l of w.lines) l.sku_in_current_catalog = l.sku ? this.byId.has(l.sku.sku_id) : null;
    if (w.approved) w.approved.warnings ??= [];
    return w;
  }

  exportCsv(o: StoredOrder): string {
    const a = o.wire.approved;
    if (!a) throw new WireError(409, "not_approved", "Approve the order before exporting.");
    const byId = new Map(o.wire.lines.map(l => [l.line_id, l]));
    return orderToCsv({ orderId: a.order_id, retailerId: o.wire.retailer_id ?? undefined, approvedBy: a.approved_by, approvedAt: a.approved_at,
      lines: a.lines.map(l => ({ lineNo: l.line_no, lineId: l.line_id, raw: byId.get(l.line_id)?.raw ?? "", skuId: l.sku_id, label: l.label, qty: l.qty, unit: l.unit, unitsTotal: l.units_total, mrpInr: l.mrp_inr, source: l.source })) });
  }

  search(q: string, limit: number): WireSku[] {
    limit = Math.min(50, Math.max(1, limit || 20));
    if (!q.trim()) return this.skus.slice(0, limit).map(skuJson);
    const line = { lineId: "search", orderId: "search", raw: q, itemText: q.toLowerCase(), qty: null, unit: "unspecified" as const, sizeHint: null, priceHint: null, extractor: "rules" as const };
    return this.retriever.shortlist(line, limit).map(c => skuJson(c.sku));
  }

  upload(csv: string): WireCatalogUpload {
    if (!csv.trim()) throw new WireError(400, "empty_catalog", "Send the catalog CSV as the request body (Content-Type: text/csv) or as JSON {\"csv\": \"...\"}.");
    const r = this.setCatalog(csv, "uploaded");
    return { ...this.info, warnings: r.warnings, columns: r.columns,
      note: "Confidence threshold was calibrated on the synthetic catalog; re-run calibration on labelled orders for this catalog before trusting auto-accept." };
  }
}
