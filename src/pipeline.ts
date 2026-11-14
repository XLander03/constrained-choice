import type { DecisionAdapter } from "./decide/adapter.ts";
import type { LineExtractor } from "./extract/extractor.ts";
import type { CandidateRetriever } from "./retrieve/retriever.ts";
import type { Calibrator } from "./route/calibrate.ts";
import { routeLine, type RoutingPolicy } from "./route/router.ts";
import type { IncomingOrder, ResolvedOrder } from "./types.ts";

export interface PipelineDeps {
  extractor: LineExtractor; retriever: CandidateRetriever; decider: DecisionAdapter;
  calibrator: Calibrator; policy: RoutingPolicy; topK: number;
}

/** extract → shortlist → decide (one request per order) → calibrate + route. */
export async function processOrder(order: IncomingOrder, d: PipelineDeps): Promise<ResolvedOrder> {
  const lines = await d.extractor.extract(order);
  const withCands = lines.map(line => ({ line, candidates: d.retriever.shortlist(line, d.topK) }));
  if (!withCands.length) return { order, lines: [], usage: { inputTokens: 0, cachedTokens: 0, requests: 0, costUsd: 0 } };
  const { decisions, usage } = await d.decider.decideOrder({ order, lines: withCands });
  return { order, usage, lines: withCands.map((w, i) => routeLine(w.line, w.candidates, decisions[i], d.calibrator, d.policy)) };
}
