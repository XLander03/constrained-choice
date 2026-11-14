// Start the API: node src/server/main.ts
// Env: PORT=8787, HOST=127.0.0.1, DECISION_ADAPTER=mock|openai, OPENAI_TOKEN_CAP=100000, THRESHOLD, DATA_DIR (default ./var),
//   ALLOWED_ORIGINS (comma-separated; default http://localhost:5173,http://localhost:5174; CORS_ORIGIN is an alias),
//   API_TOKEN (bearer token; REQUIRED when HOST is not a loopback address), plus config/app.json overrides
//   (DEFAULT_UNIT, SHEETS_SPREADSHEET_ID, LLM_FALLBACK_ENABLED, ...; see src/config.ts).
// The OpenAI key and API_TOKEN are read only from the environment and are never logged.
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { BudgetedAdapter } from "../decide/budget.ts";
import type { DecisionAdapter } from "../decide/adapter.ts";
import { MockDecisionAdapter } from "../decide/mock.ts";
import { OpenAIDecisionsAdapter } from "../decide/openai.ts";
import { GoogleSheetsExporter } from "../export/exporter.ts";
import { FallbackExtractor, OpenAILlmLineParser } from "../extract/llmFallback.ts";
import { IsotonicCalibrator } from "../route/calibrate.ts";
import { DEFAULT_ALLOWED_ORIGINS, createApp } from "./app.ts";

const host = process.env.HOST || "127.0.0.1";
const loopback = ["127.0.0.1", "localhost", "::1"].includes(host) || /^127\./.test(host);
const apiToken = process.env.API_TOKEN?.trim() || undefined;
const originsEnv = process.env.ALLOWED_ORIGINS ?? process.env.CORS_ORIGIN;
const allowedOrigins = originsEnv ? originsEnv.split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean) : DEFAULT_ALLOWED_ORIGINS;
const refuse = (msg: string) => { console.error(msg); process.exit(1); };
if (apiToken !== undefined && apiToken.length < 16) refuse("API_TOKEN must be at least 16 characters (e.g. `openssl rand -hex 24`).");
if (!loopback && !apiToken) refuse(`HOST=${host} is not a loopback address: set API_TOKEN so the API isn't open to the network.`);
if (allowedOrigins.includes("*") && !apiToken) refuse("ALLOWED_ORIGINS=* lets any website call the API; it is only allowed together with API_TOKEN.");

const conf = loadConfig();
const root = new URL("../../", import.meta.url);
const adapterName = process.env.DECISION_ADAPTER === "openai" ? "openai" : "mock";
const key = process.env.OPENAI_API_KEY;
let decider: DecisionAdapter;
if (adapterName === "openai") {
  if (!key) { console.error("DECISION_ADAPTER=openai needs OPENAI_API_KEY in the environment."); process.exit(1); }
  decider = new BudgetedAdapter(new OpenAIDecisionsAdapter({ apiKey: key, descStyle: conf.decision.descStyle }),
    Number(process.env.OPENAI_TOKEN_CAP ?? 100000), { descStyle: conf.decision.descStyle });
} else decider = new MockDecisionAdapter(0.5, { descStyle: conf.decision.descStyle });

// Paid LLM fallback only in paid mode, only when enabled, and only for lines the rules can't parse. One parser = one token cap per process.
const llm = adapterName === "openai" && conf.llmFallback.enabled && key ? new OpenAILlmLineParser({ apiKey: key, ...conf.llmFallback }) : null;

const calPath = new URL(`reports/eval-${adapterName}.calibration.json`, root).pathname;
const cal = existsSync(calPath) ? JSON.parse(readFileSync(calPath, "utf8")) : null;
const app = createApp({
  catalogPath: new URL("data/catalog.csv", root).pathname, decider,
  calibrator: cal ? IsotonicCalibrator.fromJSON(cal.calibrator) : undefined,
  threshold: Number(process.env.THRESHOLD ?? cal?.threshold ?? 0.9),
  calibrationInfo: cal ? { file: `reports/eval-${adapterName}.calibration.json`, data_label: cal.data_label, target_precision: cal.target_precision, threshold: cal.threshold, default_unit: cal.default_unit ?? null } : undefined,
  topK: conf.decision.topK, defaultUnit: conf.units.defaultUnitForBareNumber,
  wrapExtractor: llm ? rules => new FallbackExtractor(rules, llm) : undefined,
  whatsapp: conf.whatsappImport,
  sheets: new GoogleSheetsExporter({ spreadsheetId: conf.sheets.spreadsheetId, sheetName: conf.sheets.sheetName, credentialsPathEnv: conf.sheets.credentialsPathEnv }),
  allowedOrigins, apiToken, minLexicalOverlap: conf.decision.minLexicalOverlap,
  dataDir: process.env.DATA_DIR || undefined,
});
const port = Number(process.env.PORT ?? 8787);
await app.listen(port, host);
console.log(`decision-engine API on http://${host}:${port}  origins=${allowedOrigins.join(",")}  auth=${apiToken ? "token" : "off (loopback only)"}  adapter=${decider.name}  threshold=${cal?.threshold ?? "default"}  default_unit=${conf.units.defaultUnitForBareNumber ?? "none"}  llm_fallback=${llm ? conf.llmFallback.model : "off"}`);
