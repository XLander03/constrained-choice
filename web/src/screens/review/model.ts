// Pure review state: one draft per parsed line, a cursor, and the alternatives panel. No React here.
import { isFullSku, type ApproveInput, type KnownUnit, type LineDecisionInput, type Order, type OrderUnit, type ParsedLine, type SkuRef, type SkuSummary } from "../../api/types.ts";
import { sellingUnits, unitsAllowed } from "../../lib/domain.ts";

export type LineStatus = "auto" | "pending" | "confirmed" | "changed" | "not_stocked";

export interface Draft { sku: SkuRef | SkuSummary | null; qty: number | null; unit: OrderUnit; status: LineStatus }

export interface ReviewState {
  drafts: Draft[];
  cursor: number;
  altOpen: boolean;
  altIndex: number;
}

export type Action =
  | { type: "move"; delta: number }
  | { type: "focus"; index: number }
  | { type: "confirm"; index: number }
  | { type: "pick"; index: number; sku: SkuRef | SkuSummary }
  | { type: "enrich"; sku: SkuSummary }
  | { type: "notStocked"; index: number }
  | { type: "qty"; index: number; qty: number | null }
  | { type: "unit"; index: number; unit: OrderUnit }
  | { type: "cycleUnit"; index: number }
  | { type: "revert"; index: number }
  | { type: "openAlts" } | { type: "closeAlts" } | { type: "altMove"; delta: number; count: number };

const original = (l: ParsedLine): Draft => ({ sku: l.choice, qty: l.qty, unit: l.unit, status: l.route === "auto" ? "auto" : "pending" });

export function initReview(order: Order): ReviewState {
  const drafts = order.lines.map(original);
  const firstPending = drafts.findIndex(d => d.status === "pending");
  return { drafts, cursor: Math.max(0, firstPending), altOpen: false, altIndex: 0 };
}

/** Why this draft can't be accepted yet, or null when it can. */
export function draftProblem(d: Draft): string | null {
  if (d.status === "not_stocked") return null;
  if (!d.sku) return "pick a SKU";
  if (d.qty === null || !(d.qty > 0)) return "enter a quantity";
  if (d.unit === "unspecified") return "choose a unit";
  if (d.unit === "strip" && isFullSku(d.sku) && !d.sku.stripQty) return "this SKU isn't sold by the strip";
  return null;
}

const isChanged = (d: Draft, l: ParsedLine) => d.sku?.skuId !== l.choice?.skuId || d.qty !== l.qty || d.unit !== l.unit;
export const isResolved = (d: Draft) => d.status !== "pending";

/** After an edit: an untouched auto line stays auto; a resolved line that becomes incomplete goes back to pending. */
function touched(d: Draft, l: ParsedLine): Draft {
  if (d.status === "not_stocked") return d;
  if (l.route === "auto" && !isChanged(d, l)) return { ...d, status: "auto" };
  if (d.status !== "pending") return { ...d, status: draftProblem(d) ? "pending" : isChanged(d, l) ? "changed" : "confirmed" };
  return d;
}

function nextPending(drafts: Draft[], from: number): number {
  for (let k = 1; k <= drafts.length; k++) { const i = (from + k) % drafts.length; if (drafts[i].status === "pending") return i; }
  return Math.min(from + 1, drafts.length - 1);
}

export function reducer(lines: ParsedLine[]) {
  return (s: ReviewState, a: Action): ReviewState => {
    const set = (i: number, d: Draft, advance = false): ReviewState => {
      const drafts = s.drafts.map((x, k) => (k === i ? d : x));
      return { ...s, drafts, altOpen: false, altIndex: 0, cursor: advance ? nextPending(drafts, i) : s.cursor };
    };
    switch (a.type) {
      case "move": return { ...s, cursor: Math.min(s.drafts.length - 1, Math.max(0, s.cursor + a.delta)), altOpen: false, altIndex: 0 };
      case "focus": return a.index === s.cursor ? s : { ...s, cursor: a.index, altOpen: false, altIndex: 0 };
      case "confirm": {
        const d = s.drafts[a.index]; if (draftProblem(d)) return s;
        return set(a.index, { ...d, status: isChanged(d, lines[a.index]) ? "changed" : "confirmed" }, true);
      }
      case "pick": {
        const d0 = s.drafts[a.index];
        const unit: OrderUnit = d0.unit === "strip" && isFullSku(a.sku) && !a.sku.stripQty ? "unspecified" : d0.unit;
        const d: Draft = { ...d0, sku: a.sku, unit, status: "pending" };
        // Picking is a decision: resolve now if nothing else is missing, otherwise stay on the line.
        if (!draftProblem(d)) return set(a.index, { ...d, status: isChanged(d, lines[a.index]) ? "changed" : "confirmed" }, true);
        return set(a.index, d);
      }
      case "enrich": return { ...s, drafts: s.drafts.map(d => (d.sku?.skuId === a.sku.skuId && !isFullSku(d.sku) ? { ...d, sku: a.sku } : d)) };
      case "notStocked": return set(a.index, { ...s.drafts[a.index], status: "not_stocked" }, true);
      case "qty": return set(a.index, touched({ ...s.drafts[a.index], qty: a.qty }, lines[a.index]));
      case "unit": return set(a.index, touched({ ...s.drafts[a.index], unit: a.unit }, lines[a.index]));
      case "cycleUnit": {
        const d = s.drafts[a.index]; const opts: OrderUnit[] = unitsAllowed(d.sku);
        const next = opts[(opts.indexOf(d.unit) + 1) % opts.length] ?? opts[0];
        return set(a.index, touched({ ...d, unit: next }, lines[a.index]));
      }
      case "revert": return set(a.index, original(lines[a.index]));
      case "openAlts": return { ...s, altOpen: true, altIndex: 0 };
      case "closeAlts": return { ...s, altOpen: false, altIndex: 0 };
      case "altMove": return { ...s, altIndex: a.count ? (s.altIndex + a.delta + a.count) % a.count : 0 };
    }
  };
}

export const lineAmount = (d: Draft): number | null => {
  if (d.status === "not_stocked" || !isFullSku(d.sku) || d.qty === null || d.unit === "unspecified") return null;
  const u = sellingUnits(d.sku, d.qty, d.unit as KnownUnit); return u === null ? null : u * d.sku.mrpInr;
};

export interface Gate { ok: boolean; reason: string; pending: number[]; invalid: number[] }
export function approveGate(drafts: Draft[]): Gate {
  const pending = drafts.flatMap((d, i) => (d.status === "pending" ? [i] : []));
  const invalid = drafts.flatMap((d, i) => (d.status !== "pending" && draftProblem(d) ? [i] : []));
  const list = (xs: number[]) => xs.slice(0, 4).map(i => i + 1).join(", ") + (xs.length > 4 ? "…" : "");
  if (pending.length) return { ok: false, pending, invalid, reason: `${pending.length} flagged line${pending.length > 1 ? "s" : ""} still need${pending.length > 1 ? "" : "s"} review (line${pending.length > 1 ? "s" : ""} ${list(pending)})` };
  if (invalid.length) return { ok: false, pending, invalid, reason: `Line ${list(invalid)}: ${draftProblem(drafts[invalid[0]])}` };
  if (drafts.every(d => d.status === "not_stocked")) return { ok: false, pending, invalid, reason: "Every line is marked not stocked, so there is nothing to approve" };
  return { ok: true, pending, invalid, reason: "All lines resolved" };
}

/** Body for POST /orders/:id/approve: every review line, plus any auto line the reviewer touched. Untouched auto lines are omitted. */
export function toApproveInput(lines: ParsedLine[], drafts: Draft[]): ApproveInput {
  return {
    lines: lines.flatMap((l, i): LineDecisionInput[] => {
      const d = drafts[i];
      if (d.status === "auto") return [];
      if (d.status === "not_stocked" || !d.sku) return [{ lineId: l.lineId, skuId: null }];
      return [{ lineId: l.lineId, skuId: d.sku.skuId, ...(d.qty !== null ? { qty: d.qty } : {}), ...(d.unit !== "unspecified" ? { unit: d.unit } : {}) }];
    }),
  };
}
