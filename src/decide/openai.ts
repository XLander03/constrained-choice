// OpenAI Decisions API adapter.
// Docs: https://developers.openai.com/api/docs/guides/decisions
//       https://developers.openai.com/api/reference/resources/decisions/methods/create
// Verified 2026-11-14: POST /v1/decisions, model "gpt-6-luna" (only supported model), body {model, input, questions[], prompt_cache_key?},
// choice question {type:"choice", name, instructions, choices:[{value, description?}]} with 2–255 choices, 1–400 questions/request,
// answers[] in question order echoing name: choice → {choice, confidence, probabilities:[{value, probability}]}, or {type:"refusal"}.
// Not verified: exact semantics of `confidence` (we calibrate it ourselves), cache read/write prices.
import { skuLabel } from "../catalog/load.ts";
import { NONE, type LineDecision, type Sku } from "../types.ts";
import { OPENAI_DECISIONS_PRICES, costUsd, type DecisionAdapter, type OrderDecisionRequest, type OrderDecisionResult, type PriceTable } from "./adapter.ts";

export const NONE_VALUE = "none_of_these";
/** Provider error bodies can echo part of a key ("Incorrect API key provided: sk-…"): never let that reach logs. */
export const redactSecrets = (t: string) => t.replace(/\b(sk|rk|sess)-[A-Za-z0-9_\-*.]{6,}/g, "[redacted-key]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
export const MAX_CHOICES = 255, MAX_QUESTIONS = 400;

export interface DecisionsChoiceQuestion { type: "choice"; name: string; instructions: string; choices: { value: string; description?: string }[] }
export interface DecisionsRequestBody { model: string; input: string; questions: DecisionsChoiceQuestion[]; prompt_cache_key?: string }
type Answer =
  | { type: "choice"; name: string | null; choice: string | boolean; confidence: number; probabilities: { value: string | boolean; probability: number }[] }
  | { type: "refusal"; name: string | null }
  | { type: "predicate" | "score"; name: string | null; [k: string]: unknown };
export interface DecisionsResponse {
  model: string; answers: Answer[];
  usage: { input_tokens: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }; output_tokens: number; total_tokens: number };
}

// Docs advise meaningful values over opaque ids, so the value is a readable label; the [id] suffix keeps it unique and reversible.
export const choiceValue = (s: Sku) => `${skuLabel(s)} [${s.skuId}]`;
/** "full" = milestone-1; "compact" = MRP + 2 aliases; "minimal" = MRP only (M2 default); "rich" = MRP + up to 3 variant-specific aliases (M3). */
export type DescStyle = "minimal" | "compact" | "rich" | "full";
const choiceDesc = (s: Sku, style: DescStyle, family: Sku[] = []) => {
  const al = s.aliases.filter(a => !/\d/.test(a));
  if (style === "minimal") return `MRP ₹${s.mrpInr}`;
  if (style === "rich") {
    // Milestone 3: the shorthand that singles out this variant ("blue lays" = Magic Masala), not aliases shared by the whole family.
    const shared = new Set(family.filter(f => f.variant !== s.variant).flatMap(f => f.aliases));
    const own = al.filter(a => !shared.has(a)).slice(0, 3);
    // Brand, variant and pack size are already spelled out in the choice value; the description adds MRP + shorthand.
    return `MRP ₹${s.mrpInr}${own.length ? `; aka ${own.join(", ")}` : ""}`;
  }
  return style === "full" ? `MRP ₹${s.mrpInr}; case of ${s.caseQty}. Also called: ${al.slice(0, 4).join(", ")}`
    : `MRP ₹${s.mrpInr}${al.length ? `; aka ${al.slice(0, 2).join(", ")}` : ""}`;
};
export interface BuildOptions { model?: string; maxChoicesPerLine?: number; descStyle?: DescStyle }

/** Pure function: builds the wire body and the value→skuId map. Shared by the real adapter and the mock (for token estimates). */
export function buildDecisionsRequest(req: OrderDecisionRequest, opts: BuildOptions = {}): { body: DecisionsRequestBody; valueMaps: Map<string, string>[] } {
  const model = opts.model ?? "gpt-6-luna", style = opts.descStyle ?? "rich";
  if (req.lines.length > MAX_QUESTIONS) throw new Error(`order has ${req.lines.length} lines; split into ≤${MAX_QUESTIONS} per request`);
  const valueMaps: Map<string, string>[] = [];
  const questions = req.lines.map(({ line, candidates }) => {
    const cands = candidates.slice(0, Math.min(opts.maxChoicesPerLine ?? MAX_CHOICES - 1, MAX_CHOICES - 1));
    const vm = new Map<string, string>(cands.map(c => [choiceValue(c.sku), c.sku.skuId]));
    vm.set(NONE_VALUE, NONE); valueMaps.push(vm);
    const hints = [line.sizeHint && `size ${line.sizeHint.value}${line.sizeHint.unit}`, line.priceHint != null && `price ₹${line.priceHint}`].filter(Boolean).join(", ");
    return {
      type: "choice" as const, name: line.lineId,
      instructions: `Line: "${line.raw}". Which product is ordered? Ignore quantity.${hints ? ` Hints: ${hints}.` : ""} ` +
        `Pick ${NONE_VALUE} if product, variant or pack size is not clearly one option.`,
      choices: [...cands.map(c => ({ value: choiceValue(c.sku), description: choiceDesc(c.sku, style, cands.map(x => x.sku).filter(x => x.brand === c.sku.brand && x.product === c.sku.product)) })),
        { value: NONE_VALUE, description: "Not in this list, not clearly one option, or not a product line." }],
    };
  });
  // Shared evidence goes in `input` (cacheable prefix); per-line material goes in questions (not cached).
  const input = `Indian FMCG distributor order from a retailer (channel: ${req.order.channel}). Messages mix Hindi and English, ` +
    `use brand shorthand and pack prices ("10 wala" / "rs 10" = the ₹10 MRP pack). Each question is one line of this message. Full message:\n${req.order.text}`;
  return { body: { model, input, questions, prompt_cache_key: req.order.retailerId?.slice(0, 64) }, valueMaps };
}

export function parseDecisionsResponse(req: OrderDecisionRequest, res: DecisionsResponse, valueMaps: Map<string, string>[]): LineDecision[] {
  const byName = new Map(res.answers.map(a => [a.name, a] as const));
  return req.lines.map(({ line }, i) => {
    const a = byName.get(line.lineId) ?? res.answers[i];
    if (!a || a.type !== "choice") return { lineId: line.lineId, choice: NONE, probabilities: [], confidence: 0, refused: true };
    const vm = valueMaps[i]; const map = (v: string | boolean) => vm.get(String(v)) ?? NONE;
    return { lineId: line.lineId, choice: map(a.choice), confidence: a.confidence, refused: false,
      probabilities: a.probabilities.map(p => ({ skuId: map(p.value), p: p.probability })) };
  });
}

export class OpenAIDecisionsAdapter implements DecisionAdapter {
  readonly name = "openai-decisions";
  private opts: { apiKey: string; baseUrl?: string; prices?: PriceTable; timeoutMs?: number } & BuildOptions;
  constructor(opts: OpenAIDecisionsAdapter["opts"]) { this.opts = opts; }
  async decideOrder(req: OrderDecisionRequest): Promise<OrderDecisionResult> {
    const { body, valueMaps } = buildDecisionsRequest(req, this.opts);
    const r = await fetch(`${this.opts.baseUrl ?? "https://api.openai.com/v1"}/decisions`, {
      method: "POST", headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15000),
    });
    if (!r.ok) throw new Error(`Decisions API ${r.status}: ${redactSecrets((await r.text()).slice(0, 500))}`);
    const res = (await r.json()) as DecisionsResponse;
    const cached = res.usage.input_tokens_details?.cached_tokens ?? 0, writes = res.usage.input_tokens_details?.cache_write_tokens ?? 0;
    return { decisions: parseDecisionsResponse(req, res, valueMaps), raw: res,
      usage: { inputTokens: res.usage.input_tokens, cachedTokens: cached, requests: 1, costUsd: costUsd(this.opts.prices ?? OPENAI_DECISIONS_PRICES, res.usage.input_tokens, cached, writes) } };
  }
}
