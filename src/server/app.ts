// HTTP API for the order desk. Plain node:http, no framework, JSON in/out.
// The front end is built separately against API.md. Everything here is in-memory + JSONL audit files under var/.
// Security (M5): only allow-listed browser origins get through (others → 403 before any work), an optional bearer token
// (API_TOKEN; required by main.ts when bound to a non-loopback address), and without a token only loopback Host headers
// are accepted (blocks DNS-rebinding pages).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { catalogFromCsv, loadCatalog, skuLabel } from "../catalog/load.ts";
import type { DecisionAdapter } from "../decide/adapter.ts";
import { GoogleSheetsExporter, NotConfiguredError, SheetsApiError, orderToCsv, unitsTotal, type ApprovedLine, type ApprovedOrder, type OrderExporter } from "../export/exporter.ts";
import { RulesExtractor, type LineExtractor } from "../extract/extractor.ts";
import { groupMessages, parseWhatsAppExport } from "../intake/whatsapp.ts";
import { MAX_LINES_PER_ORDER, TooManyLinesError, processOrder } from "../pipeline.ts";
import { HybridRetriever } from "../retrieve/retriever.ts";
import { IdentityCalibrator, type Calibrator } from "../route/calibrate.ts";
import { OverlapScorer } from "../route/overlap.ts";
import { JsonlReviewQueue } from "../route/reviewQueue.ts";
import { NONE, type IncomingOrder, type OrderUnit, type ResolvedLine, type ResolvedOrder, type Sku } from "../types.ts";

export const UNITS: OrderUnit[] = ["pc", "dozen", "case", "strip"];
const MAX_BODY = 5 * 1024 * 1024, MAX_ORDER_CHARS = 20_000;
const VERSION: string = (() => { try { return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "unknown"; } catch { return "unknown"; } })();
export const LIMITS = { max_body_bytes: MAX_BODY, max_order_chars: MAX_ORDER_CHARS, max_lines_per_order: MAX_LINES_PER_ORDER };

export interface ServerConfig {
  catalogPath: string; decider: DecisionAdapter; calibrator?: Calibrator; threshold: number;
  calibrationInfo?: Record<string, unknown>; topK?: number; allowUnspecifiedUnit?: boolean;
  /** Distributor policy for bare numbers ("maggi 5"); null = send to review. Milestone 3 default: "case". */
  defaultUnit?: OrderUnit | null;
  /** Wraps the rules extractor (e.g. the paid LLM fallback for unparseable lines). Called again after a catalog upload. */
  wrapExtractor?: (rules: LineExtractor) => LineExtractor;
  whatsapp?: { group: "burst" | "message"; burstMinutes: number; maxOrdersPerImport: number };
  dataDir?: string;                 // var/: uploaded catalog, review queue, approved orders (gitignored)
  sheets?: OrderExporter & { status?(): string | null };
  /** Browser origins allowed to call the API (exact match, e.g. "http://localhost:5173"). "*" = any (only sensible with apiToken).
   *  Requests without an Origin header (curl, server-to-server) are not affected. Default: the Vite dev ports 5173 and 5174 on localhost. */
  allowedOrigins?: string[];
  /** When set, every request except CORS preflight needs `Authorization: Bearer <token>` or `X-API-Key: <token>`. */
  apiToken?: string;
  /** Pick → review when the SKU explains less than this share of the line's words (IDF-weighted). 0 = off. Default 0.55. */
  minLexicalOverlap?: number;
}
export const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://localhost:5174"];

type SkuJson = ReturnType<typeof skuJson>;
const skuJson = (s: Sku) => ({ sku_id: s.skuId, label: skuLabel(s), brand: s.brand, product: s.product, variant: s.variant,
  pack_size: s.packSize, pack_unit: s.packUnit, mrp_inr: s.mrpInr, case_qty: s.caseQty, strip_qty: s.stripQty });

interface StoredOrder {
  orderId: string; retailerId?: string; channel: IncomingOrder["channel"]; text: string; createdAt: string;
  status: "parsed" | "approved"; adapter: string; catalogVersion: string; resolved: ResolvedOrder;
  source?: { kind: "whatsapp_export"; importId: string; sender: string; firstAt: string; lastAt: string; messageCount: number; firstLine: number };
  approved?: ApprovedOrder;
  approveWarnings?: { line_id: string; code: string; sku_id: string; message: string }[];
}

class HttpError extends Error {
  status: number; code: string; details?: unknown; close = false;
  constructor(status: number, code: string, message: string, details?: unknown, close = false) { super(message); this.status = status; this.code = code; this.details = details; this.close = close; }
}

export function createApp(cfg: ServerConfig) {
  const dataDir = cfg.dataDir ?? new URL("../../var/", import.meta.url).pathname;
  mkdirSync(dataDir, { recursive: true });
  const queue = new JsonlReviewQueue(`${dataDir}/review-queue.jsonl`);
  const sheets = cfg.sheets ?? new GoogleSheetsExporter();
  const orders = new Map<string, StoredOrder>();

  // ---- catalog state (swapped atomically on upload) ----
  let catalog!: { skus: Sku[]; byId: Map<string, Sku>; extractor: LineExtractor; retriever: HybridRetriever; overlap: OverlapScorer; source: string; version: string; loadedAt: string };
  const setCatalog = (skus: Sku[], source: string) => {
    catalog = { skus, byId: new Map(skus.map(s => [s.skuId, s])), overlap: new OverlapScorer(skus), extractor: cfg.wrapExtractor ? cfg.wrapExtractor(new RulesExtractor(skus)) : new RulesExtractor(skus), retriever: new HybridRetriever(skus),
      source, version: `${source === "synthetic" ? "syn" : "up"}-${Date.now().toString(36)}`, loadedAt: new Date().toISOString() };
  };
  const uploaded = `${dataDir}/catalog-uploaded.csv`;
  if (existsSync(uploaded)) { const r = catalogFromCsv(readFileSync(uploaded, "utf8")); if (!r.errors.length) setCatalog(r.skus, "uploaded"); }
  if (!catalog) setCatalog(loadCatalog(cfg.catalogPath), "synthetic");

  const calibrator = cfg.calibrator ?? new IdentityCalibrator();
  const policy = { threshold: cfg.threshold, allowUnspecifiedUnit: cfg.allowUnspecifiedUnit ?? false, ambiguity: "review" as const };
  const minOverlap = cfg.minLexicalOverlap ?? 0.55;
  const origins = new Set(cfg.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const tokenHash = cfg.apiToken ? createHash("sha256").update(cfg.apiToken).digest() : null;

  // ---- serialisers ----
  function lineJson(l: ResolvedLine, i: number) {
    const chosen = l.decision.choice === NONE ? null : catalog.byId.get(l.decision.choice) ?? l.candidates.find(c => c.sku.skuId === l.decision.choice)?.sku ?? null;
    const candById = new Map(l.candidates.map(c => [c.sku.skuId, c.sku]));
    const ranked = [...l.decision.probabilities].sort((a, b) => b.p - a.p);
    const alternatives = ranked.filter(p => p.skuId !== l.decision.choice).slice(0, 5).map(p => {
      const s = p.skuId === NONE ? null : candById.get(p.skuId) ?? catalog.byId.get(p.skuId) ?? null;
      return { sku_id: p.skuId === NONE ? null : p.skuId, label: s ? skuLabel(s) : "None of these", none_of_these: p.skuId === NONE, p: round(p.p), mrp_inr: s?.mrpInr ?? null };
    });
    // Same-family SKUs that fit the line equally well (pack size / variant not stated) are always offered.
    for (const id of l.ambiguousWith ?? []) if (id !== l.decision.choice && !alternatives.some(a => a.sku_id === id)) {
      const s = candById.get(id) ?? catalog.byId.get(id); if (s) alternatives.push({ sku_id: id, label: skuLabel(s), none_of_these: false, p: round(l.decision.probabilities.find(p => p.skuId === id)?.p ?? 0), mrp_inr: s.mrpInr });
    }
    return {
      line_id: l.line.lineId, line_no: i + 1, raw: l.line.raw, item_text: l.line.itemText,
      qty: l.line.qty, unit: l.line.unit, unit_defaulted: !!l.line.unitDefaulted, extracted_by: l.line.extractor, size_hint: l.line.sizeHint, price_hint: l.line.priceHint,
      sku: chosen ? skuJson(chosen) : null, none_of_these: l.decision.choice === NONE,
      confidence: round(l.decision.confidence), calibrated_confidence: round(l.calibratedConfidence),
      lexical_overlap: l.lexicalOverlap == null ? null : round(l.lexicalOverlap, 3),
      sku_in_current_catalog: chosen ? catalog.byId.has(chosen.skuId) : null,
      needs_review: l.route === "review", review_reasons: l.reason === "ok" ? [] : l.reason.split(","),
      ambiguous_with: l.ambiguousWith ?? [], alternatives,
    };
  }
  function orderJson(o: StoredOrder) {
    const lines = o.resolved.lines.map(lineJson);
    return {
      order_id: o.orderId, status: o.status, retailer_id: o.retailerId ?? null, channel: o.channel, text: o.text, created_at: o.createdAt,
      adapter: o.adapter, catalog_version: o.catalogVersion, catalog_stale: o.catalogVersion !== catalog.version, threshold: policy.threshold,
      summary: { lines: lines.length, auto: lines.filter(l => !l.needs_review).length, needs_review: lines.filter(l => l.needs_review).length },
      usage: usageJson(o.resolved),
      lines,
      source: o.source ? { kind: o.source.kind, import_id: o.source.importId, sender: o.source.sender, first_at: o.source.firstAt, last_at: o.source.lastAt,
        message_count: o.source.messageCount, first_line: o.source.firstLine } : { kind: "paste" },
      approved: o.approved ? { ...approvedJson(o.approved), warnings: o.approveWarnings ?? [] } : null,
    };
  }
  function usageJson(r: ResolvedOrder) {
    const x = r.extractionUsage; const usd = r.usage.costUsd + (x?.costUsd ?? 0);
    return { requests: r.usage.requests, input_tokens: r.usage.inputTokens, cost_usd: round(usd, 7), cost_inr_at_88: round(usd * 88, 5),
      llm_fallback: x && x.requests ? { requests: x.requests, input_tokens: x.inputTokens, output_tokens: x.outputTokens, lines: x.llmLines, cost_usd: round(x.costUsd, 7) } : null };
  }
  const approvedJson = (a: ApprovedOrder) => ({ order_id: a.orderId, approved_by: a.approvedBy, approved_at: a.approvedAt,
    lines: a.lines.map(l => ({ line_id: l.lineId, line_no: l.lineNo, status: l.skuId ? "ok" : "skipped", sku_id: l.skuId, label: l.label, qty: l.qty, unit: l.unit, units_total: l.unitsTotal, mrp_inr: l.mrpInr, source: l.source })) });

  // ---- handlers ----
  async function parse(body: any) {
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) throw new HttpError(400, "text_required", "Body must include a non-empty 'text' (the pasted order).");
    if (text.length > MAX_ORDER_CHARS) throw new HttpError(413, "text_too_long", `Order text is over ${MAX_ORDER_CHARS} characters.`);
    const channel = ["whatsapp", "email", "manual"].includes(body.channel) ? body.channel : "manual";
    if (body.order_id != null && !(typeof body.order_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.order_id)))
      throw new HttpError(400, "bad_order_id", "'order_id' must be 1–64 characters of A–Z, a–z, 0–9, '_' or '-'. Leave it out to get a generated id.");
    const orderId: string = body.order_id ?? `ord_${randomUUID().slice(0, 8)}`;
    if (orders.has(orderId)) throw new HttpError(409, "order_exists", `Order ${orderId} already exists.`);
    const retailerId = typeof body.retailer_id === "string" ? body.retailer_id.slice(0, 64) : undefined;
    const o = store(await resolveOrder({ orderId, channel, retailerId, text, receivedAt: new Date().toISOString() }));
    return { status: 201, json: orderJson(o) };
  }

  /** Runs the pipeline but stores nothing, so a caller (WhatsApp import) can commit a batch all-or-nothing. */
  async function resolveOrder(incoming: IncomingOrder, source?: StoredOrder["source"]): Promise<StoredOrder> {
    const { orderId, retailerId, channel, text } = incoming;
    let resolved: ResolvedOrder;
    try {
      resolved = await processOrder(incoming, { extractor: catalog.extractor, retriever: catalog.retriever, decider: cfg.decider, calibrator,
        policy: { ...policy, overlap: minOverlap > 0 ? { scorer: catalog.overlap, floor: minOverlap } : undefined },
        topK: cfg.topK ?? 8, defaultUnit: cfg.defaultUnit === undefined ? "case" : cfg.defaultUnit });
    } catch (e) {
      if (e instanceof TooManyLinesError) throw new HttpError(422, "too_many_lines", e.message, { lines: e.lines, max_lines: e.max });
      const msg = e instanceof Error ? e.message : String(e);
      throw new HttpError(/budget/.test(msg) ? 429 : 502, /budget/.test(msg) ? "token_budget_exceeded" : "decision_provider_error", msg);
    }
    return { orderId, retailerId, channel, text, createdAt: incoming.receivedAt!, status: "parsed", adapter: cfg.decider.name, catalogVersion: catalog.version, resolved, source };
  }
  function store(o: StoredOrder): StoredOrder {
    orders.set(o.orderId, o);
    for (const l of o.resolved.lines) if (l.route === "review") queue.enqueue(l);
    return o;
  }

  /** WhatsApp chat export (.txt) → one order per sender message or per contiguous burst. Groups with no product lines are skipped. */
  async function importWhatsApp(raw: string, q: any) {
    if (!raw.trim()) throw new HttpError(400, "text_required", "Send the exported chat .txt as the body (text/plain) or JSON {\"text\": \"...\"}.");
    const w = cfg.whatsapp ?? { group: "burst", burstMinutes: 15, maxOrdersPerImport: 200 };
    const group = q.group === "message" || q.group === "burst" ? q.group : w.group;
    const burstMinutes = Number.isFinite(Number(q.burst_minutes)) && Number(q.burst_minutes) > 0 ? Number(q.burst_minutes) : w.burstMinutes;
    const exclude: string[] = Array.isArray(q.exclude_senders) ? q.exclude_senders.map(String) : typeof q.exclude_senders === "string" ? q.exclude_senders.split(",") : [];
    const parsed = parseWhatsAppExport(raw, { dateOrder: ["dmy", "mdy"].includes(q.date_order) ? q.date_order : "auto" });
    if (!parsed.messages.length) throw new HttpError(422, "no_messages", "No WhatsApp messages found. Expected lines like '14/11/26, 9:05 am - Name: text' (Android) or '[14/11/26, 9:05:12 AM] Name: text' (iOS).");
    const groups = groupMessages(parsed.messages, { group, burstMinutes, exclude });
    if (groups.length > w.maxOrdersPerImport) throw new HttpError(413, "too_many_orders", `Export has ${groups.length} candidate orders; the limit per import is ${w.maxOrdersPerImport}. Trim the export or raise whatsappImport.maxOrdersPerImport.`);
    const importId = `wa_${randomUUID().slice(0, 8)}`; const created: StoredOrder[] = []; const skipped: unknown[] = [];
    // All-or-nothing: every group is resolved first and nothing is stored until all succeeded. A provider/budget error aborts the
    // whole import (no orphan orders, so a retry can't duplicate). Groups that are too long are skipped, not fatal.
    for (const [i, g] of groups.entries()) {
      if (g.text.length > MAX_ORDER_CHARS) { skipped.push({ sender: g.sender, at: g.firstAt, reason: "text_too_long", text: g.text.slice(0, 200) }); continue; }
      let o: StoredOrder;
      try {
        o = await resolveOrder({ orderId: `${importId}_${i + 1}`, channel: "whatsapp", retailerId: g.sender.slice(0, 64), text: g.text, receivedAt: g.firstAt },
          { kind: "whatsapp_export", importId, sender: g.sender, firstAt: g.firstAt, lastAt: g.lastAt, messageCount: g.messageCount, firstLine: g.firstLine });
      } catch (e) {
        if (e instanceof HttpError && e.code === "too_many_lines") { skipped.push({ sender: g.sender, at: g.firstAt, reason: "too_many_lines", text: g.text.slice(0, 200) }); continue; }
        if (e instanceof HttpError) throw new HttpError(e.status, e.code, `${e.message} Nothing from this import was saved; it is safe to retry.`, { import_id: importId, failed_group: i + 1, orders_saved: 0 });
        throw e;
      }
      if (!o.resolved.lines.length) { skipped.push({ sender: g.sender, at: g.firstAt, reason: "no_product_lines", text: g.text.slice(0, 200) }); continue; }
      created.push(o);
    }
    for (const o of created) store(o);
    const js = created.map(orderJson);
    return { status: 201, json: { import_id: importId, format: parsed.format, date_order: parsed.dateOrder, group, burst_minutes: burstMinutes,
      messages: parsed.messages.length, system_lines: parsed.systemLines, media_skipped: parsed.skippedMedia,
      summary: { orders: js.length, skipped: skipped.length, lines: js.reduce((a, o) => a + o.summary.lines, 0),
        auto: js.reduce((a, o) => a + o.summary.auto, 0), needs_review: js.reduce((a, o) => a + o.summary.needs_review, 0),
        cost_inr_at_88: round(js.reduce((a, o) => a + o.usage.cost_inr_at_88, 0), 5) },
      orders: js, skipped } };
  }

  function approve(o: StoredOrder, body: any) {
    if (o.status === "approved") throw new HttpError(409, "already_approved", `Order ${o.orderId} is already approved.`);
    if (!o.resolved.lines.length) throw new HttpError(422, "no_product_lines", "This order has no product lines, so there is nothing to approve.");
    const overrides = new Map<string, any>();
    for (const x of Array.isArray(body?.lines) ? body.lines : []) {
      if (typeof x?.line_id !== "string") throw new HttpError(400, "bad_line", "Each entry in 'lines' needs a 'line_id'.");
      overrides.set(x.line_id, x);
    }
    const known = new Set(o.resolved.lines.map(l => l.line.lineId));
    const unknown = [...overrides.keys()].filter(k => !known.has(k));
    if (unknown.length) throw new HttpError(400, "unknown_line", "Unknown line_id(s).", { line_ids: unknown });
    const unresolved: { line_id: string; problem: string }[] = []; const lines: ApprovedLine[] = [];
    o.resolved.lines.forEach((l, i) => {
      const ov = overrides.get(l.line.lineId);
      if (!ov && l.route === "review") { unresolved.push({ line_id: l.line.lineId, problem: `needs review (${l.reason})` }); return; }
      const skuId: string | null = ov ? (ov.sku_id ?? null) : l.decision.choice === NONE ? null : l.decision.choice;
      const sku = skuId ? catalog.byId.get(skuId) ?? l.candidates.find(c => c.sku.skuId === skuId)?.sku : undefined;
      if (skuId && !sku) { unresolved.push({ line_id: l.line.lineId, problem: `unknown sku_id ${skuId}` }); return; }
      const qty = ov?.qty ?? l.line.qty; const unit: OrderUnit = ov?.unit ?? l.line.unit;
      if (skuId) {
        if (typeof qty !== "number" || !(qty > 0) || qty > 100000) { unresolved.push({ line_id: l.line.lineId, problem: "qty must be a positive number" }); return; }
        if (!UNITS.includes(unit)) { unresolved.push({ line_id: l.line.lineId, problem: `unit must be one of ${UNITS.join(", ")}` }); return; }
      }
      lines.push({ lineNo: i + 1, lineId: l.line.lineId, raw: l.line.raw, skuId, label: sku ? skuLabel(sku) : "", qty: qty ?? 0, unit,
        unitsTotal: sku && typeof qty === "number" ? unitsTotal(qty, unit, sku.caseQty, sku.stripQty) : null, mrpInr: sku?.mrpInr ?? null,
        source: ov ? "reviewed" : "auto" });
    });
    if (unresolved.length) throw new HttpError(422, "unresolved_lines", "Some lines still need a decision.", { lines: unresolved });
    const approvedBy = typeof body?.approved_by === "string" && body.approved_by.trim() ? body.approved_by.trim().slice(0, 64) : "reviewer";
    o.approved = { orderId: o.orderId, retailerId: o.retailerId, approvedBy, approvedAt: new Date().toISOString(), lines };
    o.status = "approved";
    // The catalog may have been replaced since this order was parsed; flag SKUs the current item master doesn't have.
    o.approveWarnings = lines.filter(l => l.skuId && !catalog.byId.has(l.skuId)).map(l => ({ line_id: l.lineId, code: "sku_not_in_current_catalog", sku_id: l.skuId!,
      message: `${l.skuId} is not in the current catalog (${catalog.version}); a DMS/Tally import may reject it.` }));
    for (const l of lines) if (l.source === "reviewed" || o.resolved.lines[l.lineNo - 1].route === "review")
      queue.resolve(l.lineId, { skuId: l.skuId, qty: l.qty, unit: l.unit, by: approvedBy, at: o.approved.approvedAt });
    appendFileSync(`${dataDir}/approved-orders.jsonl`, JSON.stringify(o.approved) + "\n");
    return { status: 200, json: orderJson(o) };
  }

  function uploadCatalog(csv: string) {
    if (!csv.trim()) throw new HttpError(400, "empty_catalog", "Send the catalog CSV as the request body (Content-Type: text/csv) or as JSON {\"csv\": \"...\"}.");
    const r = catalogFromCsv(csv);
    if (r.errors.length) throw new HttpError(422, "invalid_catalog", "Catalog rejected; the current catalog is unchanged.", { errors: r.errors.slice(0, 50), warnings: r.warnings, columns: r.columns });
    writeFileSync(uploaded, csv);
    setCatalog(r.skus, "uploaded");
    return { status: 200, json: { ...catalogInfo(), warnings: r.warnings, columns: r.columns,
      note: "Confidence threshold was calibrated on the synthetic catalog; re-run calibration on labelled orders for this catalog before trusting auto-accept." } };
  }
  const catalogInfo = () => ({ source: catalog.source, version: catalog.version, sku_count: catalog.skus.length, loaded_at: catalog.loadedAt,
    data_label: catalog.source === "synthetic" ? "SYNTHETIC" : "UPLOADED" });

  function searchCatalog(q: string, limit: number) {
    if (!q.trim()) return catalog.skus.slice(0, limit).map(skuJson);
    const line = { lineId: "search", orderId: "search", raw: q, itemText: q.toLowerCase(), qty: null, unit: "unspecified" as const, sizeHint: null, priceHint: null, extractor: "rules" as const };
    return catalog.retriever.shortlist(line, limit).map(c => skuJson(c.sku));
  }

  // ---- router ----
  async function route(req: IncomingMessage): Promise<{ status: number; json?: unknown; csv?: string; filename?: string }> {
    const url = new URL(req.url ?? "/", "http://localhost"); const p = url.pathname.replace(/\/+$/, "") || "/"; const m = req.method ?? "GET";
    const orderMatch = p.match(/^\/orders\/([A-Za-z0-9_-]{1,64})(\/approve|\/export\.csv|\/export\/sheets)?$/);
    if (m === "GET" && p === "/health" && !fullAccess(req))
      return { status: 200, json: { ok: true, status: "ok", version: VERSION, auth_required: true, limits: LIMITS, adapter: cfg.decider.name } };
    if (m === "GET" && p === "/health") { const sheetsWhy = sheets.status ? sheets.status() : "not configured"; return { status: 200, json: { ok: true, status: "ok", version: VERSION, adapter: cfg.decider.name, threshold: policy.threshold, top_k: cfg.topK ?? 8,
      default_unit: cfg.defaultUnit === undefined ? "case" : cfg.defaultUnit, allow_unspecified_unit: policy.allowUnspecifiedUnit,
      llm_fallback: !!cfg.wrapExtractor, calibration: cfg.calibrationInfo ?? null, catalog: catalogInfo(),
      sheets_export_configured: sheetsWhy === null, sheets_status: sheetsWhy ?? "ready", limits: LIMITS, min_lexical_overlap: minOverlap, auth_required: !!tokenHash } }; }
    if (m === "POST" && p === "/orders/import/whatsapp") {
      const raw = await readBody(req); const ct = req.headers["content-type"] ?? "";
      if (/json/.test(ct)) {
        let j: any; try { j = JSON.parse(raw); } catch { throw new HttpError(400, "bad_json", "Body is not valid JSON."); }
        if (!j || typeof j !== "object" || Array.isArray(j)) throw new HttpError(400, "bad_json", "JSON body must be an object like {\"text\": \"...\"}.");
        return importWhatsApp(typeof j.text === "string" ? j.text : "", j);
      }
      return importWhatsApp(raw, Object.fromEntries(url.searchParams));
    }
    if (m === "POST" && p === "/orders/parse") return parse(await readJson(req));
    if (m === "GET" && p === "/orders") {
      // ?detail=1 returns full order objects (same shape as GET /orders/:id), so a stats page needs one request instead of N.
      const detail = ["1", "true"].includes(url.searchParams.get("detail") ?? "");
      return { status: 200, json: { orders: [...orders.values()].reverse().map(o => {
        const j = orderJson(o); return detail ? j : { order_id: j.order_id, status: j.status, created_at: j.created_at, retailer_id: j.retailer_id, channel: j.channel,
          text_preview: j.text.slice(0, 160), source_kind: j.source.kind, summary: j.summary };
      }) } };
    }
    if (orderMatch) {
      const o = orders.get(orderMatch[1]); if (!o) throw new HttpError(404, "order_not_found", `No order ${orderMatch[1]}.`);
      const sub = orderMatch[2] ?? "";
      if (m === "GET" && sub === "") return { status: 200, json: orderJson(o) };
      if (m === "POST" && sub === "/approve") return approve(o, await readJson(req));
      if (m === "GET" && sub === "/export.csv") {
        if (!o.approved) throw new HttpError(409, "not_approved", "Approve the order before exporting.");
        return { status: 200, csv: orderToCsv(o.approved), filename: `${o.orderId}.csv` };
      }
      if (m === "POST" && sub === "/export/sheets") {
        if (!o.approved) throw new HttpError(409, "not_approved", "Approve the order before exporting.");
        try { return { status: 200, json: await sheets.export(o.approved) }; }
        catch (e) {
          if (e instanceof NotConfiguredError) throw new HttpError(501, "sheets_not_configured", e.message);
          if (e instanceof SheetsApiError) throw new HttpError(502, "sheets_export_failed", e.message);
          throw e;
        }
      }
    }
    if (m === "POST" && p === "/catalog") {
      const raw = await readBody(req); const ct = req.headers["content-type"] ?? "";
      let csv = raw;
      if (/json/.test(ct)) { try { csv = String(JSON.parse(raw).csv ?? ""); } catch { throw new HttpError(400, "bad_json", "Body is not valid JSON."); } }
      return uploadCatalog(csv);
    }
    if (m === "GET" && p === "/catalog") {
      const n = Number(url.searchParams.get("limit") ?? 20); const limit = Number.isFinite(n) ? Math.min(50, Math.max(1, Math.trunc(n))) : 20;
      return { status: 200, json: { ...catalogInfo(), items: searchCatalog(url.searchParams.get("q") ?? "", limit) } };
    }
    throw new HttpError(404, "not_found", `No route for ${m} ${p}.`);
  }

  /** Origin allow-list, loopback Host check (no token) and bearer token. Runs before the body is read or anything is created. */
  const authed = new WeakSet<IncomingMessage>();
  const isHealth = (req: IncomingMessage) => (new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/") === "/health";
  /** Full details when no token is configured (loopback-only) or the request carried the right token. */
  const fullAccess = (req: IncomingMessage) => !tokenHash || authed.has(req);
  function guard(req: IncomingMessage, res: ServerResponse): HttpError | null {
    const origin = req.headers.origin;
    const originOk = origin === undefined || origins.has("*") || origins.has(origin);
    if (origin !== undefined && originOk) {
      res.setHeader("Access-Control-Allow-Origin", origins.has("*") && !tokenHash ? "*" : origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (!originOk) {
      // Readable refusal: echo the origin (no credentials, no methods/headers) so the page can show why. Nothing is processed.
      res.setHeader("Access-Control-Allow-Origin", origin!);
      res.setHeader("Vary", "Origin");
      return new HttpError(403, "origin_not_allowed", `Origin ${origin} is not allowed. Add it to ALLOWED_ORIGINS on the server.`);
    }
    if (req.method === "OPTIONS") return null;
    if (!tokenHash) {
      // No token: only answer requests addressed to a loopback name, so a DNS-rebinding page can't reach the API.
      const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
      if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) return new HttpError(403, "host_not_allowed", "Without API_TOKEN the API only answers requests to localhost / 127.0.0.1.");
      return null;
    }
    const auth = req.headers.authorization ?? ""; const given = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? (typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "");
    // GET /health without any token is allowed and gets the public subset (so a UI can learn auth_required); a wrong token is still 401.
    if (!given && req.method === "GET" && isHealth(req)) return null;
    if (!given || !timingSafeEqual(createHash("sha256").update(given.trim()).digest(), tokenHash))
      return new HttpError(401, "unauthorized", "Send the API token as 'Authorization: Bearer <token>' or 'X-API-Key: <token>'.");
    authed.add(req);
    return null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const denied = guard(req, res);
    if (!denied && req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    try {
      if (denied) throw denied;
      const r = await route(req);
      if (r.csv !== undefined) {
        res.writeHead(r.status, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${r.filename}"` }).end(r.csv);
      } else res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(r.json));
    } catch (e) {
      const he = e instanceof HttpError ? e : new HttpError(500, "internal_error", "Unexpected server error.");
      if (!(e instanceof HttpError)) console.error(e instanceof Error ? e.message : e);
      // If the request body wasn't fully read (rejected early, or too large), close the connection after replying instead of
      // leaving unread bytes on a keep-alive socket (that made the next request hang ~6 s, QA M4).
      if (he.close || !req.complete) res.setHeader("Connection", "close");
      res.writeHead(he.status, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ error: { code: he.code, message: he.message, ...(he.details ? { details: he.details } : {}) } }));
    }
  }
  return { handle, listen: (port: number, host = "127.0.0.1"): Promise<Server> => new Promise(ok => { const s = createServer(handle); s.listen(port, host, () => ok(s)); }) };
}

const round = (n: number, d = 4) => Number(n.toFixed(d));
async function readBody(req: IncomingMessage): Promise<string> {
  const tooBig = () => new HttpError(413, "body_too_large", `Request body is over ${MAX_BODY / 1024 / 1024} MB. For chat imports, send the .txt as text/plain (JSON-escaping makes it larger).`, { max_bytes: MAX_BODY }, true);
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) throw tooBig();
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) throw tooBig(); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString("utf8");
}
async function readJson(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req); if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, "bad_json", "Body is not valid JSON."); }
}
export type { SkuJson };
