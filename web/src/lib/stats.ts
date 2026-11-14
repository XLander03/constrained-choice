import type { OrderDeskApi } from "../api/client.ts";
import type { Order, ReviewReason } from "../api/types.ts";
import { INR_PER_USD } from "./domain.ts";

/** Full orders in one request (GET /orders?detail=1, newest first). */
export async function loadOrders(api: OrderDeskApi, filter?: (s: Order["status"]) => boolean): Promise<Order[]> {
  const all = await api.listOrdersDetailed();
  return filter ? all.filter(o => filter(o.status)) : all;
}

export interface DeskStats {
  ordersParsed: number; ordersApproved: number;
  linesTotal: number; linesAuto: number; autoAcceptedPct: number;
  linesReviewed: number; linesChanged: number; skipped: number;
  costPerOrderUsd: number; costPer1000OrdersInr: number;
  reasonCounts: Partial<Record<ReviewReason, number>>;
  threshold: number | null;
}

/** Stats computed in the UI from orders (no stats endpoint in API.md). */
export function computeStats(orders: Order[]): DeskStats {
  const lines = orders.flatMap(o => o.lines);
  const auto = lines.filter(l => l.route === "auto").length;
  const approved = orders.filter(o => o.approved);
  const reviewed = approved.flatMap(o => o.approved!.lines.filter((a, i) => a.source === "reviewed" || o.lines[i]?.route === "review"));
  const reasonCounts: DeskStats["reasonCounts"] = {};
  for (const l of lines) for (const r of l.reasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
  const cost = orders.reduce((a, o) => a + o.usage.costUsd, 0);
  const per = orders.length ? cost / orders.length : 0;
  return {
    ordersParsed: orders.length, ordersApproved: approved.length, linesTotal: lines.length, linesAuto: auto,
    autoAcceptedPct: lines.length ? auto / lines.length : 0, linesReviewed: reviewed.length, linesChanged: reviewed.filter(l => l.changed).length,
    skipped: approved.flatMap(o => o.approved!.lines).filter(l => l.status === "skipped").length,
    costPerOrderUsd: per, costPer1000OrdersInr: per * 1000 * INR_PER_USD, reasonCounts, threshold: orders[0]?.threshold ?? null,
  };
}
