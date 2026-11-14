// Eval harness: accuracy, coverage at threshold, cost per order.
// Usage: node src/eval/run.ts [--adapter mock|openai] [--target 0.98] [--topk 20] [--out reports/eval-mock.json]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadCatalog } from "../catalog/load.ts";
import type { DecisionAdapter } from "../decide/adapter.ts";
import { MockDecisionAdapter } from "../decide/mock.ts";
import { OpenAIDecisionsAdapter } from "../decide/openai.ts";
import { RulesExtractor } from "../extract/extractor.ts";
import { processOrder } from "../pipeline.ts";
import { HybridRetriever, tokenize } from "../retrieve/retriever.ts";
import { IdentityCalibrator, IsotonicCalibrator, chooseThreshold, type Calibrator } from "../route/calibrate.ts";
import { routeLine } from "../route/router.ts";
import { NONE, type GoldLine, type GoldOrder, type ResolvedLine } from "../types.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const adapterName = arg("adapter", "mock"), target = Number(arg("target", "0.98")), topK = Number(arg("topk", "20"));
const limit = Number(arg("limit", "0"));
const out = arg("out", `reports/eval-${adapterName}${limit ? `-first${limit}` : ""}.json`);
const root = new URL("../../", import.meta.url);

const catalog = loadCatalog(new URL("data/catalog.csv", root).pathname);
const gold: GoldOrder[] = readFileSync(new URL("data/orders.jsonl", root), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).slice(0, limit || undefined);
let decider: DecisionAdapter;
if (adapterName === "openai") {
  const key = process.env.OPENAI_API_KEY; if (!key) throw new Error("OPENAI_API_KEY not set (paid API — run only when approved)");
  decider = new OpenAIDecisionsAdapter({ apiKey: key });
} else decider = new MockDecisionAdapter();

const deps = { extractor: new RulesExtractor(catalog), retriever: new HybridRetriever(catalog), decider,
  calibrator: new IdentityCalibrator(), policy: { threshold: 0, allowUnspecifiedUnit: false }, topK };

// ---- run pipeline once; routing is re-applied offline per threshold ----
type Row = { order: GoldOrder; split: "dev" | "test"; g: GoldLine; r: ResolvedLine | null };
const rows: Row[] = []; let spurious = 0; let tokens = 0, cost = 0, requests = 0; const t0 = Date.now();
const jacc = (a: string, b: string) => { const A = new Set(tokenize(a)), B = new Set(tokenize(b)); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1); };
for (const [idx, o] of gold.entries()) {
  const res = await processOrder({ orderId: o.order_id, channel: o.channel, retailerId: o.retailer, text: o.text }, deps);
  tokens += res.usage.inputTokens; cost += res.usage.costUsd; requests += res.usage.requests;
  const free = new Set(res.lines.map((_, i) => i));
  for (const g of o.lines) {
    let best = -1, bs = 0.45;
    for (const i of free) { const s = jacc(g.raw, res.lines[i].line.raw); if (s > bs) { bs = s; best = i; } }
    if (best >= 0) free.delete(best);
    rows.push({ order: o, split: idx % 2 === 0 ? "dev" : "test", g, r: best >= 0 ? res.lines[best] : null });
  }
  spurious += free.size;
}
const ms = Date.now() - t0;

// ---- helpers ----
const kind = (g: GoldLine) => (g.out_of_catalog ? "ooc" : g.ambiguous ? "ambiguous" : "resolvable");
const productOk = (x: Row) => !!x.r && (x.g.sku_id ? x.r.decision.choice === x.g.sku_id : x.r.decision.choice === NONE);
const qtyOk = (x: Row) => !!x.r && x.r.line.qty === x.g.qty && x.r.line.unit === x.g.unit;
const pct = (n: number, d: number) => (d ? +(100 * n / d).toFixed(1) : null);
const matched = rows.filter(x => x.r);
const res = rows.filter(x => x.g.sku_id && x.r);
const recallAt = (k: number) => pct(res.filter(x => x.r!.candidates.slice(0, k).some(c => c.sku.skuId === x.g.sku_id)).length, res.length);

// ---- calibration + threshold on dev, report on test ----
const sample = (x: Row) => ({ conf: x.r!.decision.confidence, correct: !!x.g.sku_id && x.r!.decision.choice === x.g.sku_id });
const devPicks = rows.filter(x => x.split === "dev" && x.r && x.r.decision.choice !== NONE);
const cal = new IsotonicCalibrator(); cal.fit(devPicks.map(sample));
const thr = chooseThreshold(devPicks.map(x => ({ conf: cal.apply(x.r!.decision.confidence), correct: sample(x).correct })), target);
function at(threshold: number, split: "dev" | "test", calibrator: Calibrator = cal) {
  const S = rows.filter(x => x.split === split);
  const routed = S.map(x => ({ x, rr: x.r ? routeLine(x.r.line, x.r.candidates, x.r.decision, calibrator, { threshold, allowUnspecifiedUnit: false }) : null }));
  const auto = routed.filter(z => z.rr?.route === "auto");
  const autoProd = auto.filter(z => productOk(z.x)).length;
  const byOrder = new Map<string, boolean[]>();
  for (const z of routed) { const a = byOrder.get(z.x.order.order_id) ?? []; a.push(z.rr?.route === "auto" && productOk(z.x) && qtyOk(z.x)); byOrder.set(z.x.order.order_id, a); }
  return {
    threshold: +threshold.toFixed(3), lines: S.length, coverage_pct: pct(auto.length, S.length),
    auto_product_precision_pct: pct(autoProd, auto.length),
    auto_fully_correct_pct: pct(auto.filter(z => productOk(z.x) && qtyOk(z.x)).length, auto.length),
    ambiguous_auto_leaks: auto.filter(z => kind(z.x.g) === "ambiguous").length,
    ooc_auto_leaks: auto.filter(z => kind(z.x.g) === "ooc").length,
    orders_fully_auto_and_correct_pct: pct([...byOrder.values()].filter(v => v.every(Boolean)).length, byOrder.size),
  };
}
const report = {
  data_label: "SYNTHETIC data; " + (adapterName === "mock" ? "MOCK decision adapter — accuracy numbers validate the harness only, not any model." : `adapter=${adapterName}`),
  adapter: decider.name, top_k: topK, orders: gold.length, gold_lines: rows.length,
  extraction: {
    line_recall_pct: pct(matched.length, rows.length), spurious_lines: spurious,
    qty_exact_pct: pct(matched.filter(x => x.r!.line.qty === x.g.qty).length, matched.length),
    unit_exact_pct: pct(matched.filter(x => x.r!.line.unit === x.g.unit).length, matched.length),
  },
  retrieval: { resolvable_lines: res.length, recall_at_1_pct: recallAt(1), recall_at_5_pct: recallAt(5), [`recall_at_${topK}_pct`]: recallAt(topK) },
  decision_top1: {
    resolvable_accuracy_pct: pct(res.filter(productOk).length, res.length),
    ooc_to_none_pct: pct(matched.filter(x => kind(x.g) === "ooc" && x.r!.decision.choice === NONE).length, matched.filter(x => kind(x.g) === "ooc").length),
    ambiguous_to_none_pct: pct(matched.filter(x => kind(x.g) === "ambiguous" && x.r!.decision.choice === NONE).length, matched.filter(x => kind(x.g) === "ambiguous").length),
    ambiguous_pick_in_acceptable_pct: pct(matched.filter(x => kind(x.g) === "ambiguous" && x.g.acceptable_sku_ids!.includes(x.r!.decision.choice)).length, matched.filter(x => kind(x.g) === "ambiguous").length),
  },
  threshold_fit: { split: "dev (even orders)", target_precision: target, calibrator: "isotonic", ...thr },
  at_threshold_test: at(thr.threshold, "test"),
  sweep_test_raw_confidence: [0.3, 0.5, 0.7, 0.8, 0.9, 0.95].map(t => at(t, "test", new IdentityCalibrator())),
  cost: { requests, input_tokens_total: tokens, tokens_per_order: Math.round(tokens / gold.length), usd_per_order: +(cost / gold.length).toFixed(7),
    usd_per_1000_orders: +(1000 * cost / gold.length).toFixed(4), inr_per_1000_orders_at_88: +(88 * 1000 * cost / gold.length).toFixed(2),
    basis: "OpenAI Decisions gpt-6-luna uncached input $0.10/1M tokens, output free" + (adapterName === "mock" ? "; tokens estimated as JSON chars/4 of the real request body" : "") },
  by_order_tag: Object.fromEntries(["handwritten", "hinglish", "typo", "abbreviation", "hindi_number", "unit_implicit", "single_line", "ambiguous", "out_of_catalog"].map(t => {
    const R = rows.filter(x => x.order.tags.includes(t)); const M = R.filter(x => x.r);
    return [t, { lines: R.length, extracted_pct: pct(M.length, R.length), qty_unit_ok_pct: pct(M.filter(qtyOk).length, M.length), product_top1_ok_pct: pct(M.filter(productOk).length, M.length) }];
  })),
  runtime_ms: ms,
  review_reasons: (rows.filter(x => x.r).map(x => routeLine(x.r!.line, x.r!.candidates, x.r!.decision, cal, { threshold: thr.threshold, allowUnspecifiedUnit: false }).reason)
    .flatMap(r => r.split(",")).reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})),
};
mkdirSync(new URL("reports/", root), { recursive: true });
writeFileSync(new URL(out, root), JSON.stringify(report, null, 2));
// failures sample for debugging
const fails = res.filter(x => !productOk(x)).slice(0, 15).map(x => ({ raw: x.g.raw, gold: x.g.sku_id, got: x.r!.decision.choice, conf: +x.r!.decision.confidence.toFixed(3), in_shortlist: x.r!.candidates.some(c => c.sku.skuId === x.g.sku_id) }));
writeFileSync(new URL(out.replace(/\.json$/, ".failures.json"), root), JSON.stringify(fails, null, 2));
console.log(JSON.stringify(report, null, 2));
