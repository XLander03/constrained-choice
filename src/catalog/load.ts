import { readFileSync } from "node:fs";
import type { Sku } from "../types.ts";

/** Minimal RFC4180-ish CSV parser (quoted fields, escaped quotes). Lines starting with '#' are skipped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.length > 1 && !r[0].startsWith("#"));
}

export function loadCatalog(path: string): Sku[] {
  const r = catalogFromCsv(readFileSync(path, "utf8"));
  if (r.errors.length) throw new Error(`catalog ${path}: ${r.errors.slice(0, 5).join("; ")}`);
  return r.skus;
}

/** Column synonyms so a real item master (Tally / Busy / Marg export, or a hand-made sheet) can be uploaded as-is. */
const COLS: Record<string, string[]> = {
  sku_id: ["sku_id", "sku", "item_code", "itemcode", "code", "item_id", "id", "product_code"],
  product: ["product", "item_name", "itemname", "name", "product_name", "description", "item"],
  brand: ["brand", "manufacturer", "company", "mfr"],
  variant: ["variant", "flavour", "flavor", "colour", "color", "type"],
  pack_size: ["pack_size", "size", "packsize", "weight", "net_qty"],
  pack_unit: ["pack_unit", "uom", "size_unit", "unit"],
  mrp_inr: ["mrp_inr", "mrp", "price", "rate", "selling_price"],
  case_qty: ["case_qty", "units_per_case", "case_size", "case", "pcs_per_case", "conversion"],
  strip_qty: ["strip_qty", "units_per_strip", "strip"],
  category: ["category", "group", "stock_group", "item_group"],
  aliases: ["aliases", "alias", "synonyms", "local_names", "keywords"],
};
const norm = (h: string) => h.trim().toLowerCase().replace(/^\ufeff/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const SIZE_IN_NAME = /(\d+(?:\.\d+)?)\s*(g|gm|gms|kg|ml|l|ltr|litre|pcs|pc)\b/i;
const UNIT_NORM: Record<string, string> = { gm: "g", gms: "g", ltr: "L", litre: "L", l: "L", pc: "pcs" };

export interface CatalogParseResult { skus: Sku[]; errors: string[]; warnings: string[]; columns: Record<string, string | null> }

/** Parse a catalog CSV, mapping common column names. Hard errors: no sku/product column, blank or duplicate ids. */
export function catalogFromCsv(text: string): CatalogParseResult {
  const errors: string[] = [], warnings: string[] = [];
  const [head0, ...rows] = parseCsv(text);
  if (!head0) return { skus: [], errors: ["file is empty"], warnings, columns: {} };
  const head = head0.map(norm);
  const columns: Record<string, string | null> = {}; const ix: Record<string, number> = {};
  for (const [k, syn] of Object.entries(COLS)) {
    const i = syn.map(x => head.indexOf(x)).find(i => i >= 0) ?? -1;
    ix[k] = i; columns[k] = i >= 0 ? head0[i].trim() : null;
  }
  if (ix.sku_id < 0) errors.push(`no SKU id column (expected one of: ${COLS.sku_id.join(", ")})`);
  if (ix.product < 0) errors.push(`no product name column (expected one of: ${COLS.product.join(", ")})`);
  if (errors.length) return { skus: [], errors, warnings, columns };
  for (const k of ["mrp_inr", "case_qty", "pack_size"]) if (ix[k] < 0) warnings.push(`no ${k} column: ${k === "case_qty" ? "case orders (peti/box) can't be converted to units" : k === "mrp_inr" ? "price hints like '10 wala' won't help matching" : "pack size will be read from the product name when possible"}`);
  const get = (r: string[], k: string) => (ix[k] >= 0 ? (r[ix[k]] ?? "").trim() : "");
  const num = (v: string) => { const n = Number(v.replace(/[₹,\s]/g, "")); return v && Number.isFinite(n) ? n : NaN; };
  const seen = new Set<string>(); const skus: Sku[] = [];
  rows.forEach((r, i) => {
    const line = i + 2; const id = get(r, "sku_id"); const product = get(r, "product");
    if (!id && !product) return;                                        // blank row
    // Unquoted commas/quotes shift every later field (QA L7: a label became the brand and MRP 0). Reject rather than guess.
    if (r.length > head0.length) { errors.push(`row ${line}: ${r.length} fields but the header has ${head0.length}; quote fields that contain commas or quotes`); return; }
    if (r.length < head0.length && r.some(x => x.trim())) warnings.push(`row ${line}: ${r.length} fields, header has ${head0.length}; missing fields read as blank`);
    if (!id) { errors.push(`row ${line}: blank SKU id`); return; }
    if (!product) { errors.push(`row ${line}: blank product name for ${id}`); return; }
    if (seen.has(id)) { errors.push(`row ${line}: duplicate SKU id ${id}`); return; }
    seen.add(id);
    let packSize = num(get(r, "pack_size")), packUnit = get(r, "pack_unit");
    if (!Number.isFinite(packSize)) { const m = product.match(SIZE_IN_NAME); packSize = m ? Number(m[1]) : 0; if (m && !packUnit) packUnit = m[2]; }
    packUnit = UNIT_NORM[packUnit.toLowerCase()] ?? packUnit;
    const mrp = num(get(r, "mrp_inr")), caseQty = num(get(r, "case_qty")), strip = num(get(r, "strip_qty"));
    skus.push({ skuId: id, brand: get(r, "brand"), product, variant: get(r, "variant"),
      packSize, packUnit, mrpInr: Number.isFinite(mrp) ? mrp : 0, caseQty: Number.isFinite(caseQty) && caseQty > 0 ? caseQty : 1,
      stripQty: Number.isFinite(strip) && strip > 0 ? strip : null, category: get(r, "category"),
      aliases: get(r, "aliases").split("|").map(a => a.trim()).filter(Boolean) });
  });
  if (!skus.length && !errors.length) errors.push("no product rows found");
  return { skus, errors, warnings, columns };
}

/** Readable label. Size is appended unless the product name already carries it (uploaded catalogs often do). */
export const skuLabel = (s: Sku) =>
  [s.brand, s.product, s.variant, s.packSize && !SIZE_IN_NAME.test(s.product) ? `${s.packSize}${s.packUnit}` : ""].filter(Boolean).join(" ");
