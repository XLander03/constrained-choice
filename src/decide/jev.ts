// Jev (TypeSafe AI) adapter — placeholder for week 4. Not implemented; no key, no verified docs yet.
// Third-party note (docs.aimlapi.com, unverified against TypeSafe's own docs): Jev/d1 use a different contract from Luna —
// content in `state` (not `input`), questions as an object keyed by name, choice options as `criteria: {key: description}`,
// answers as an object keyed by name. Implement against TypeSafe's official reference once access exists.
import type { DecisionAdapter, OrderDecisionRequest, OrderDecisionResult } from "./adapter.ts";
export class JevAdapter implements DecisionAdapter {
  readonly name = "jev";
  async decideOrder(_req: OrderDecisionRequest): Promise<OrderDecisionResult> {
    throw new Error("JevAdapter not implemented yet (see SPEC.md §6)");
  }
}
