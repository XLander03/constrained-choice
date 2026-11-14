// Run one order end-to-end with the mock adapter and push review lines into a JSONL queue.
// Usage: node scripts/demo.ts "bhai 2 peti maggi 70 wala aur ek peti yippee 12 wala"
import { rmSync } from "node:fs";
import { loadCatalog, skuLabel } from "../src/catalog/load.ts";
import { MockDecisionAdapter } from "../src/decide/mock.ts";
import { RulesExtractor } from "../src/extract/extractor.ts";
import { processOrder } from "../src/pipeline.ts";
import { HybridRetriever } from "../src/retrieve/retriever.ts";
import { IdentityCalibrator } from "../src/route/calibrate.ts";
import { JsonlReviewQueue } from "../src/route/reviewQueue.ts";

const catalog = loadCatalog(new URL("../data/catalog.csv", import.meta.url).pathname);
const byId = new Map(catalog.map(s => [s.skuId, s]));
const text = process.argv[2] ?? "Bhai order likho\nparle g 10 wala 2 peti\nblue lays 20rs 1 box\nclinic plus 1rs 10 ladi\nred bull 250ml 1 peti";
const res = await processOrder({ orderId: "DEMO1", channel: "manual", text }, {
  extractor: new RulesExtractor(catalog), retriever: new HybridRetriever(catalog), decider: new MockDecisionAdapter(),
  calibrator: new IdentityCalibrator(), policy: { threshold: 0.85, allowUnspecifiedUnit: false }, topK: 20 });
const qpath = "/tmp/decision-engine-review-demo.jsonl"; rmSync(qpath, { force: true });
const q = new JsonlReviewQueue(qpath);
for (const l of res.lines) {
  const sku = byId.get(l.decision.choice);
  console.log(`${l.route.padEnd(6)} ${l.line.qty ?? "?"} ${l.line.unit.padEnd(11)} ${(sku ? skuLabel(sku) : "NONE").padEnd(48)} conf=${l.calibratedConfidence.toFixed(2)}  ${l.reason}   <- "${l.line.raw}"`);
  if (l.route === "review") q.enqueue(l);
}
console.log(`review queue (${qpath}):`, q.list("open").map(i => ({ id: i.id, reason: i.reason, top: i.suggested.slice(0, 3) })));
console.log(`est. cost: $${res.usage.costUsd.toFixed(6)} (${res.usage.inputTokens} input tokens, 1 request)`);
