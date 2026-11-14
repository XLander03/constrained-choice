// Approved-order export: CSV, and Google Sheets (service account, inert until configured). No credentials in the repo.
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { OrderUnit } from "../types.ts";

export interface ApprovedLine {
  lineNo: number; lineId: string; raw: string;
  skuId: string | null;              // null = reviewer marked "not stocked / skip"; exported with status "skipped"
  label: string; qty: number; unit: OrderUnit;
  unitsTotal: number | null;         // qty converted to selling units via case_qty / 12 / strip_qty; null if unit unknown
  mrpInr: number | null;
  source: "auto" | "reviewed";
}
export interface ApprovedOrder { orderId: string; retailerId?: string; approvedBy: string; approvedAt: string; lines: ApprovedLine[] }

export interface OrderExporter { readonly name: string; export(order: ApprovedOrder): Promise<{ location: string }> }

export class NotConfiguredError extends Error {}

const CSV_COLUMNS = ["order_id", "retailer_id", "line_no", "status", "sku_id", "product", "qty", "unit", "units_total", "mrp_inr", "source", "raw_text", "approved_by", "approved_at"];
/** RFC 4180 quoting, plus a leading ' on cells that start with = + - @ so spreadsheet apps don't run them as formulas. */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function orderToCsv(o: ApprovedOrder): string {
  return [CSV_COLUMNS, ...orderRows(o)].map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export class SheetsConfigError extends NotConfiguredError {}
export class SheetsApiError extends Error {}

export const SHEET_COLUMNS = CSV_COLUMNS;
export function orderRows(o: ApprovedOrder): (string | number)[][] {
  return o.lines.map(l => [o.orderId, o.retailerId ?? "", l.lineNo, l.skuId ? "ok" : "skipped", l.skuId ?? "", l.label, l.qty, l.unit,
    l.unitsTotal ?? "", l.mrpInr ?? "", l.source, l.raw, o.approvedBy, o.approvedAt]);
}

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/**
 * Google Sheets exporter (Sheets API v4, values.append) authenticated as a service account.
 * - Credentials: path to the service-account JSON in the env var named by config (default GOOGLE_APPLICATION_CREDENTIALS).
 * - Sheet: config sheets.spreadsheetId (or env SHEETS_SPREADSHEET_ID), tab sheets.sheetName. Share the sheet with the
 *   service account's client_email as Editor.
 * Inert until both exist: export() throws NotConfiguredError (→ HTTP 501). Rows are written with valueInputOption=RAW,
 * so nothing is evaluated as a formula. The private key is only used to sign a JWT and is never logged.
 */
export class GoogleSheetsExporter implements OrderExporter {
  readonly name = "google-sheets";
  private spreadsheetId: string; private sheetName: string; private credPath: string | undefined; private credEnv: string;
  private fetchFn: typeof fetch; private token: { value: string; exp: number } | null = null;
  constructor(o: { spreadsheetId?: string; sheetName?: string; credentialsPath?: string; credentialsPathEnv?: string; fetchFn?: typeof fetch } = {}) {
    this.spreadsheetId = o.spreadsheetId ?? process.env.SHEETS_SPREADSHEET_ID ?? "";
    this.sheetName = o.sheetName ?? "Orders";
    this.credEnv = o.credentialsPathEnv ?? "GOOGLE_APPLICATION_CREDENTIALS";
    this.credPath = o.credentialsPath ?? process.env[this.credEnv];
    this.fetchFn = o.fetchFn ?? fetch;
  }
  /** Why export is unavailable, or null when it's ready to try. Never includes secret material. */
  status(): string | null {
    if (!this.spreadsheetId) return "no spreadsheet id (config sheets.spreadsheetId or env SHEETS_SPREADSHEET_ID)";
    if (!this.credPath) return `no service-account credentials (env ${this.credEnv} = path to the JSON key file)`;
    if (!existsSync(this.credPath)) return `credentials file not found at the path in ${this.credEnv}`;
    return null;
  }
  get configured() { return this.status() === null; }
  private loadSa(): ServiceAccount {
    let sa: ServiceAccount;
    try { sa = JSON.parse(readFileSync(this.credPath!, "utf8")); } catch { throw new SheetsConfigError(`credentials file in ${this.credEnv} is not valid JSON`); }
    if (!sa.client_email || !sa.private_key) throw new SheetsConfigError("credentials JSON lacks client_email/private_key (is it a service-account key?)");
    return sa;
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const sa = this.loadSa(); const now = Math.floor(Date.now() / 1000); const aud = sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({
      iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud, iat: now, exp: now + 3600 }))}`;
    let sig: string;
    try { sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url"); }
    catch { throw new SheetsConfigError("could not sign with the service-account private key"); }
    const r = await this.fetchFn(aud, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new SheetsApiError(`Google token endpoint ${r.status}`);
    const j = await r.json() as { access_token: string; expires_in?: number };
    this.token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }
  private async call(path: string, init: RequestInit = {}) {
    const tok = await this.accessToken();
    const r = await this.fetchFn(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}${path}`, {
      ...init, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new SheetsApiError(`Sheets API ${r.status}: ${(await r.text()).slice(0, 300).replace(/Bearer\s+\S+/g, "Bearer [redacted]")}`);
    return r.json() as Promise<any>;
  }
  async export(order: ApprovedOrder): Promise<{ location: string; updatedRange?: string; rows: number }> {
    const why = this.status(); if (why) throw new NotConfiguredError(`Google Sheets export not configured: ${why}`);
    const tab = `'${this.sheetName.replace(/'/g, "''")}'`;
    const head = await this.call(`/values/${encodeURIComponent(`${tab}!A1:A1`)}`);
    const values = [...(head.values?.length ? [] : [SHEET_COLUMNS]), ...orderRows(order)];
    const res = await this.call(`/values/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values }) });
    return { location: `https://docs.google.com/spreadsheets/d/${this.spreadsheetId}`, updatedRange: res.updates?.updatedRange, rows: values.length };
  }
}

export function unitsTotal(qty: number, unit: OrderUnit, caseQty: number, stripQty: number | null): number | null {
  switch (unit) {
    case "pc": return qty;
    case "dozen": return qty * 12;
    case "case": return caseQty > 0 ? qty * caseQty : null;
    case "strip": return stripQty ? qty * stripQty : null;
    default: return null;
  }
}
