// Typed mock of the API.md contract. Runs MockServer (the backend pipeline compiled into the browser) over the
// SYNTHETIC data in ../data, keeps state in localStorage, and adds a small artificial latency so loading states are real.
import catalogCsv from "../../../../data/catalog.csv?raw";
import ordersJsonl from "../../../../data/orders.jsonl?raw";
import type { OrderDeskApi } from "../client.ts";
import { mapCatalogInfo, mapCatalogUpload, mapHealth, mapImport, mapListItem, mapOrder, mapSku } from "../map.ts";
import { ApiError, type ApproveInput, type ImportOptions, type IncomingMessage, type ParseRequest } from "../types.ts";
import type { WireApproveRequest } from "../wire.ts";
import { MockServer, SHEETS_STATUS, WireError, type StoredOrder } from "./server.ts";

interface SeedOrder { order_id: string; channel: "whatsapp" | "email"; retailer: string; text: string; tags: string[] }
interface MockState {
  version: 4;
  incoming: IncomingMessage[];
  orders: StoredOrder[];               // oldest first, like the server's Map
  uploadedCatalog: { csv: string; loadedAt: string } | null;
}

const STORAGE_KEY = "od.mock.v4";
const SEED_INCOMING = 16, SEED_APPROVED = 4;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const latency = (min = 160, max = 480) => sleep(min + Math.random() * (max - min));

/** Re-throw server-side errors exactly as HttpClient would surface them. */
async function call<T>(f: () => T | Promise<T>): Promise<T> {
  try { return await f(); }
  catch (e) { if (e instanceof WireError) throw new ApiError(e.message, e.status, e.code, e.details); throw e; }
}

class MockClient implements OrderDeskApi {
  readonly mode = "mock" as const;
  private state!: MockState;
  private server!: MockServer;

  async init() {
    const saved = this.load();
    if (saved) {
      this.state = saved;
      try { this.server = saved.uploadedCatalog ? new MockServer(saved.uploadedCatalog.csv, "uploaded", saved.uploadedCatalog.loadedAt) : new MockServer(catalogCsv, "synthetic"); }
      catch { this.server = new MockServer(catalogCsv, "synthetic"); this.state.uploadedCatalog = null; }
    } else await this.seed();
  }
  private load(): MockState | null {
    try { const raw = localStorage.getItem(STORAGE_KEY); const s = raw ? JSON.parse(raw) as MockState : null; return s?.version === 4 ? s : null; }
    catch { return null; }
  }
  private save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* quota: keep in memory */ } }
  private find(id: string) {
    const o = this.state.orders.find(x => x.wire.order_id === id);
    if (!o) throw new ApiError(`No order ${id}.`, 404, "order_not_found");
    return o;
  }

  private async seed() {
    this.server = new MockServer(catalogCsv, "synthetic");
    const all = ordersJsonl.split("\n").filter(Boolean).map(l => JSON.parse(l) as SeedOrder);
    const hand = all.filter(o => o.tags.includes("handwritten")).slice(0, 4);
    const picked = [...all.slice(0, SEED_INCOMING + SEED_APPROVED - hand.length), ...hand];
    const now = Date.now();
    const msgs: IncomingMessage[] = picked.map((o, i) => ({
      messageId: o.order_id, channel: o.channel, retailer: o.retailer, text: o.text,
      receivedAt: new Date(now - (picked.length - i) * 11 * 60_000 - (i % 3) * 97_000).toISOString(),
    }));
    this.state = { version: 4, incoming: msgs.slice(SEED_APPROVED), orders: [], uploadedCatalog: null };
    // Simulated history: the oldest few messages were parsed and approved earlier today (approved_by "seed").
    for (const m of msgs.slice(0, SEED_APPROVED)) {
      const t = new Date(m.receivedAt).getTime();
      const o = await this.server.parse({ text: m.text, channel: m.channel, retailer_id: m.retailer, order_id: m.messageId }, new Set(), new Date(t + 60_000).toISOString());
      const lines: WireApproveRequest["lines"] = o.wire.lines.filter(l => l.needs_review).map(l => ({
        line_id: l.line_id, sku_id: l.sku && l.qty !== null ? l.sku.sku_id : null,
        ...(l.unit === "unspecified" && l.sku ? { unit: "case" as const } : {}),
      }));
      this.server.approve(o, { approved_by: "seed", lines }, new Date(t + 5 * 60_000).toISOString());
      this.state.orders.push(o);
    }
    this.save();
  }

  // ---- contract ----
  async health() { await latency(40, 120); return mapHealth(this.server.health()); }
  async listIncoming() { await latency(); return [...this.state.incoming].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)); }
  async listOrders() {
    await latency();
    return [...this.state.orders].reverse().map(o => mapListItem({ order_id: o.wire.order_id, status: o.wire.status, created_at: o.wire.created_at, retailer_id: o.wire.retailer_id,
      channel: o.wire.channel, text_preview: o.wire.text.slice(0, 160), source_kind: o.wire.source?.kind ?? "paste", summary: o.wire.summary }));
  }
  async listOrdersDetailed() { await latency(); return [...this.state.orders].reverse().map(o => mapOrder(this.server.view(o))); }
  async getOrder(id: string) { await latency(100, 260); return call(() => mapOrder(this.server.view(this.find(id)))); }

  async parseOrder(r: ParseRequest) {
    await latency(400, 850);   // the paid adapter takes ~0.2–0.5 s per order (API.md)
    return call(async () => {
      const o = await this.server.parse({ text: r.text, channel: r.channel, ...(r.retailer ? { retailer_id: r.retailer } : {}), ...(r.orderId ? { order_id: r.orderId } : {}) },
        new Set(this.state.orders.map(x => x.wire.order_id)));
      this.state.orders.push(o);
      if (r.orderId) this.state.incoming = this.state.incoming.filter(m => m.messageId !== r.orderId);
      this.save();
      return mapOrder(this.server.view(o));
    });
  }

  async importWhatsApp(text: string, o: Partial<ImportOptions>) {
    await latency(500, 900);
    return call(async () => {
      // Same limit the server applies to the raw text/plain body (5 MB of UTF-8 bytes).
      if (new TextEncoder().encode(text).length > 5 * 1024 * 1024) throw new WireError(413, "body_too_large", "Request body is over 5 MB.");
      const { result, stored } = await this.server.importWhatsApp(text,
        { group: o.group, burst_minutes: o.burstMinutes, exclude_senders: o.excludeSenders, date_order: o.dateOrder },
        new Set(this.state.orders.map(x => x.wire.order_id)));
      this.state.orders.push(...stored); this.save();
      return mapImport(structuredClone(result));
    });
  }

  async approveOrder(id: string, r: ApproveInput) {
    await latency(250, 550);
    return call(() => {
      const o = this.find(id);
      const wire = this.server.approve(o, { ...(r.approvedBy ? { approved_by: r.approvedBy } : {}), lines: r.lines.map(l => ({ line_id: l.lineId, sku_id: l.skuId, ...(l.qty !== undefined ? { qty: l.qty } : {}), ...(l.unit ? { unit: l.unit } : {}) })) });
      this.save();
      return mapOrder(wire);
    });
  }

  async exportCsv(id: string) {
    await latency(100, 240);
    return call(() => ({ blob: new Blob([this.server.exportCsv(this.find(id))], { type: "text/csv;charset=utf-8" }), filename: `${id}.csv` }));
  }
  async exportSheets(id: string): Promise<{ location: string; rows: number | null }> {
    await latency(100, 200);
    return call(() => {
      if (!this.find(id).wire.approved) throw new WireError(409, "not_approved", "Approve the order before exporting.");
      throw new WireError(501, "sheets_not_configured", `Google Sheets export isn't configured: ${SHEETS_STATUS}.`);
    });
  }
  async searchCatalog(q: string, limit = 20) { await latency(50, 130); return this.server.search(q, limit).map(mapSku); }
  async catalogInfo() { await latency(60, 140); return mapCatalogInfo(this.server.info); }
  async uploadCatalog(csv: string) {
    await latency(350, 700);
    return call(() => {
      const r = this.server.upload(csv);
      this.state.uploadedCatalog = { csv, loadedAt: r.loaded_at }; this.save();
      return mapCatalogUpload(r);
    });
  }
  async reset() { localStorage.removeItem(STORAGE_KEY); await this.seed(); }
}

export async function createMockClient(): Promise<OrderDeskApi> { const c = new MockClient(); await c.init(); return c; }
