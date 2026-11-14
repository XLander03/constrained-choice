import type { OrderDeskApi } from "../api/client.ts";
import type { Channel, OrderListItem } from "../api/types.ts";
import type { DeskStatus } from "../components/bits.tsx";

/** One row of the inbox: an unparsed incoming message (mock feed) or a parsed order from GET /orders. */
export type DeskRow =
  | { kind: "incoming"; id: string; status: "incoming"; at: string; retailer: string; channel: Channel; text: string }
  | { kind: "order"; id: string; status: Exclude<DeskStatus, "incoming">; at: string; retailer: string | null; order: OrderListItem };

export const orderStatus = (o: OrderListItem): Exclude<DeskStatus, "incoming"> =>
  o.status === "approved" ? "approved" : o.summary.lines === 0 ? "empty" : o.summary.needsReview > 0 ? "needs_review" : "ready";

export async function loadDesk(api: OrderDeskApi): Promise<DeskRow[]> {
  const [incoming, orders] = await Promise.all([api.listIncoming(), api.listOrders()]);
  const rows: DeskRow[] = [
    ...incoming.map(m => ({ kind: "incoming" as const, id: m.messageId, status: "incoming" as const, at: m.receivedAt, retailer: m.retailer, channel: m.channel, text: m.text })),
    ...orders.map(o => ({ kind: "order" as const, id: o.orderId, status: orderStatus(o), at: o.createdAt, retailer: o.retailer, order: o })),
  ];
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}
