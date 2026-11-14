import { NONE, type Candidate, type ExtractedLine, type LineDecision, type ResolvedLine } from "../types.ts";
import { checkAmbiguity } from "./ambiguity.ts";
import type { Calibrator } from "./calibrate.ts";
import type { OverlapScorer } from "./overlap.ts";

export interface RoutingPolicy {
  threshold: number;
  allowUnspecifiedUnit: boolean;
  /** "review" (default): a pick whose pack size / variant the line doesn't pin down goes to review instead of guessing. */
  ambiguity?: "review" | "ignore";
  /** Provider-independent guard (M5): a pick whose SKU explains less than `floor` of the line's words (IDF-weighted) goes to review
   *  as "low_overlap", whatever the model's confidence. Stops "red bull" → Red Label Tea from auto-accepting. */
  overlap?: { scorer: OverlapScorer; floor: number };
}

/** Hard rules first (refusal, NONE, qty/unit, ambiguity), then the calibrated threshold. Any reason → review. */
export function routeLine(line: ExtractedLine, candidates: Candidate[], decision: LineDecision, cal: Calibrator, policy: RoutingPolicy): ResolvedLine {
  const calibrated = cal.apply(decision.confidence);
  const reasons: string[] = [];
  let ambiguousWith: string[] | undefined;
  if (decision.refused) reasons.push("refused");
  if (decision.choice === NONE) reasons.push("none_of_these");
  if (line.qty === null) reasons.push("qty_missing");
  if (line.unit === "unspecified" && !policy.allowUnspecifiedUnit) reasons.push("unit_unspecified");
  const chosen = candidates.find(c => c.sku.skuId === decision.choice)?.sku;
  if (chosen && (policy.ambiguity ?? "review") === "review") {
    const a = checkAmbiguity(line, chosen, candidates);
    if (a.ambiguous) { reasons.push(`${a.kind}_ambiguous`); ambiguousWith = a.consistent; }
  }
  const lexicalOverlap = chosen && policy.overlap ? policy.overlap.scorer.score(line.itemText, chosen) : null;
  if (lexicalOverlap !== null && policy.overlap && lexicalOverlap < policy.overlap.floor) reasons.push("low_overlap");
  if (calibrated < policy.threshold) reasons.push("low_confidence");
  return { line, candidates, decision, calibratedConfidence: calibrated, route: reasons.length ? "review" : "auto", reason: reasons.join(",") || "ok", ambiguousWith, lexicalOverlap };
}
