import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { GoogleSheetsExporter, NotConfiguredError, type ApprovedOrder } from "../src/export/exporter.ts";
import { loadConfig } from "../src/config.ts";

const order: ApprovedOrder = { orderId: "O1", retailerId: "raju", approvedBy: "ramesh", approvedAt: "2026-11-14T10:00:00Z",
  lines: [{ lineNo: 1, lineId: "O1#0", raw: "maggi 70g 3 peti", skuId: "SKU0034", label: "Maggi 70g", qty: 3, unit: "case", unitsTotal: 288, mrpInr: 14, source: "auto" }] };

test("Sheets exporter is inert without sheet id or credentials", async () => {
  const none = new GoogleSheetsExporter({ spreadsheetId: "", credentialsPath: undefined });
  assert.equal(none.configured, false);
  await assert.rejects(() => none.export(order), NotConfiguredError);
  const noCreds = new GoogleSheetsExporter({ spreadsheetId: "abc", credentialsPath: "/nonexistent/sa.json" });
  assert.match(noCreds.status()!, /not found/);
});

test("Sheets exporter signs a service-account JWT and appends RAW rows (mocked Google APIs)", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(`${tmpdir()}/sa-`); const path = `${dir}/sa.json`;
  writeFileSync(path, JSON.stringify({ type: "service_account", client_email: "bot@test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: "https://oauth2.googleapis.com/token" }));
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("oauth2")) return Response.json({ access_token: "tok", expires_in: 3600 });
    if (init.method === "POST") return Response.json({ updates: { updatedRange: "Orders!A1:N2" } });
    return Response.json({});                                   // empty sheet → header row is written
  }) as typeof fetch;
  const ex = new GoogleSheetsExporter({ spreadsheetId: "sheet123", sheetName: "Orders", credentialsPath: path, fetchFn });
  assert.equal(ex.configured, true);
  const r = await ex.export(order);
  assert.equal(r.rows, 2);
  const jwt = new URLSearchParams(String(calls[0].init.body)).get("assertion")!;
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  assert.equal(claims.scope, "https://www.googleapis.com/auth/spreadsheets");
  const append = calls.find(c => c.init.method === "POST" && c.url.includes("sheets.googleapis.com"))!;
  assert.match(append.url, /valueInputOption=RAW/);
  assert.equal(JSON.parse(String(append.init.body)).values[1][4], "SKU0034");
});

test("config: bare numbers default to case; env overrides; invalid unit rejected", () => {
  assert.equal(loadConfig(undefined, {}).units.defaultUnitForBareNumber, "case");
  assert.equal(loadConfig(undefined, { DEFAULT_UNIT: "pc" }).units.defaultUnitForBareNumber, "pc");
  assert.equal(loadConfig(undefined, { DEFAULT_UNIT: "none" }).units.defaultUnitForBareNumber, null);
  assert.throws(() => loadConfig(undefined, { DEFAULT_UNIT: "bori" }));
});
