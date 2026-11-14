// Hard input-token budget for paid runs. Estimates each request before sending it and refuses once the
// projected total would pass the cap. The estimate (JSON chars / 4) undercounts real tokens by ~25% on this
// data, so the guard projects with max(minRatio, observed actual/estimate ratio so far).
import type { DecisionAdapter, OrderDecisionRequest, OrderDecisionResult } from "./adapter.ts";
import { buildDecisionsRequest, type BuildOptions } from "./openai.ts";

export class BudgetExceededError extends Error {
  readonly spentTokens: number; readonly projectedTokens: number; readonly capTokens: number;
  constructor(spentTokens: number, projectedTokens: number, capTokens: number) {
    super(`token budget stop: spent ${spentTokens}, next request projected ${projectedTokens}, cap ${capTokens}`);
    this.spentTokens = spentTokens; this.projectedTokens = projectedTokens; this.capTokens = capTokens;
  }
}

export const estimateTokens = (req: OrderDecisionRequest, opts: BuildOptions = {}) =>
  Math.ceil(JSON.stringify(buildDecisionsRequest(req, opts).body).length / 4);

export class BudgetedAdapter implements DecisionAdapter {
  readonly name: string;
  spent = 0; private estSent = 0;
  private inner: DecisionAdapter; private capTokens: number; private build: BuildOptions; private minRatio: number;
  constructor(inner: DecisionAdapter, capTokens: number, build: BuildOptions = {}, minRatio = 1.35) {
    this.inner = inner; this.capTokens = capTokens; this.build = build; this.minRatio = minRatio; this.name = inner.name;
  }
  get ratio() { return Math.max(this.minRatio, this.estSent ? this.spent / this.estSent : 0); }
  async decideOrder(req: OrderDecisionRequest): Promise<OrderDecisionResult> {
    const est = estimateTokens(req, this.build); const projected = Math.ceil(est * this.ratio);
    if (this.spent + projected > this.capTokens) throw new BudgetExceededError(this.spent, projected, this.capTokens);
    const res = await this.inner.decideOrder(req);
    this.spent += res.usage.inputTokens; this.estSent += est;
    return res;
  }
}
