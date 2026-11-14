import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { OrderUnit, ResolvedLine } from "../types.ts";

export interface ReviewItem {
  id: string; orderId: string; raw: string; createdAt: string; status: "open" | "resolved";
  suggested: { skuId: string; p: number }[];   // top-5 from the model, shown as one-tap options
  qty: number | null; unit: OrderUnit; reason: string;
  resolution?: { skuId: string | null; qty: number; unit: OrderUnit; by: string; at: string; addAlias?: boolean };
}
export interface ReviewQueue {
  enqueue(line: ResolvedLine): ReviewItem;
  list(status?: ReviewItem["status"]): ReviewItem[];
  resolve(id: string, r: NonNullable<ReviewItem["resolution"]>): void;
}

/** Append-only JSONL store: good enough for an MVP with one reviewer; swap for SQLite/Postgres later. */
export class JsonlReviewQueue implements ReviewQueue {
  private path: string;
  constructor(path: string) { this.path = path; }
  private events(): (ReviewItem | { resolveId: string; r: ReviewItem["resolution"] })[] {
    return existsSync(this.path) ? readFileSync(this.path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  }
  enqueue(l: ResolvedLine): ReviewItem {
    const item: ReviewItem = { id: l.line.lineId, orderId: l.line.orderId, raw: l.line.raw, createdAt: new Date().toISOString(), status: "open",
      suggested: [...l.decision.probabilities].sort((a, b) => b.p - a.p).slice(0, 5).map(p => ({ skuId: p.skuId, p: Number(p.p.toFixed(3)) })),
      qty: l.line.qty, unit: l.line.unit, reason: l.reason };
    appendFileSync(this.path, JSON.stringify(item) + "\n"); return item;
  }
  list(status?: ReviewItem["status"]) {
    const items = new Map<string, ReviewItem>();
    for (const e of this.events()) {
      if ("resolveId" in e) { const it = items.get(e.resolveId); if (it) { it.status = "resolved"; it.resolution = e.r; } }
      else items.set(e.id, e);
    }
    return [...items.values()].filter(i => !status || i.status === status);
  }
  resolve(id: string, r: NonNullable<ReviewItem["resolution"]>) { appendFileSync(this.path, JSON.stringify({ resolveId: id, r }) + "\n"); }
}
