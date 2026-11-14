// Paid check of the LLM fallback on lines the rules extractor cannot parse (data/fallback-lines.jsonl, SYNTHETIC).
// Usage: node scripts/check-fallback.ts [--cap 15000]   (needs OPENAI_API_KEY; writes reports/fallback-check.json)
import { readFileSync, writeFileSync } from "node:fs";
import { loadCatalog } from "../src/catalog/load.ts";
import { loadConfig } from "../src/config.ts";
import { RulesExtractor } from "../src/extract/extractor.ts";
import { FallbackExtractor, OpenAILlmLineParser } from "../src/extract/llmFallback.ts";

const root = new URL("../", import.meta.url);
const capArg = process.argv.indexOf("--cap"); const conf = loadConfig();
const cap = capArg > 0 ? Number(process.argv[capArg + 1]) : conf.llmFallback.tokenCap;
const key = process.env.OPENAI_API_KEY; if (!key) throw new Error("OPENAI_API_KEY not set (paid check)");
const gold = readFileSync(new URL("data/fallback-lines.jsonl", root), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const rules = new RulesExtractor(loadCatalog(new URL("data/catalog.csv", root).pathname));
const parser = new OpenAILlmLineParser({ apiKey: key, ...conf.llmFallback, tokenCap: cap });
const fb = new FallbackExtractor(rules, parser);
const rows: unknown[] = []; let ok = 0, rulesNull = 0, inTok = 0, outTok = 0, usd = 0, reqs = 0; const t0 = Date.now();
for (const id of [...new Set(gold.map(g => g.order))]) {
  const G = gold.filter(g => g.order === id); const order = { orderId: id, channel: "whatsapp" as const, text: G.map(g => g.raw).join("\n") };
  const before = await rules.extract(order); rulesNull += before.filter(l => l.qty === null).length;
  const { lines, usage } = await fb.extractDetailed(order);
  inTok += usage.inputTokens; outTok += usage.outputTokens; usd += usage.costUsd; reqs += usage.requests;
  G.forEach((g, i) => {
    const l = lines[i]; const good = !!l && l.qty === g.qty && (g.qty === null || l.unit === g.unit); if (good) ok++;
    rows.push({ raw: g.raw, gold: { qty: g.qty, unit: g.unit }, got: l ? { qty: l.qty, unit: l.unit, item: l.itemText, by: l.extractor } : null, ok: good });
  });
}
const report = { data_label: "SYNTHETIC", model: conf.llmFallback.model, lines: gold.length, rules_could_not_parse: rulesNull,
  correct_qty_unit: ok, accuracy_pct: +(100 * ok / gold.length).toFixed(1), requests: reqs, input_tokens: inTok, output_tokens: outTok,
  usd: +usd.toFixed(6), inr_at_88: +(usd * 88).toFixed(3), price_basis: `${conf.llmFallback.model}: $${conf.llmFallback.inputPerMTokUsd}/1M in, $${conf.llmFallback.outputPerMTokUsd}/1M out (check current pricing)`,
  runtime_ms: Date.now() - t0, rows };
writeFileSync(new URL("reports/fallback-check.json", root), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
for (const r of rows as any[]) if (!r.ok) console.log("MISS", JSON.stringify(r));
