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
const choiceDesc = (s: Sku) => `MRP ₹${s.mrpInr}; case of ${s.caseQty}. Also called: ${s.aliases.filter(a => !/\d/.test(a)).slice(0, 4).join(", ")}`;

/** Pure function: builds the wire body and the value→skuId map. Shared by the real adapter and the mock (for token estimates). */
export function buildDecisionsRequest(req: OrderDecisionRequest, model = "gpt-6-luna"): { body: DecisionsRequestBody; valueMaps: Map<string, string>[] } {
  if (req.lines.length > MAX_QUESTIONS) throw new Error(`order has ${req.lines.length} lines; split into ≤${MAX_QUESTIONS} per request`);
  const valueMaps: Map<string, string>[] = [];
  const questions = req.lines.map(({ line, candidates }) => {
    const cands = candidates.slice(0, MAX_CHOICES - 1);
    const vm = new Map<string, string>(cands.map(c => [choiceValue(c.sku), c.sku.skuId]));
    vm.set(NONE_VALUE, NONE); valueMaps.push(vm);
    const hints = [line.sizeHint && `size ${line.sizeHint.value}${line.sizeHint.unit}`, line.priceHint != null && `price ₹${line.priceHint}`].filter(Boolean).join(", ");
    return {
      type: "choice" as const, name: line.lineId,
      instructions: `Which catalog product is the retailer ordering in this line: "${line.raw}"? Ignore the quantity.${hints ? ` Hints: ${hints}.` : ""} ` +
        `"wala"/"rs" numbers are the pack's MRP. Pick ${NONE_VALUE} if the product, variant or pack size is not clearly one of the options.`,
      choices: [...cands.map(c => ({ value: choiceValue(c.sku), description: choiceDesc(c.sku) })),
        { value: NONE_VALUE, description: "Not in this list, not clearly one option, or not a product line." }],
    };
  });
  // Shared evidence goes in `input` (cacheable prefix); per-line material goes in questions (not cached).
  const input = `Indian FMCG distributor order from a retailer (channel: ${req.order.channel}). Messages mix Hindi and English, ` +
    `use brand shorthand and pack prices ("10 wala" = ₹10 pack). Full message:\n${req.order.text}`;
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
  private opts: { apiKey: string; model?: string; baseUrl?: string; prices?: PriceTable; timeoutMs?: number };
  constructor(opts: OpenAIDecisionsAdapter["opts"]) { this.opts = opts; }
  async decideOrder(req: OrderDecisionRequest): Promise<OrderDecisionResult> {
    const { body, valueMaps } = buildDecisionsRequest(req, this.opts.model);
    const r = await fetch(`${this.opts.baseUrl ?? "https://api.openai.com/v1"}/decisions`, {
      method: "POST", headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15000),
    });
    if (!r.ok) throw new Error(`Decisions API ${r.status}: ${await r.text()}`);
    const res = (await r.json()) as DecisionsResponse;
    const cached = res.usage.input_tokens_details?.cached_tokens ?? 0, writes = res.usage.input_tokens_details?.cache_write_tokens ?? 0;
    return { decisions: parseDecisionsResponse(req, res, valueMaps), raw: res,
      usage: { inputTokens: res.usage.input_tokens, cachedTokens: cached, requests: 1, costUsd: costUsd(this.opts.prices ?? OPENAI_DECISIONS_PRICES, res.usage.input_tokens, cached, writes) } };
  }
}
