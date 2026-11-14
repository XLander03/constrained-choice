// Client-side catalog preview using the backend's own parser (src/catalog/load.ts), so the errors shown before
// upload are the ones POST /catalog would return. The server rejects the whole file if any error remains.
import { catalogFromCsv, parseCsv } from "../../../src/catalog/load.ts";

export interface CatalogPreview {
  header: string[];
  rows: string[][];                       // data rows as written (first 500)
  totalRows: number;
  skuCount: number;
  errors: string[];                        // "row 7: duplicate SKU id A12" (row = 1-based file line)
  warnings: string[];
  columns: Record<string, string | null>;  // field → header it was matched to
  rowErrors: Map<number, string[]>;        // file line → messages
}

export function previewCatalog(csv: string): CatalogPreview {
  const text = csv.replace(/^\ufeff/, "");
  const r = catalogFromCsv(text);
  const [header = [], ...rows] = parseCsv(text);
  const rowErrors = new Map<number, string[]>();
  for (const e of r.errors) { const m = /^row (\d+):\s*(.*)$/.exec(e); if (m) { const n = Number(m[1]); rowErrors.set(n, [...(rowErrors.get(n) ?? []), m[2]]); } }
  return { header, rows: rows.slice(0, 500), totalRows: rows.length, skuCount: r.skus.length, errors: r.errors, warnings: r.warnings, columns: r.columns, rowErrors };
}
