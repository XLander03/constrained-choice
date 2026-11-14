import { isFullSku, type KnownUnit, type OrderUnit, type ReviewReason, type SkuRef, type SkuSummary } from "../api/types.ts";

/** Selling units for qty × unit of this SKU, or null if the SKU can't be sold in that unit. */
/** Same conversion as the backend's unitsTotal(): case × case_qty, dozen × 12, strip × strip_qty, pc × 1. */
export function sellingUnits(sku: SkuSummary, qty: number, unit: KnownUnit): number | null {
  switch (unit) {
    case "pc": return qty;
    case "dozen": return qty * 12;
    case "case": return sku.caseQty > 0 ? qty * sku.caseQty : null;
    case "strip": return sku.stripQty ? qty * sku.stripQty : null;
  }
}
/** Strip is only offered for SKUs sold by the strip (when we know). */
export const unitsAllowed = (sku: SkuRef | SkuSummary | null): KnownUnit[] =>
  isFullSku(sku) && !sku.stripQty ? ["pc", "dozen", "case"] : ["pc", "dozen", "case", "strip"];

export const UNIT_LABEL: Record<OrderUnit, string> = { pc: "pc", dozen: "dozen", case: "case", strip: "strip", unspecified: "unit?" };
export const UNIT_HINT: Record<KnownUnit, string> = { pc: "piece / packet", dozen: "12 pcs", case: "peti / carton", strip: "ladi" };

// Labels from API.md "UI requirements".
export const REASON_LABEL: Record<ReviewReason, string> = {
  none_of_these: "Not found in catalog",
  low_confidence: "Not sure",
  qty_missing: "Quantity?",
  unit_unspecified: "Unit? (pc / dozen / case / strip)",
  pack_size_ambiguous: "Which pack size?",
  variant_ambiguous: "Which variant?",
  refused: "Model declined",
  low_overlap: "Name doesn't match the product",
};
export const REASON_SHORT: Record<ReviewReason, string> = {
  none_of_these: "Not in catalog", low_confidence: "Not sure", qty_missing: "Quantity?", unit_unspecified: "Unit?",
  pack_size_ambiguous: "Which pack size?", variant_ambiguous: "Which variant?", refused: "Model declined",
  low_overlap: "Name doesn't match the product",
};
export const REASON_HELP: Record<ReviewReason, string> = {
  none_of_these: "The model said none of the shortlisted SKUs match. Pick one, search the catalog, or mark it not stocked.",
  low_confidence: "The model's pick is below the auto-accept threshold.",
  qty_missing: "No quantity found in the line.",
  unit_unspecified: "The retailer wrote a bare number. Choose pc, dozen, case or strip.",
  pack_size_ambiguous: "The line doesn't say which pack size. The packs that fit are listed first.",
  variant_ambiguous: "The line doesn't say which variant. The variants that fit are listed first.",
  low_overlap: "The picked SKU's name explains too little of what the retailer wrote (e.g. \"red bull\" vs Red Label Tea). Check the product, whatever the confidence.",
  refused: "The model declined to answer this line.",
};

const inr0 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatInr = (n: number, precise = false) => (precise ? inr2 : inr0).format(n);
export const formatUsd = (n: number) => `$${n < 0.01 ? n.toFixed(5) : n.toFixed(4)}`;
export const formatPct = (n: number) => `${(n * 100).toFixed(n >= 0.995 || n === 0 ? 0 : 1)}%`;
export const INR_PER_USD = 88;

export function formatTime(iso: string): string {
  const d = new Date(iso); const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export type ConfidenceBand = "high" | "medium" | "low";
export const confidenceBand = (c: number, threshold: number): ConfidenceBand => (c >= threshold ? "high" : c >= 0.5 ? "medium" : "low");
