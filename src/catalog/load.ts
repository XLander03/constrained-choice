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
  const [head, ...rows] = parseCsv(readFileSync(path, "utf8"));
  const ix = (k: string) => { const i = head.indexOf(k); if (i < 0) throw new Error(`catalog missing column ${k}`); return i; };
  return rows.map(r => ({
    skuId: r[ix("sku_id")], brand: r[ix("brand")], product: r[ix("product")], variant: r[ix("variant")],
    packSize: Number(r[ix("pack_size")]), packUnit: r[ix("pack_unit")], mrpInr: Number(r[ix("mrp_inr")]),
    caseQty: Number(r[ix("case_qty")]), stripQty: r[ix("strip_qty")] ? Number(r[ix("strip_qty")]) : null,
    category: r[ix("category")], aliases: r[ix("aliases")].split("|").filter(Boolean),
  }));
}

export const skuLabel = (s: Sku) =>
  [s.brand, s.product, s.variant, `${s.packSize}${s.packUnit}`].filter(Boolean).join(" ");
