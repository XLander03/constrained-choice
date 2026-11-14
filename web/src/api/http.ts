import type { OrderDeskApi } from "./client.ts";
import { getToken, notifyUnauthorized } from "./token.ts";
import { mapCatalogInfo, mapCatalogUpload, mapHealth, mapImport, mapListItem, mapOrder, mapSku } from "./map.ts";
import { ApiError, type ApproveInput, type ImportOptions, type ParseRequest } from "./types.ts";
import type { WireApproveRequest, WireCatalogSearch, WireCatalogUpload, WireError, WireHealth, WireImportResult, WireOrderDetailList, WireOrder, WireOrderList, WireParseRequest, WireSheetsResult } from "./wire.ts";

const DEFAULT_ALLOWED = ["http://localhost:5173", "http://localhost:5174"];

/** Real backend client. No credentials are baked in: the optional API token is typed in at runtime (token.ts) and sent as
 *  `Authorization: Bearer`. The server also checks the page's Origin (API.md "Access control"). */
export class HttpClient implements OrderDeskApi {
  readonly mode = "http" as const;
  private base: string;
  constructor(base: string) { this.base = base.replace(/\/+$/, ""); }

  private async req(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    const headers = new Headers(init?.headers); const t = getToken();
    if (t) headers.set("Authorization", `Bearer ${t}`);
    try { res = await fetch(this.base + path, { ...init, headers }); }
    catch {
      // Since API v0.5.1 a disallowed Origin gets a readable 403 origin_not_allowed for simple requests, but a refused CORS
      // preflight (JSON POSTs) still makes fetch() fail. Off the default allow-list that is the likely cause, so report it as a 403.
      const here = window.location.origin;
      if (!DEFAULT_ALLOWED.includes(here))
        throw new ApiError(`Couldn't reach the API from ${here}. The server only allows the origins in ALLOWED_ORIGINS (default http://localhost:5173 and :5174), so this address is probably blocked.`, 403, "origin_not_allowed");
      throw new ApiError(`Can't reach the order desk API at ${this.base}. Is \`npm run serve\` running? (If it was started with a custom ALLOWED_ORIGINS, ${here} must be in it.)`, 0, "network_error");
    }
    if (!res.ok) {
      let err = new ApiError(`${res.status} ${res.statusText}`, res.status, "http_error");
      try { const j = await res.json() as WireError; if (j?.error) err = new ApiError(j.error.message, res.status, j.error.code, j.error.details); } catch { /* not JSON */ }
      if (res.status === 401) notifyUnauthorized();
      throw err;
    }
    return res;
  }
  private async get<T>(path: string): Promise<T> { return (await this.req(path, { headers: { Accept: "application/json" } })).json() as Promise<T>; }
  private async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.req(path, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<T>;
  }

  async health() {
    // Since API v0.5.1, GET /health answers without a token but returns only a public subset (no catalog etc.) when the server
    // has API_TOKEN set. Treat that like the 401 it replaced so the token prompt opens.
    const h = await this.get<WireHealth & { catalog?: unknown }>("/health");
    if (h.auth_required && !h.catalog) throw new ApiError("This server needs an API token.", 401, "unauthorized");
    return mapHealth(h);
  }
  async listIncoming() { return []; }
  async listOrders() { return (await this.get<WireOrderList>("/orders")).orders.map(mapListItem); }
  async listOrdersDetailed() { return (await this.get<WireOrderDetailList>("/orders?detail=1")).orders.map(mapOrder); }
  async getOrder(id: string) { return mapOrder(await this.get<WireOrder>(`/orders/${encodeURIComponent(id)}`)); }
  async parseOrder(r: ParseRequest) {
    const body: WireParseRequest = { text: r.text, channel: r.channel, ...(r.retailer ? { retailer_id: r.retailer } : {}), ...(r.orderId ? { order_id: r.orderId } : {}) };
    return mapOrder(await this.post<WireOrder>("/orders/parse", body));
  }
  async approveOrder(id: string, r: ApproveInput) {
    const body: WireApproveRequest = { ...(r.approvedBy ? { approved_by: r.approvedBy } : {}), lines: r.lines.map(l => ({ line_id: l.lineId, sku_id: l.skuId, ...(l.qty !== undefined ? { qty: l.qty } : {}), ...(l.unit ? { unit: l.unit } : {}) })) };
    return mapOrder(await this.post<WireOrder>(`/orders/${encodeURIComponent(id)}/approve`, body));
  }
  async exportCsv(id: string) {
    const res = await this.req(`/orders/${encodeURIComponent(id)}/export.csv`, { headers: { Accept: "text/csv" } });
    const name = /filename="?([^";]+)"?/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `${id}.csv`;
    return { blob: await res.blob(), filename: name };
  }
  async importWhatsApp(text: string, o: Partial<ImportOptions>) {
    // Raw text/plain body with options in the query (API.md): JSON-escaping can push a 4.9 MB export over the 5 MB limit.
    const q = new URLSearchParams();
    if (o.group) q.set("group", o.group);
    if (o.burstMinutes) q.set("burst_minutes", String(o.burstMinutes));
    const ex = o.excludeSenders?.map(s => s.trim()).filter(Boolean) ?? []; if (ex.length) q.set("exclude_senders", ex.join(","));
    if (o.dateOrder && o.dateOrder !== "auto") q.set("date_order", o.dateOrder);
    const res = await this.req(`/orders/import/whatsapp${q.size ? `?${q}` : ""}`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "text/plain; charset=utf-8" }, body: text });
    return mapImport(await res.json() as WireImportResult);
  }
  async exportSheets(id: string) {
    const r = await this.post<WireSheetsResult>(`/orders/${encodeURIComponent(id)}/export/sheets`, {});
    return { location: r.location, rows: r.rows ?? null };
  }
  async searchCatalog(q: string, limit = 20) { return (await this.get<WireCatalogSearch>(`/catalog?q=${encodeURIComponent(q)}&limit=${limit}`)).items.map(mapSku); }
  async catalogInfo() { return mapCatalogInfo(await this.get<WireCatalogSearch>("/catalog?limit=1")); }
  async uploadCatalog(csv: string) {
    const res = await this.req("/catalog", { method: "POST", headers: { Accept: "application/json", "Content-Type": "text/csv" }, body: csv });
    return mapCatalogUpload(await res.json() as WireCatalogUpload);
  }
}
