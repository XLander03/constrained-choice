import { NONE, type Candidate, type ExtractedLine, type LineDecision, type ResolvedLine } from "../types.ts";
import type { Calibrator } from "./calibrate.ts";

export interface RoutingPolicy { threshold: number; allowUnspecifiedUnit: boolean }

export function routeLine(line: ExtractedLine, candidates: Candidate[], decision: LineDecision, cal: Calibrator, policy: RoutingPolicy): ResolvedLine {
  const calibrated = cal.apply(decision.confidence);
  const reasons: string[] = [];
  if (decision.refused) reasons.push("refused");
  if (decision.choice === NONE) reasons.push("none_of_these");
  if (line.qty === null) reasons.push("qty_missing");
  if (line.unit === "unspecified" && !policy.allowUnspecifiedUnit) reasons.push("unit_unspecified");
  if (calibrated < policy.threshold) reasons.push("low_confidence");
  return { line, candidates, decision, calibratedConfidence: calibrated, route: reasons.length ? "review" : "auto", reason: reasons.join(",") || "ok" };
}
