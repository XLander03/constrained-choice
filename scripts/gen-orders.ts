// Generates data/orders.jsonl — SYNTHETIC WhatsApp/email orders with gold labels.
// Deterministic (seeded). Gold labels are produced alongside the text, never inferred from it.
import { writeFileSync } from "node:fs";
import { F, type Fam } from "./families.ts";
import type { GoldLine, GoldOrder, OrderUnit } from "../src/types.ts";

let seed = 20261114;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const chance = (p: number) => rnd() < p;

type S = { id: string; fam: Fam; variant: string; size: number; unit: string; mrp: number; caseQty: number; strip: number | null };
const skus: S[] = []; let n = 0;
for (const fam of F) for (const variant of fam.variants) for (const [size, unit, mrp, caseQty] of fam.sizes) {
  n++; skus.push({ id: `SKU${String(n).padStart(4, "0")}`, fam, variant, size, unit, mrp, caseQty,
    strip: fam.strip && size < 10 && (unit === "ml" || unit === "g") ? fam.strip : null });
}
const famSkus = (f: Fam) => skus.filter(s => s.fam === f);
const find = (product: string, size: number, variant = "") =>
  skus.find(s => s.fam.product === product && s.size === size && (variant === "" || s.variant === variant))!;

const HINDI_NUM: Record<number, string[]> = { 1: ["ek"], 2: ["do"], 3: ["teen"], 4: ["char", "chaar"], 5: ["paanch", "panch"], 6: ["chhe"], 10: ["das"], 12: ["barah"] };
const UNIT_WORDS: Record<Exclude<OrderUnit, "unspecified">, string[]> = {
  case: ["peti", "peti", "pet", "ctn", "carton", "case", "cs", "box", "dabba"],
  dozen: ["dozen", "dzn", "doz", "darjan", "dz"],
  pc: ["pc", "pcs", "pieces", "nos", "pkt", "packet"],
  strip: ["ladi", "strip", "ladi"],
};

function typo(w: string): string {
  if (w.length < 5) return w;
  const i = 1 + Math.floor(rnd() * (w.length - 2));
  const k = rnd();
  if (k < 0.4) return w.slice(0, i) + w.slice(i + 1);                    // drop
  if (k < 0.7) return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);  // swap
  return w.slice(0, i) + w[i] + w.slice(i);                              // double
}
function sizeText(s: S): string {
  const u = s.unit;
  const forms = u === "g" ? [`${s.size}g`, `${s.size} gm`, `${s.size}gm`, `${s.size} gram`]
    : u === "kg" ? [`${s.size}kg`, `${s.size} kg`, `${s.size} kilo`]
    : u === "ml" ? [`${s.size}ml`, `${s.size} ml`]
    : u === "L" ? [`${s.size}L`, `${s.size} ltr`, `${s.size} litre`]
    : [];
  const price = [`${s.mrp} wala`, `rs ${s.mrp}`, `${s.mrp}rs`, `₹${s.mrp}`];
  if (!forms.length || (s.size < 100 && (u === "g" || u === "ml") && chance(0.5))) return pick(price);
  return pick(forms);
}

interface Mention { text: string; gold: Omit<GoldLine, "raw" | "qty" | "unit">; tags: string[] }
function mention(s: S): Mention {
  const tags: string[] = [];
  const fs = famSkus(s.fam);
  let name = pick(s.fam.aliases);
  const vAl = s.fam.vAliases?.[s.variant];
  const variants = new Set(fs.map(x => x.variant));
  const sizes = new Set(fs.filter(x => x.variant === s.variant).map(x => x.size));
  let variantGiven = variants.size <= 1;
  if (!variantGiven) {
    if (vAl && chance(0.6)) { name = pick(vAl); variantGiven = true; }
    else if (chance(0.85)) { name = `${name} ${s.variant.toLowerCase()}`; variantGiven = true; }
  }
  let sizeGiven = sizes.size <= 1;
  let txt = name;
  if (!sizeGiven && chance(0.9)) { txt = chance(0.7) ? `${name} ${sizeText(s)}` : `${sizeText(s)} ${name}`; sizeGiven = true; }
  if (chance(0.18)) { const ws = txt.split(" "); const i = ws.findIndex(w => /^[a-z]{5,}$/.test(w)); if (i >= 0) { ws[i] = typo(ws[i]); txt = ws.join(" "); tags.push("typo"); } }
  if (chance(0.15)) txt = txt.toUpperCase();
  if (name.length <= 4 || /^(gd|dm|tu|hns|pg|f&l|rl|se|lb)\b/.test(name)) tags.push("abbreviation");
  if (variantGiven && sizeGiven) return { text: txt, gold: { sku_id: s.id }, tags };
  const acceptable = fs.filter(x => (variantGiven ? x.variant === s.variant : true)).map(x => x.id);
  tags.push("ambiguous");
  return { text: txt, gold: { sku_id: null, ambiguous: true, acceptable_sku_ids: acceptable }, tags };
}

function qtyText(s: S): { q: number; unit: OrderUnit; fmt: (item: string) => string; tags: string[] } {
  const tags: string[] = [];
  const unit: OrderUnit = s.strip && chance(0.6) ? "strip" : pick<OrderUnit>(["case", "case", "case", "dozen", "pc", "unspecified"]);
  const q = unit === "case" ? pick([1, 1, 2, 2, 3, 5, 10]) : unit === "dozen" ? pick([1, 2, 3, 5, 6, 10]) : unit === "strip" ? pick([2, 4, 5, 10, 20]) : pick([6, 10, 12, 24, 48]);
  let qs = String(q);
  if (HINDI_NUM[q] && chance(0.3)) { qs = pick(HINDI_NUM[q]); tags.push("hindi_number"); }
  if (unit === "unspecified") { tags.push("unit_implicit"); return { q, unit, tags, fmt: it => pick([`${it} ${qs}`, `${it} - ${qs}`, `${qs} ${it}`]) }; }
  let uw = pick(UNIT_WORDS[unit]);
  if (unit === "case" && ["peti", "dabba", "box"].includes(uw) && q > 1 && chance(0.5)) uw = { peti: "peti", dabba: "dabbe", box: "boxes" }[uw]!;
  if (unit === "pc" && /^\d/.test(qs) && chance(0.35)) return { q, unit, tags, fmt: it => `${it} x${qs}` };
  const glue = /^\d/.test(qs) && chance(0.3) ? "" : " ";
  return { q, unit, tags, fmt: it => pick([`${qs}${glue}${uw} ${it}`, `${it} ${qs}${glue}${uw}`, `${it} - ${qs} ${uw}`, `${it} = ${qs} ${uw}`]) };
}

const OOC = ["mother dairy dahi 400g", "amul taaza milk 1L", "gillette guard razor", "fevicol 50g", "classmate notebook", "uncle chipps", "patanjali atta noodles",
  "britannia cake 60g", "maggi pasta", "sunsilk conditioner", "surf excel quick wash 2kg", "colgate charcoal brush", "haldiram rasgulla tin", "dettol handwash refill",
  "tata sampann dal 1kg", "red bull 250ml", "lays american style 115g", "rin liquid 1L", "everest pav bhaji masala", "nescafe gold 50g"];
const RETAILERS = ["Sharma General Store", "Gupta Kirana", "Shree Balaji Traders", "Patel Provision", "Jai Mata Di Stores", "New Annapurna Mart", "Raju Kirana", "Laxmi Super Bazaar", "Khan Brothers", "Om Sai Provision"];
const OPEN_WA = ["", "", "Bhai order likho", "Namaste ji, aaj ka order", "Sir pls send", "order:", "Bhaiya ye bhej do", "kal subah tak bhejna", "Hi", "Jai shree krishna, order 👇"];
const CLOSE_WA = ["", "", "jaldi bhejna", "payment monday ko", "Thanks", "bill pichle wale ke saath jod dena", "🙏", "aur kal wala bill bhi bhej dena"];

const orders: GoldOrder[] = [];
function genOrder(i: number) {
  const channel = chance(0.15) ? "email" : "whatsapp";
  const retailer = pick(RETAILERS);
  const k = 1 + Math.floor(rnd() * 6);
  const lines: GoldLine[] = []; const texts: string[] = []; const tags = new Set<string>();
  const used = new Set<string>();
  for (let j = 0; j < k; j++) {
    if (chance(0.08)) {
      const it = pick(OOC); const qt = qtyText(skus[0]);
      const raw = qt.fmt(it); texts.push(raw); tags.add("out_of_catalog");
      lines.push({ raw, sku_id: null, qty: qt.q, unit: qt.unit, out_of_catalog: true }); continue;
    }
    let s = pick(skus); while (used.has(s.fam.product)) s = pick(skus); used.add(s.fam.product);
    const m = mention(s); const qt = qtyText(s);
    const raw = qt.fmt(m.text); texts.push(raw);
    [...m.tags, ...qt.tags].forEach(t => tags.add(t));
    lines.push({ raw, ...m.gold, qty: qt.q, unit: qt.unit });
  }
  if (texts.some(t => /[a-z]{3,}/.test(t)) && channel === "whatsapp" && chance(0.5)) tags.add("hinglish");
  let body: string;
  if (channel === "email") {
    body = `Subject: Order - ${retailer}\n\nDear Sir,\nPlease supply the following items:\n${texts.map((t, x) => `${x + 1}. ${t}`).join("\n")}\n\nRegards,\n${retailer}`;
  } else {
    const sep = chance(0.2) && texts.length > 1 ? ", " : "\n";
    const numbered = chance(0.25) && sep === "\n";
    const items = numbered ? texts.map((t, x) => `${x + 1}) ${t}`).join("\n") : texts.join(sep);
    if (sep === ", ") tags.add("single_line");
    const open = pick(OPEN_WA), close = pick(CLOSE_WA);
    if (open || close) tags.add("hinglish");
    body = [open, items, close].filter(Boolean).join("\n");
  }
  orders.push({ order_id: `ORD${String(i).padStart(4, "0")}`, data_label: "SYNTHETIC", channel, retailer, text: body, tags: [...tags], lines });
}
for (let i = 1; i <= 135; i++) genOrder(i);

// Hand-written edge cases (gold set explicitly).
const H = (text: string, tags: string[], lines: GoldLine[]) =>
  orders.push({ order_id: `ORD${String(orders.length + 1).padStart(4, "0")}`, data_label: "SYNTHETIC", channel: "whatsapp", retailer: pick(RETAILERS), text, tags: ["handwritten", ...tags], lines });
const g = (raw: string, sku: string | null, qty: number | null, unit: OrderUnit, extra: Partial<GoldLine> = {}): GoldLine => ({ raw, sku_id: sku, qty, unit, ...extra });
const maggi = famSkus(F.find(f => f.product === "Maggi 2-Minute Noodles")!).map(s => s.id);
H("bhai 2 peti maggi 70 wala aur ek peti yippee 12 wala", ["hinglish", "no_separator"], [
  g("2 peti maggi 70 wala", null, 2, "case", { ambiguous: true, acceptable_sku_ids: maggi }),
  g("ek peti yippee 12 wala", find("YiPPee! Noodles", 60).id, 1, "case")]);
H("Parle G 5rs - 3 peti\nParle G 10rs - 2 peti\nmonaco jeera 10 wala 5 dzn", ["hinglish", "price_as_size"], [
  g("Parle G 5rs - 3 peti", find("Parle-G Biscuit", 55).id, 3, "case"),
  g("Parle G 10rs - 2 peti", find("Parle-G Biscuit", 110).id, 2, "case"),
  g("monaco jeera 10 wala 5 dzn", find("Monaco", 63, "Jeera").id, 5, "dozen")]);
H("blue lays 10 wala 2 box, green lays 20 wala 1 box, kurkure 10rs 1 box", ["hinglish", "single_line", "color_alias"], [
  g("blue lays 10 wala 2 box", find("Potato Chips", 26, "Magic Masala").id, 2, "case"),
  g("green lays 20 wala 1 box", find("Potato Chips", 52, "Cream & Onion").id, 1, "case"),
  g("kurkure 10rs 1 box", find("Masala Munch", 30).id, 1, "case")]);
H("clinic plus 1rs 10 ladi\nH&S 2rs cool menthol 5 ladi\nchik 4 ladi", ["hinglish", "sachet"], [
  g("clinic plus 1rs 10 ladi", find("Strength & Shine Shampoo", 5.5).id, 10, "strip"),
  g("H&S 2rs cool menthol 5 ladi", find("Anti-Dandruff Shampoo", 6.5, "Cool Menthol").id, 5, "strip"),
  g("chik 4 ladi", find("Shampoo", 6, "Black").id, 4, "strip")]);
H("surf excel 1kg 2 peti\nsurf excel quick wash 1 peti\nrin bar 1 peti", ["hinglish", "near_miss"], [
  g("surf excel 1kg 2 peti", find("Easy Wash Detergent Powder", 1).id, 2, "case"),
  g("surf excel quick wash 1 peti", null, 1, "case", { out_of_catalog: true }),
  g("rin bar 1 peti", null, 1, "case", { ambiguous: true, acceptable_sku_ids: famSkus(F.find(f => f.brand === "Rin" && f.product === "Detergent Bar")!).map(s => s.id) })]);
H("Ashirwad atta 10 kilo - 5 bags\ntata namak 2 bori\nfortune soyabean 1 ltr 1 peti", ["hinglish", "typo", "unknown_unit"], [
  g("Ashirwad atta 10 kilo - 5 bags", find("Shudh Chakki Atta", 10).id, 5, "pc"),
  g("tata namak 2 bori", find("Salt", 1, "Iodised").id, 2, "case"),
  g("fortune soyabean 1 ltr 1 peti", find("Soya Health Refined Soyabean Oil", 1).id, 1, "case")]);
H("same as last week + red label 250g 1 peti extra", ["hinglish", "repeat_order"], [
  g("red label 250g 1 peti extra", find("Red Label Tea", 250).id, 1, "case")]);
H("dairy milk 10rs 2 dabbe, 5 star 5rs 3 dabbe, kitkat 10 wala ek dabba", ["hinglish", "single_line"], [
  g("dairy milk 10rs 2 dabbe", find("Dairy Milk", 13.2).id, 2, "case"),
  g("5 star 5rs 3 dabbe", find("5 Star", 11).id, 3, "case"),
  g("kitkat 10 wala ek dabba", find("KitKat", 13.5).id, 1, "case")]);
H("coke 750 - 2 crate\nthums up 2.25 ltr 1 crate\nfruti 10rs 2 peti", ["hinglish", "typo", "unknown_unit"], [
  g("coke 750 - 2 crate", find("Coca-Cola Soft Drink", 750).id, 2, "case"),
  g("thums up 2.25 ltr 1 crate", find("Thums Up Soft Drink", 2.25).id, 1, "case"),
  g("fruti 10rs 2 peti", find("Frooti Mango Drink", 125).id, 2, "case")]);
H("colgate 10 wala 2 dzn\ncolgate 100g 1 dzn\npepsodent 100 gm 1 dzn", ["hinglish", "number_collision"], [
  g("colgate 10 wala 2 dzn", find("Strong Teeth Toothpaste", 20).id, 2, "dozen"),
  g("colgate 100g 1 dzn", find("Strong Teeth Toothpaste", 100).id, 1, "dozen"),
  g("pepsodent 100 gm 1 dzn", find("Germicheck Toothpaste", 100).id, 1, "dozen")]);
H("good night refill 2 dzn\nall out 1 dzn\nhit red 200ml 6 pcs", ["hinglish", "typo"], [
  g("good night refill 2 dzn", find("Gold Flash Refill", 45).id, 2, "dozen"),
  g("all out 1 dzn", find("Ultra Refill", 45).id, 1, "dozen"),
  g("hit red 200ml 6 pcs", find("Cockroach Spray", 200).id, 6, "pc")]);
H("aadha peti marie gold 120g\nbourbon 10rs 1 peti", ["hinglish", "fractional_qty"], [
  g("aadha peti marie gold 120g", find("Marie Gold", 120).id, 0.5, "case"),
  g("bourbon 10rs 1 peti", find("Bourbon", 60).id, 1, "case")]);
H("pampers M 30 wala 2 pkt\nwhisper XL 20 pcs 3 pkt\nstayfree 7 pad 1 dzn", ["hinglish", "count_in_pack"], [
  g("pampers M 30 wala 2 pkt", find("Pants Diapers", 30, "M").id, 2, "pc"),
  g("whisper XL 20 pcs 3 pkt", find("Choice Sanitary Pads", 20, "XL").id, 3, "pc"),
  g("stayfree 7 pad 1 dzn", find("Secure Sanitary Pads", 7).id, 1, "dozen")]);
H("Bhai kal wala order cancel karo, aaj sirf ye: maggi masala 70g 3 peti", ["hinglish", "instruction_noise"], [
  g("maggi masala 70g 3 peti", find("Maggi 2-Minute Noodles", 70).id, 3, "case")]);
H("amul butter 100g 2 peti\namul ghee 1L 6 pc\nnestle everyday 400g 1 dzn", ["english_mixed"], [
  g("amul butter 100g 2 peti", find("Pasteurised Butter", 100).id, 2, "case"),
  g("amul ghee 1L 6 pc", find("Pure Ghee", 1).id, 6, "pc"),
  g("nestle everyday 400g 1 dzn", find("Everyday Dairy Whitener", 400).id, 1, "dozen")]);

const out = orders.map(o => JSON.stringify(o)).join("\n") + "\n";
writeFileSync(new URL("../data/orders.jsonl", import.meta.url), out);
const L = orders.flatMap(o => o.lines);
console.log(`wrote ${orders.length} orders, ${L.length} lines: ${L.filter(l => l.sku_id).length} resolvable, ${L.filter(l => l.ambiguous).length} ambiguous, ${L.filter(l => l.out_of_catalog).length} out-of-catalog`);
