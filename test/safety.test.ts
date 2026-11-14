import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetExceededError, BudgetedAdapter } from "../src/decide/budget.ts";
import type { DecisionAdapter } from "../src/decide/adapter.ts";
import { redactSecrets } from "../src/decide/openai.ts";
import { catalogFromCsv } from "../src/catalog/load.ts";
import { csvCell, unitsTotal } from "../src/export/exporter.ts";
import { cands, line, sku } from "./helpers.ts";

test("provider error text never leaks key material", () => {
  const fake = ["sk", "proj", "FAKEFAKE0000notakey"].join("-");   // built at runtime so secret scanners don't flag the repo
  const out = redactSecrets(`Incorrect API key provided: ${fake}. Bearer ${fake}`);
  assert.doesNotMatch(out, /FAKEFAKE/);
});

test("budget guard refuses a request that would pass the cap, before calling the provider", async () => {
  let calls = 0;
  const inner: DecisionAdapter = { name: "fake", async decideOrder() { calls++; return { decisions: [], usage: { inputTokens: 900, cachedTokens: 0, requests: 1, costUsd: 0 } }; } };
  const req = { order: { orderId: "T", channel: "manual" as const, text: "maggi 70g 2 peti" }, lines: [{ line: line({ raw: "maggi 70g 2 peti" }), candidates: cands(sku("SKU0034"), sku("SKU0033")) }] };
  const b = new BudgetedAdapter(inner, 1500);
  await b.decideOrder(req);
  await assert.rejects(() => b.decideOrder(req), BudgetExceededError);
  assert.equal(calls, 1);
});

test("catalog upload maps common column names and rejects duplicates", () => {
  const ok = catalogFromCsv("Item Code,Item Name,MRP,Units per case\nA1,Maggi Masala 70g,14,96\nA2,Parle-G 110g,10,96\n");
  assert.deepEqual(ok.errors, []);
  assert.deepEqual([ok.skus[0].skuId, ok.skus[0].packSize, ok.skus[0].packUnit, ok.skus[0].caseQty], ["A1", 70, "g", 96]);
  const bad = catalogFromCsv("sku,name\nA1,X\nA1,Y\n");
  assert.match(bad.errors.join(), /duplicate/);
  assert.match(catalogFromCsv("foo,bar\n1,2\n").errors.join(), /no SKU id column/);
});

test("CSV export escapes quotes and neutralises spreadsheet formulas; unit conversion", () => {
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell(-3), "-3");
  assert.equal(unitsTotal(2, "case", 96, null), 192);
  assert.equal(unitsTotal(3, "dozen", 96, null), 36);
  assert.equal(unitsTotal(1, "unspecified", 96, null), null);
});
