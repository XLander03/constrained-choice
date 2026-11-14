// App config: config/app.json (committed, no secrets) + env overrides. Keys are never read from here.
import { existsSync, readFileSync } from "node:fs";
import type { DescStyle } from "./decide/openai.ts";
import type { OrderUnit } from "./types.ts";

export interface AppConfig {
  units: { defaultUnitForBareNumber: OrderUnit | null };   // null = bare numbers go to review
  decision: { topK: number; descStyle: DescStyle; targetPrecision: number; minLexicalOverlap: number };
  sheets: { spreadsheetId: string; sheetName: string; credentialsPathEnv: string };
  llmFallback: { enabled: boolean; model: string; inputPerMTokUsd: number; outputPerMTokUsd: number; tokenCap: number; maxOutputTokens: number };
  whatsappImport: { group: "burst" | "message"; burstMinutes: number; maxOrdersPerImport: number };
}

const UNITS = ["pc", "dozen", "case", "strip"];
export function parseDefaultUnit(v: string | null | undefined): OrderUnit | null {
  if (v == null || v === "" || v === "none" || v === "review") return null;
  if (!UNITS.includes(v)) throw new Error(`default unit must be one of ${UNITS.join(", ")} or "none" (got "${v}")`);
  return v as OrderUnit;
}

export function loadConfig(path = new URL("../config/app.json", import.meta.url).pathname, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const f = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const c: AppConfig = {
    units: { defaultUnitForBareNumber: parseDefaultUnit(f.units?.defaultUnitForBareNumber ?? "case") },
    decision: { topK: 8, descStyle: "rich", targetPrecision: 0.98, minLexicalOverlap: 0.55, ...f.decision },
    sheets: { spreadsheetId: "", sheetName: "Orders", credentialsPathEnv: "GOOGLE_APPLICATION_CREDENTIALS", ...f.sheets },
    llmFallback: { enabled: true, model: "gpt-5-nano", inputPerMTokUsd: 0.05, outputPerMTokUsd: 0.4, tokenCap: 20000, maxOutputTokens: 600, ...f.llmFallback },
    whatsappImport: { group: "burst", burstMinutes: 15, maxOrdersPerImport: 200, ...f.whatsappImport },
  };
  if (env.DEFAULT_UNIT !== undefined) c.units.defaultUnitForBareNumber = parseDefaultUnit(env.DEFAULT_UNIT);
  if (env.SHEETS_SPREADSHEET_ID) c.sheets.spreadsheetId = env.SHEETS_SPREADSHEET_ID;
  if (env.SHEETS_SHEET_NAME) c.sheets.sheetName = env.SHEETS_SHEET_NAME;
  if (env.LLM_FALLBACK_ENABLED !== undefined) c.llmFallback.enabled = env.LLM_FALLBACK_ENABLED === "1" || env.LLM_FALLBACK_ENABLED === "true";
  if (env.LLM_FALLBACK_MODEL) c.llmFallback.model = env.LLM_FALLBACK_MODEL;
  if (env.LLM_FALLBACK_TOKEN_CAP) c.llmFallback.tokenCap = Number(env.LLM_FALLBACK_TOKEN_CAP);
  return c;
}
