// Replays decisions saved by a previous eval run (reports/eval-<adapter>.decisions.jsonl), so routing and
// calibration changes can be re-evaluated without paying for the API again. Cost is reported from the saved usage.
import { readFileSync } from "node:fs";
import type { DecisionUsage, LineDecision } from "../types.ts";
import type { DecisionAdapter, OrderDecisionRequest, OrderDecisionResult } from "./adapter.ts";

export interface SavedOrderDecision { orderId: string; adapter: string; decisions: LineDecision[]; usage: DecisionUsage }

export class ReplayAdapter implements DecisionAdapter {
  readonly name: string;
  private byOrder = new Map<string, SavedOrderDecision>();
  constructor(path: string) {
    const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as SavedOrderDecision);
    for (const r of rows) this.byOrder.set(r.orderId, r);
    this.name = `replay:${rows[0]?.adapter ?? "unknown"}`;
  }
  has(orderId: string) { return this.byOrder.has(orderId); }
  async decideOrder(req: OrderDecisionRequest): Promise<OrderDecisionResult> {
    const saved = this.byOrder.get(req.order.orderId);
    if (!saved) throw new Error(`no saved decisions for ${req.order.orderId}`);
    const byLine = new Map(saved.decisions.map(d => [d.lineId, d]));
    const decisions = req.lines.map(({ line }) => {
      const d = byLine.get(line.lineId);
      if (!d) throw new Error(`replay mismatch: ${line.lineId} not in saved run (extractor changed?)`);
      return d;
    });
    return { decisions, usage: saved.usage };
  }
}
