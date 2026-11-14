import type { DecisionAdapter } from "./decide/adapter.ts";
import { NO_EXTRACTION_USAGE, type LineExtractor } from "./extract/extractor.ts";
import type { CandidateRetriever } from "./retrieve/retriever.ts";
import type { Calibrator } from "./route/calibrate.ts";
import { routeLine, type RoutingPolicy } from "./route/router.ts";
import type { ExtractedLine, IncomingOrder, OrderUnit, ResolvedOrder } from "./types.ts";

/** Most lines one order may have (the Decisions API takes ≤ 400 questions per request). Checked after extraction, before any decision call. */
export const MAX_LINES_PER_ORDER = 400;
export class TooManyLinesError extends Error {
  lines: number; max: number;
  constructor(lines: number, max: number) { super(`Order has ${lines} product lines; the limit is ${max} per order. Split it into smaller orders.`); this.lines = lines; this.max = max; }
}

export interface PipelineDeps {
  extractor: LineExtractor; retriever: CandidateRetriever; decider: DecisionAdapter;
  calibrator: Calibrator; policy: RoutingPolicy; topK: number;
  /** Distributor policy for a bare number ("maggi 5"). null/undefined = leave "unspecified" (→ review). */
  defaultUnit?: OrderUnit | null;
}

/** Bare number + configured default unit → that unit, flagged so the UI can show "assumed case". */
export function applyDefaultUnit(l: ExtractedLine, unit: OrderUnit | null | undefined): ExtractedLine {
  return unit && l.unit === "unspecified" && l.qty !== null ? { ...l, unit, unitDefaulted: true } : l;
}

/** extract → shortlist → decide (one request per order) → calibrate + route. */
export async function processOrder(order: IncomingOrder, d: PipelineDeps): Promise<ResolvedOrder> {
  const ex = d.extractor.extractDetailed ? await d.extractor.extractDetailed(order) : { lines: await d.extractor.extract(order), usage: NO_EXTRACTION_USAGE };
  const lines = ex.lines.map(l => applyDefaultUnit(l, d.defaultUnit));
  if (lines.length > MAX_LINES_PER_ORDER) throw new TooManyLinesError(lines.length, MAX_LINES_PER_ORDER);
  const withCands = lines.map(line => ({ line, candidates: d.retriever.shortlist(line, d.topK) }));
  if (!withCands.length) return { order, lines: [], usage: { inputTokens: 0, cachedTokens: 0, requests: 0, costUsd: 0 }, extractionUsage: ex.usage };
  const { decisions, usage } = await d.decider.decideOrder({ order, lines: withCands });
  return { order, usage, extractionUsage: ex.usage, lines: withCands.map((w, i) => routeLine(w.line, w.candidates, decisions[i], d.calibrator, d.policy)) };
}
