// Offline stand-in for a decision model so the pipeline and eval harness run without a key.
// It NEVER sees gold labels: it turns retrieval signals into a noisy softmax. Its accuracy says nothing about any real model.
import { NONE, type LineDecision } from "../types.ts";
import { OPENAI_DECISIONS_PRICES, costUsd, type DecisionAdapter, type OrderDecisionRequest, type OrderDecisionResult } from "./adapter.ts";
import { buildDecisionsRequest } from "./openai.ts";

function rng(seedStr: string) { let h = 2166136261; for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; }; }
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

export class MockDecisionAdapter implements DecisionAdapter {
  readonly name = "mock";
  private noise: number;
  constructor(noise = 0.5) { this.noise = noise; }
  async decideOrder(req: OrderDecisionRequest): Promise<OrderDecisionResult> {
    const decisions: LineDecision[] = req.lines.map(({ line, candidates }) => {
      const r = rng(line.lineId);
      const maxLex = Math.max(1e-9, ...candidates.map(c => c.lexicalScore ?? 0));
      const z = candidates.map(c => 7 * (c.vectorScore ?? 0) + 3 * ((c.lexicalScore ?? 0) / maxLex) + 120 * c.score + this.noise * gauss(r));
      const top = Math.max(...candidates.map(c => c.vectorScore ?? 0));
      const zNone = 7.5 + 4 * (0.55 - top);
      const all = [...z, zNone]; const m = Math.max(...all); const e = all.map(v => Math.exp(v - m)); const sum = e.reduce((a, b) => a + b, 0);
      const probabilities = [...candidates.map((c, i) => ({ skuId: c.sku.skuId as string, p: e[i] / sum })), { skuId: NONE as string, p: e[e.length - 1] / sum }];
      const best = probabilities.reduce((a, b) => (b.p > a.p ? b : a));
      return { lineId: line.lineId, choice: best.skuId, probabilities, confidence: best.p, refused: false };
    });
    // Token estimate from the exact body the OpenAI adapter would send (~4 chars/token) so cost/order is a usable estimate.
    const est = Math.ceil(JSON.stringify(buildDecisionsRequest(req).body).length / 4);
    return { decisions, usage: { inputTokens: est, cachedTokens: 0, requests: 1, costUsd: costUsd(OPENAI_DECISIONS_PRICES, est, 0, 0) } };
  }
}
