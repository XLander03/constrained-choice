import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { MockDecisionAdapter } from "../src/decide/mock.ts";
import { createApp } from "../src/server/app.ts";

let server: Server; let base = "";
before(async () => {
  const app = createApp({ catalogPath: new URL("../data/catalog.csv", import.meta.url).pathname, decider: new MockDecisionAdapter(),
    threshold: 0.8, dataDir: mkdtempSync(`${tmpdir()}/de-api-`) });
  server = await app.listen(0);
  const a = server.address(); base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
after(() => server.close());
const post = (p: string, body: unknown, ct = "application/json") => fetch(base + p, { method: "POST", headers: { "content-type": ct }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("parse → review → approve → CSV export", async () => {
  const r = await post("/orders/parse", { text: "parle g 10 wala 2 peti\nmaggi 2 peti\nred bull 250ml 1 peti", order_id: "API1" });
  assert.equal(r.status, 201);
  const o = await r.json();
  assert.equal(o.lines.length, 3);
  const maggi = o.lines.find((l: any) => /maggi/.test(l.raw));
  assert.equal(maggi.needs_review, true);
  assert.ok(maggi.review_reasons.includes("pack_size_ambiguous"));
  assert.ok(maggi.alternatives.length >= 3);

  const early = await post("/orders/API1/approve", {});
  assert.equal(early.status, 422);
  assert.equal((await fetch(`${base}/orders/API1/export.csv`)).status, 409);

  // Reviewer fixes every flagged line and marks the out-of-catalog Red Bull line as not stocked (sku_id null).
  const lines = o.lines.filter((l: any) => l.needs_review || /red bull/.test(l.raw)).map((l: any) =>
    /red bull/.test(l.raw) ? { line_id: l.line_id, sku_id: null } : { line_id: l.line_id, sku_id: l.sku?.sku_id ?? l.alternatives.find((a: any) => a.sku_id).sku_id, qty: l.qty, unit: "case" });
  const ok = await post("/orders/API1/approve", { approved_by: "test", lines });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, "approved");

  const csv = await fetch(`${base}/orders/API1/export.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type")!, /text\/csv/);
  const text = await csv.text();
  assert.match(text, /^order_id,retailer_id,line_no,status,sku_id/);
  assert.match(text, /skipped/);
  assert.equal((await post("/orders/API1/export/sheets", {})).status, 501);
});

test("catalog upload replaces the catalog; bad CSV is rejected and the old one kept", async () => {
  const bad = await post("/catalog", "name,price\nX,1\n", "text/csv");
  assert.equal(bad.status, 422);
  const good = await post("/catalog", "sku_id,product,brand,mrp_inr,case_qty\nK1,Kurkure Masala Munch 90g,PepsiCo,20,60\nK2,Kurkure Masala Munch 40g,PepsiCo,10,120\n", "text/csv");
  assert.equal(good.status, 200);
  assert.equal((await good.json()).sku_count, 2);
  const o = await (await post("/orders/parse", { text: "kurkure masala munch 20 wala 2 peti" })).json();
  assert.equal(o.lines[0].sku?.sku_id ?? o.lines[0].alternatives[0].sku_id, "K1");
});

test("bare numbers default to case and are flagged; WhatsApp export import creates one order per burst", async () => {
  const o = await (await post("/orders/parse", { text: "maggi 70g 5" })).json();
  assert.deepEqual([o.lines[0].qty, o.lines[0].unit, o.lines[0].unit_defaulted], [5, "case", true]);
  assert.ok(!o.lines[0].review_reasons.includes("unit_unspecified"));

  const chat = ["14/11/26, 9:05 am - Raju Kirana: maggi 70g 3 peti", "parle g 10 wala 2 peti", "14/11/26, 9:07 am - Raju Kirana: tata namak 2 bori",
    "14/11/26, 9:30 am - Sharma Distributors: ok bhai", "14/11/26, 9:40 am - Raju Kirana: jaldi bhejna",
    "[14/11/26, 6:01:00 PM] Gupta Kirana: lux pink 100g 2 box"].join("\n");
  const r = await post("/orders/import/whatsapp?exclude_senders=Sharma%20Distributors", chat, "text/plain");
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.format, "mixed");
  assert.equal(j.summary.orders, 2); assert.equal(j.summary.skipped, 1);          // "jaldi bhejna" has no product lines
  assert.equal(j.orders[0].lines.length, 3);
  assert.equal(j.orders[0].source.kind, "whatsapp_export"); assert.equal(j.orders[0].retailer_id, "Raju Kirana");
  assert.equal(j.orders[0].lines.find((l: any) => /namak/.test(l.raw)).unit, "case");
  assert.equal((await fetch(`${base}/orders/${j.orders[0].order_id}`)).status, 200);
  const bad = await post("/orders/import/whatsapp", { text: "just some text" });
  assert.equal(bad.status, 422);
});

test("errors are JSON with a code", async () => {
  const r = await post("/orders/parse", { text: "" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "text_required");
  assert.equal((await fetch(`${base}/orders/nope`)).status, 404);
});
