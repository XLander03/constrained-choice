// Generates data/catalog.csv — SYNTHETIC distributor catalog.
// Brand names are used only as generic catalog entries; prices, case sizes and SKU ids are invented.
import { writeFileSync } from "node:fs";

import { F } from "./families.ts";

const esc = (s: string) => /[",|\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
const fmtSize = (n: number, u: string) => `${n}${u}`;
const rows: string[] = ["sku_id,brand,product,variant,pack_size,pack_unit,mrp_inr,case_qty,strip_qty,category,aliases,data_label"];
let n = 0;
for (const f of F) for (const v of f.variants) for (const [sz, u, mrp, cq] of f.sizes) {
  n++;
  const id = `SKU${String(n).padStart(4, "0")}`;
  const al = new Set<string>();
  for (const a of f.aliases) { al.add(a); al.add(`${a} ${fmtSize(sz,u)}`); }
  for (const a of f.vAliases?.[v] ?? []) { al.add(a); al.add(`${a} ${fmtSize(sz,u)}`); }
  if (u === "g" || u === "ml" || u === "pcs") al.add(`${f.aliases[0]} ${mrp} wala`), al.add(`${f.aliases[0]} rs${mrp}`);
  const strip = f.strip && sz < 10 && (u === "ml" || u === "g") ? f.strip : "";
  rows.push([id, f.brand, f.product, v, String(sz), u, String(mrp), String(cq), String(strip), f.cat, [...al].join("|"), "SYNTHETIC"].map(esc).join(","));
}
writeFileSync(new URL("../data/catalog.csv", import.meta.url), rows.join("\n") + "\n");
console.log(`wrote ${n} SKUs`);
