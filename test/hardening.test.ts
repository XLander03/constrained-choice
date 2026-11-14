// Milestone 5: fixes for the Eval Demo QA report (H1, H2, M1–M4, backend Lows). SYNTHETIC data, mock adapter, no network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest, Agent, type Server } from "node:http";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { catalogFromCsv } from "../src/catalog/load.ts";
import type { DecisionAdapter } from "../src/decide/adapter.ts";
import { MockDecisionAdapter } from "../src/decide/mock.ts";
import { parseWhatsAppExport } from "../src/intake/whatsapp.ts";
import { IdentityCalibrator } from "../src/route/calibrate.ts";
import { OverlapScorer } from "../src/route/overlap.ts";
import { routeLine } from "../src/route/router.ts";
import { createApp } from "../src/server/app.ts";
import { catalog, cands, decision, line, sku } from "./helpers.ts";

const catalogPath = new URL("../data/catalog.csv", import.meta.url).pathname;
const tmp = () => mkdtempSync(`${tmpdir()}/de-m5-`);
const TOKEN = ["test", "token", "not", "a", "secret", "0123456789"].join("-");
async function start(cfg: Partial<Parameters<typeof createApp>[0]> = {}) {
  const app = createApp({ catalogPath, decider: new MockDecisionAdapter(), threshold: 0.8, dataDir: tmp(), ...cfg });
  const s = await app.listen(0); const a = s.address();
  return { s, base: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}` };
}
let plain: { s: Server; base: string }, locked: { s: Server; base: string };
before(async () => { plain = await start(); locked = await start({ apiToken: TOKEN }); });
after(() => { plain.s.close(); locked.s.close(); });
const post = (base: string, p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

// ---- H1: origins, host, token ----
test("H1: a page on another origin can't read orders or replace the catalog; the UI origin can", async () => {
  const before = await (await fetch(`${plain.base}/health`)).json();
  const evil = { origin: "http://127.0.0.1:5199" };
  const up = await fetch(`${plain.base}/catalog`, { method: "POST", headers: { ...evil, "content-type": "text/plain" }, body: "sku_id,product\nX1,Evil 1g\n" });
  assert.equal(up.status, 403); assert.equal((await up.json()).error.code, "origin_not_allowed");
  // v0.5.1: the refusal is readable by the page (origin echoed, no credentials), but nothing was processed (catalog check below)
  assert.equal(up.headers.get("access-control-allow-origin"), "http://127.0.0.1:5199");
  assert.match(up.headers.get("vary") ?? "", /Origin/);
  assert.equal(up.headers.get("access-control-allow-credentials"), null);
  assert.equal(up.headers.get("access-control-allow-methods"), null);
  assert.equal((await fetch(`${plain.base}/orders`, { headers: evil })).status, 403);
  assert.equal((await post(plain.base, "/orders/import/whatsapp", "14/11/26, 9:05 am - X: maggi 2 peti", { ...evil, "content-type": "text/plain" })).status, 403);
  const pre = await fetch(`${plain.base}/catalog`, { method: "OPTIONS", headers: { ...evil, "access-control-request-method": "POST" } });
  assert.equal(pre.status, 403);
  const after = await (await fetch(`${plain.base}/health`)).json();
  assert.equal(after.catalog.version, before.catalog.version);

  const ui = { origin: "http://localhost:5173" };
  const ok = await fetch(`${plain.base}/orders`, { headers: ui });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:5173");
  const pre2 = await fetch(`${plain.base}/orders/parse`, { method: "OPTIONS", headers: { origin: "http://localhost:5174", "access-control-request-method": "POST" } });
  assert.equal(pre2.status, 204); assert.match(pre2.headers.get("access-control-allow-headers") ?? "", /Authorization/);
});

test("H1: without a token, requests addressed to a non-loopback Host are refused (DNS rebinding)", async () => {
  const port = new URL(plain.base).port;
  const status = await new Promise<number>((ok, bad) => httpRequest({ host: "127.0.0.1", port, path: "/orders", headers: { host: `evil.example:${port}` } }, r => { r.resume(); ok(r.statusCode!); }).on("error", bad).end());
  assert.equal(status, 403);
});

test("H1: API_TOKEN is required on every request when set (Bearer or X-API-Key); preflight needs none", async () => {
  assert.equal((await fetch(`${locked.base}/orders`)).status, 401);
  assert.equal((await fetch(`${locked.base}/orders`, { headers: { authorization: "Bearer wrong-token-wrong-token" } })).status, 401);
  assert.equal((await fetch(`${locked.base}/orders`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await fetch(`${locked.base}/orders`, { headers: { "x-api-key": TOKEN } })).status, 200);
  const pre = await fetch(`${locked.base}/orders/parse`, { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
  assert.equal(pre.status, 204);
  assert.equal((await post(locked.base, "/catalog", { csv: "sku_id,product\nX1,Evil 1g\n" })).status, 401);
});

// ---- H2: out-of-catalog never auto-accepts ----
test("H2: 'red bull 250ml 1 peti' is never auto-accepted (mock answers none; overlap guard as backstop), 10 runs", async () => {
  for (let i = 0; i < 10; i++) {
    const o = await (await post(plain.base, "/orders/parse", { text: "red bull 250ml 1 peti" })).json();
    assert.equal(o.lines.length, 1);
    assert.equal(o.lines[0].needs_review, true, `run ${i}: ${JSON.stringify(o.lines[0].review_reasons)}`);
    assert.equal(o.lines[0].none_of_these, true);
  }
});

test("H2: overlap guard sends a confident wrong pick to review whatever the provider, and leaves real matches alone", () => {
  const scorer = new OverlapScorer(catalog); const policy = { threshold: 0.5, allowUnspecifiedUnit: false, overlap: { scorer, floor: 0.55 } };
  const rl = cands(sku("SKU0052"), sku("SKU0051"));
  const bad = routeLine(line({ raw: "red bull 250ml 1 peti", itemText: "red bull 250ml", sizeHint: { value: 250, unit: "ml" } }), rl, decision("SKU0052", 0.99), new IdentityCalibrator(), policy);
  assert.equal(bad.route, "review"); assert.match(bad.reason, /low_overlap/); assert.ok(bad.lexicalOverlap! < 0.55);
  const good = routeLine(line({ raw: "red label 250g 1 peti", itemText: "red label 250g", sizeHint: { value: 250, unit: "g" } }), rl, decision("SKU0052", 0.99), new IdentityCalibrator(), policy);
  assert.equal(good.route, "auto", good.reason);
  // typos and shorthand still count as overlap
  assert.ok(scorer.score("red lebal", sku("SKU0052"))! >= 0.55);
  assert.ok(scorer.score("parle g", sku("SKU0002"))! >= 0.55);
});

// ---- M1: line limit ----
test("M1: more than 400 lines → 422 too_many_lines (not a retryable 502), nothing stored", async () => {
  const n0 = (await (await fetch(`${plain.base}/orders`)).json()).orders.length;
  const r = await post(plain.base, "/orders/parse", { text: Array(401).fill("maggi 70g 2 peti").join("\n") });
  assert.equal(r.status, 422);
  const e = (await r.json()).error; assert.equal(e.code, "too_many_lines"); assert.equal(e.details.max_lines, 400);
  assert.equal((await (await fetch(`${plain.base}/orders`)).json()).orders.length, n0);
  assert.equal((await (await fetch(`${plain.base}/health`)).json()).limits.max_lines_per_order, 400);
});

// ---- M2: atomic WhatsApp import ----
test("M2: a WhatsApp import that fails part-way stores nothing; an over-long group is skipped, not fatal", async () => {
  let calls = 0; const mock = new MockDecisionAdapter();
  const flaky: DecisionAdapter = { name: "flaky", decideOrder: req => { if (++calls === 2) throw new Error("provider timeout"); return mock.decideOrder(req); } };
  const f = await start({ decider: flaky });
  try {
    const chat = ["14/11/26, 9:05 am - Shop A: maggi 70g 2 peti", "14/11/26, 9:06 am - Shop B: parle g 10 wala 3 peti"].join("\n");
    const r = await post(f.base, "/orders/import/whatsapp", chat, { "content-type": "text/plain" });
    assert.equal(r.status, 502); const e = (await r.json()).error;
    assert.equal(e.details.orders_saved, 0); assert.match(e.message, /safe to retry/);
    assert.equal((await (await fetch(`${f.base}/orders`)).json()).orders.length, 0);
  } finally { f.s.close(); }
  const big = ["14/11/26, 9:05 am - Shop A: maggi 70g 2 peti", "14/11/26, 9:40 am - Shop B: " + Array(402).fill("parle g 10 wala 1 peti").join("\n")].join("\n");
  const r2 = await post(plain.base, "/orders/import/whatsapp", big, { "content-type": "text/plain" });
  assert.equal(r2.status, 201); const j = await r2.json();
  assert.equal(j.summary.orders, 1); assert.equal(j.skipped[0].reason, "too_many_lines");
});

// ---- M3: deleted messages ----
test("M3: iOS/Android deleted-message placeholders are dropped", () => {
  const ios = ["[14/11/26, 12:24:00 PM] Khan Brothers: maggi 2 peti", "[14/11/26, 12:25:00 PM] Khan Brothers: \u200eThis message was deleted.",
    "[14/11/26, 12:26:00 PM] Me: \u200eYou deleted this message.", "[14/11/26, 12:27:00 PM] Khan Brothers: This message was deleted"].join("\n");
  const p = parseWhatsAppExport(ios);
  assert.equal(p.messages.length, 1); assert.equal(p.skippedMedia, 3);
});

// ---- M4: keep-alive after 413 ----
test("M4: after a 413 the connection is closed cleanly and the next requests answer promptly", async () => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 }); const { port } = new URL(plain.base);
  const send = (method: string, path: string, body?: Buffer) => new Promise<{ status: number; ms: number }>((ok, bad) => {
    const t = Date.now();
    const rq = httpRequest({ host: "127.0.0.1", port, path, method, agent, headers: body ? { "content-type": "application/json", "content-length": body.length } : {} }, r => { r.resume(); r.on("end", () => ok({ status: r.statusCode!, ms: Date.now() - t })); });
    rq.on("error", bad); if (body) rq.write(body); rq.end();
  });
  const big = await send("POST", "/orders/parse", Buffer.alloc(6 * 1024 * 1024, 97)).catch(e => ({ status: -1, ms: 0, e }));
  assert.ok(big.status === 413 || big.status === -1, `got ${big.status}`);
  for (let i = 0; i < 3; i++) { const r = await send("GET", "/health"); assert.equal(r.status, 200); assert.ok(r.ms < 1500, `follow-up ${i} took ${r.ms} ms`); }
  agent.destroy();
});

// ---- Lows ----
test("Lows: JSON null import → 400; limit=0 → 1 item; bad order_id → 400; empty order can't be approved", async () => {
  assert.equal((await post(plain.base, "/orders/import/whatsapp", "null")).status, 400);
  assert.equal((await (await fetch(`${plain.base}/catalog?limit=0`)).json()).items.length, 1);
  const bad = await post(plain.base, "/orders/parse", { text: "maggi 2 peti", order_id: "bad id!" });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).error.code, "bad_order_id");
  const z = await (await post(plain.base, "/orders/parse", { text: "hello bhai kaise ho" })).json();
  assert.equal(z.lines.length, 0);
  const ap = await post(plain.base, `/orders/${z.order_id}/approve`, {});
  assert.equal(ap.status, 422); assert.equal((await ap.json()).error.code, "no_product_lines");
  const list = await (await fetch(`${plain.base}/orders?detail=1`)).json();
  assert.ok(Array.isArray(list.orders[0].lines));
});

test("L7: catalog rows with more fields than the header are rejected", () => {
  const r = catalogFromCsv('sku_id,product,brand,mrp_inr,case_qty\nK1,Snack 50g,X,10,50\nK4,=HYPERLINK("http://evil.example","Formula Snack 50g"),,10,50\n');
  assert.ok(r.errors.some(e => /row 3: 6 fields but the header has 5/.test(e)), JSON.stringify(r.errors));
  assert.equal(catalogFromCsv(readFileSync(catalogPath, "utf8")).warnings.filter(w => /fields/.test(w)).length, 0);
});

test("L8: approving an order whose SKU left the catalog returns a warning", async () => {
  const f = await start();
  try {
    const o = await (await post(f.base, "/orders/parse", { text: "parle g 10 wala 2 peti" })).json();
    const l = o.lines[0];
    assert.equal((await post(f.base, "/catalog", "sku_id,product,brand\nN1,New Thing 10g,Acme\n", { "content-type": "text/csv" })).status, 200);
    const g = await (await fetch(`${f.base}/orders/${o.order_id}`)).json(); assert.equal(g.catalog_stale, true);
    const ap = await post(f.base, `/orders/${o.order_id}/approve`, { lines: [{ line_id: l.line_id, sku_id: l.sku?.sku_id ?? "SKU0002", qty: 2, unit: "case" }] });
    assert.equal(ap.status, 200); const j = await ap.json();
    assert.equal(j.approved.warnings[0].code, "sku_not_in_current_catalog");
  } finally { f.s.close(); }
});

// ---- v0.5.1: public /health subset ----
test("v0.5.1: GET /health without a token returns only the public subset; with the token, everything; wrong token → 401", async () => {
  const pub = await fetch(`${locked.base}/health`);
  assert.equal(pub.status, 200);
  const j = await pub.json();
  assert.deepEqual(Object.keys(j).sort(), ["adapter", "auth_required", "limits", "ok", "status", "version"]);
  assert.equal(j.auth_required, true); assert.equal(j.status, "ok"); assert.equal(j.limits.max_lines_per_order, 400);
  assert.match(j.version, /^\d+\.\d+\.\d+/);
  const full = await (await fetch(`${locked.base}/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.ok(full.catalog && full.threshold !== undefined && full.auth_required === true);
  assert.equal((await fetch(`${locked.base}/health`, { headers: { authorization: "Bearer wrong-token-wrong-token" } })).status, 401);
  // only /health is public: everything else still needs the token
  assert.equal((await fetch(`${locked.base}/catalog`)).status, 401);
  // origin checks still apply to /health
  const evil = await fetch(`${locked.base}/health`, { headers: { origin: "http://127.0.0.1:5199" } });
  assert.equal(evil.status, 403); assert.equal((await evil.json()).error.code, "origin_not_allowed");
  // without a configured token (loopback-only) /health stays full
  const local = await (await fetch(`${plain.base}/health`)).json();
  assert.equal(local.auth_required, false); assert.ok(local.catalog);
});
