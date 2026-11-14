import type { Candidate, DecisionUsage, ExtractedLine, IncomingOrder, LineDecision } from "../types.ts";

/**
 * Stage 3 contract. One call per order: every unresolved line becomes one choice question over its shortlist + NONE.
 * Providers: OpenAI Decisions (now), Jev / others (later), Mock (offline eval). Nothing outside src/decide knows wire formats.
 */
export interface DecisionAdapter {
  readonly name: string;
  decideOrder(req: OrderDecisionRequest): Promise<OrderDecisionResult>;
}
export interface OrderDecisionRequest {
  order: IncomingOrder;
  lines: { line: ExtractedLine; candidates: Candidate[] }[];
}
export interface OrderDecisionResult {
  decisions: LineDecision[];   // same order as req.lines
  usage: DecisionUsage;
  raw?: unknown;               // provider response, kept for audit/debug
}

/** Prices are config, not code: verify against the provider's pricing page before trusting cost numbers. */
export interface PriceTable { inputPerMTokUsd: number; cachedInputPerMTokUsd: number; cacheWritePerMTokUsd: number }
// developers.openai.com/api/docs/guides/decisions (checked 2026-11-14): uncached input $0.10/1M; output not charged.
// Cache-read/write rates are "the standard gpt-6-luna prompt caching rates" — not verified here, so default to the uncached rate (conservative).
export const OPENAI_DECISIONS_PRICES: PriceTable = { inputPerMTokUsd: 0.10, cachedInputPerMTokUsd: 0.10, cacheWritePerMTokUsd: 0.10 };

export function costUsd(p: PriceTable, inputTokens: number, cachedTokens: number, cacheWriteTokens: number): number {
  const uncached = Math.max(0, inputTokens - cachedTokens - cacheWriteTokens);
  return (uncached * p.inputPerMTokUsd + cachedTokens * p.cachedInputPerMTokUsd + cacheWriteTokens * p.cacheWritePerMTokUsd) / 1e6;
}
