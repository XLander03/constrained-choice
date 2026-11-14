import type { ApproveInput, CatalogInfo, CatalogUploadResult, Health, ImportOptions, ImportResult, IncomingMessage, Order, OrderListItem, ParseRequest, SkuSummary } from "./types.ts";

/** Everything the UI needs from the backend (API.md). Implemented by MockClient (in-browser) and HttpClient (VITE_API_BASE). */
export interface OrderDeskApi {
  readonly mode: "mock" | "http";
  health(): Promise<Health>;
  /** Unparsed incoming messages. Mock only: the backend has no intake queue yet, so HttpClient returns []. */
  listIncoming(): Promise<IncomingMessage[]>;
  listOrders(): Promise<OrderListItem[]>;                       // GET /orders
  listOrdersDetailed(): Promise<Order[]>;                       // GET /orders?detail=1 (stats: one request)
  getOrder(orderId: string): Promise<Order>;                    // GET /orders/:id
  parseOrder(req: ParseRequest): Promise<Order>;                // POST /orders/parse
  /** POST /orders/import/whatsapp, sent as raw text/plain (UTF-8) with options in the query. All-or-nothing on the server. */
  importWhatsApp(text: string, opts: Partial<ImportOptions>): Promise<ImportResult>;
  approveOrder(orderId: string, req: ApproveInput): Promise<Order>;  // POST /orders/:id/approve
  exportCsv(orderId: string): Promise<{ blob: Blob; filename: string }>;  // GET /orders/:id/export.csv
  exportSheets(orderId: string): Promise<{ location: string; rows: number | null }>;  // POST /orders/:id/export/sheets (501 until configured)
  searchCatalog(query: string, limit?: number): Promise<SkuSummary[]>;   // GET /catalog?q=
  catalogInfo(): Promise<CatalogInfo>;                          // GET /catalog?limit=1
  uploadCatalog(csv: string): Promise<CatalogUploadResult>;     // POST /catalog (text/csv)
  /** Mock only: wipe local state back to the synthetic seed. */
  reset?(): Promise<void>;
}
