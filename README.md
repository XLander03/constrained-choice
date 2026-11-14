# constrained-choice: distributor order → SKU lines (milestone 5)

Turns a retailer's free-text WhatsApp/email order ("maggi 70g 3 peti, parle g 10 wala 2 peti") into structured SKU order lines.
A rules extractor pulls out quantities, a hybrid retriever shortlists catalog SKUs, a decision model (OpenAI Decisions API)
picks one, and a calibrated router auto-accepts the sure lines and sends the rest to a reviewer.

Independent venture project. **All bundled data is SYNTHETIC** (299-SKU catalog, 150 labelled orders).

## Run it

Node ≥ 22.18 runs the `.ts` files directly (type stripping), so there's no build step.

```
npm install                 # dev deps only (typescript, @types/node)
npm test                    # unit + API tests (no key, no cost)
npm run typecheck
npm run serve               # HTTP API on http://127.0.0.1:8787 with the free MOCK decision adapter
```

Try it:

```
curl -s -X POST localhost:8787/orders/parse -H 'content-type: application/json' \
  -d '{"text":"maggi 70g 3 peti\nmaggi 2 peti\nparle g 10 wala 2 peti"}'
curl -s -X POST localhost:8787/catalog -H 'content-type: text/csv' --data-binary @my-item-master.csv
curl -s -X POST 'localhost:8787/orders/import/whatsapp?exclude_senders=My%20Shop' \
  -H 'content-type: text/plain' --data-binary @"WhatsApp Chat with Raju Kirana.txt"
```

Defaults live in [`config/app.json`](config/app.json) (no secrets): bare numbers ("maggi 5") mean **cases** (`DEFAULT_UNIT=pc|dozen|strip|none`
to change it), bori / bora / crate / bag count as a case, top-k 8, 98% precision target, WhatsApp bursts of 15 minutes.

The API (parse, approve, CSV export, catalog upload) and the UI brief are in [`API.md`](API.md). The web front end lives in
[`web/`](web/README.md) (Vite + React): `cd web && npm install && npm run dev` (mock data in the browser), or with the API running,
`VITE_API_BASE=http://127.0.0.1:8787 npm run dev`.

### Access control (milestone 5)

The API binds `127.0.0.1` and answers browsers only from allow-listed origins, by default the Vite dev ports
`http://localhost:5173` and `http://localhost:5174` (`ALLOWED_ORIGINS=https://a.example,https://b.example` to change). A page on any
other origin gets `403` before anything is read or written, so a random website open in the clerk's browser can't read orders or
replace the catalog. Without a token it also only answers requests addressed to `localhost`/`127.0.0.1` (blocks DNS rebinding).

To expose it beyond this machine, set a token; the server refuses to start on a non-loopback `HOST` without one:

```
export API_TOKEN="$(openssl rand -hex 24)"     # keep it out of the repo; never logged
HOST=0.0.0.0 ALLOWED_ORIGINS=https://desk.example.com npm run serve
curl -H "Authorization: Bearer $API_TOKEN" http://<host>:8787/orders     # or X-API-Key: <token>
```

`GET /health` stays open without the token but then only returns `status`, `version`, `auth_required`, `limits` and the adapter name (v0.5.1).
`DATA_DIR` moves the audit files (`review-queue.jsonl`, `approved-orders.jsonl`, `catalog-uploaded.csv`) out of `./var`.
Limits: 5 MB body, 20,000 characters and 400 product lines per order, 200 orders per WhatsApp import (`/health.limits`).

Paid mode (real OpenAI Decisions API, key read only from the environment and never logged):

```
export OPENAI_API_KEY=...            # set in your shell, never commit it
npm run serve:openai                 # stops with HTTP 429 after OPENAI_TOKEN_CAP (default 100k) input tokens
npm run eval:openai                  # full calibration run, hard cap 200k input tokens (~₹1.8)
npm run eval:openai:replay           # re-score the saved run for free (reports/eval-openai.decisions.jsonl)
npm run eval                         # same harness with the mock adapter (free)
npm run check:fallback               # paid check of the LLM fallback on 14 unparseable lines (~1.6k tokens)
```

The **LLM fallback** (`gpt-5-nano`, strict JSON schema) runs only in paid mode and only on lines the rules extractor can't parse
(no quantity found, e.g. "maggi 70g three boxes"). It has its own token cap (`LLM_FALLBACK_TOKEN_CAP`, default 20k per process), any
quantity it returns must be written in the line, and a unit word in the text overrides its unit. Disable with `LLM_FALLBACK_ENABLED=0`.

## Google Sheets setup (optional, off for the MVP)

**MVP output is CSV** (`GET /orders/:id/export.csv`). Google Sheets is deliberately left off (decision, 14 Nov 2026): the adapter
is built and tested but returns HTTP 501 until both pieces below exist. Nothing is created automatically.

1. In Google Cloud, create a service account, enable the **Google Sheets API** for its project, and download a JSON key.
   Keep the key outside the repo (`*.json` keys and `secrets/` are gitignored).
2. Share the target spreadsheet with the service account's `client_email` as **Editor**.
3. Set the sheet id (the long id in the sheet URL) in `config/app.json` → `sheets.spreadsheetId`, or `SHEETS_SPREADSHEET_ID`.
   Tab name: `sheets.sheetName` (default `Orders`; create the tab first).
4. Point `GOOGLE_APPLICATION_CREDENTIALS` at the key file and restart: `GOOGLE_APPLICATION_CREDENTIALS=~/keys/orderdesk-sa.json npm run serve`.
5. `GET /health` should show `"sheets_export_configured": true`; then `POST /orders/:id/export/sheets` appends the approved order
   (header row on first use, values written RAW so nothing runs as a formula).

## Results (SYNTHETIC data, 150 orders / 505 lines, OpenAI `gpt-6-luna`)

Threshold fitted on the dev split (even orders) for ≥98% precision; numbers are on the held-out test split (75 orders, 253 lines).
Policy: bare number = case. Milestone 4 is one paid recalibration run with the nickname-aware `rich` option descriptions, which
are now the default (`config/app.json` → `decision.descStyle`). Re-score it free with `npm run eval:openai:replay`.

| | **M4: `rich` (default)** | M3: `minimal` |
|---|---|---|
| Auto-accept coverage | **76.3%** (193 / 253 lines); 75.9% (192) with the M5 overlap guard | 70.0% (177) |
| Auto-accept precision (product + qty + unit) | **100%** (0 wrong) | 99.4% (1 wrong) |
| Orders fully auto and correct | 36.0% | 29.3% |
| Resolvable lines answered "none of these" (all 150 orders) | 3.6% | 10.8% |
| Threshold (calibrated, dev) | 1.0 (raw confidence ≥ 0.46) | 0.917 |
| Input tokens, whole run (150 orders) | 215,627 (₹1.90) | 181,728 (₹1.60) |

Of the 253 test lines, 49 are ambiguous or out-of-catalog and must go to review, so 80.6% is the ceiling; `rich` auto-accepts
193 of the 204 resolvable lines. Out-of-catalog → none_of_these: 100%; wrong-SKU picks on resolvable lines: 0 of 419; the
pack-size/variant rule blocks every ambiguous line (0 leaks; without it 4 would leak and precision would drop to 98%).
On dev the model made no wrong pick at all, so calibration maps every pick to 1.0 and the threshold sits at the top; picks with
a raw confidence below the lowest one seen on dev (0.46) go to review rather than being extrapolated. The synthetic bare numbers
were generated without a true unit, so "case" is correct by policy here, not because the retailer meant it.
The previous `minimal` run is kept as `reports/eval-openai-minimal.*`.

**Overlap guard (milestone 5).** Whatever the provider says, a pick whose SKU names/aliases explain less than 55% of the line's words
(IDF-weighted, typo-tolerant) goes to review as `low_overlap`. QA found the mock auto-accepting "red bull 250ml" as Red Label Tea;
the guard blocks that for any adapter. On the paid run's replay it costs 1 correct test line (76.3% → 75.9%, still 100% precise);
on the mock it removed the one wrong auto-accept (99.5% → 100%).

**Richer option descriptions (milestone 3 A/B, 38 orders where the calibrated `minimal` style answered "none of these" on known products):**

| Same 38 orders / 163 lines | `minimal` (MRP only) | `rich` (MRP + variant shorthand) |
|---|---|---|
| Resolvable lines correct | 68.5% | **93.7%** |
| Answered none on a known product | 31.5% | 6.3% |
| Wrong-SKU picks | 0 | 0 |
| Out-of-catalog → none | 100% | 100% |
| Input tokens | 57,796 | 68,703 (+19%) |

"blue lays", "green lays", "lays green", "26G LAYS GEEN", "cola", "hamam", "amul cheese" all went from none to the right SKU;
36 lines fixed, 0 broken. Milestone 4 confirmed this on all 150 orders and made `rich` the default.

**LLM fallback check** (14 synthetic lines the rules can't parse, e.g. "colgate 100g five boxes"): 13 / 14 correct qty + unit,
the miss stayed in review; 1,606 tokens ≈ ₹0.02.

Synthetic data is easier than real WhatsApp orders, so treat all of this as an upper bound. Details: `reports/`, `SPEC.md` §8.

## Layout

| Path | What |
|---|---|
| `src/types.ts` | data model |
| `src/extract/extractor.ts` | stage 1: line splitter + qty/unit extractor (rules) |
| `src/retrieve/retriever.ts` | stage 2: BM25 + trigram-vector hybrid shortlist (top-k 8) |
| `src/decide/openai.ts` | OpenAI Decisions API adapter (request builder, parser, fetch client, error redaction) |
| `src/decide/budget.ts` | hard input-token budget guard for paid runs |
| `src/decide/replay.ts` | replays a saved paid run so routing changes can be re-scored for free |
| `src/decide/mock.ts`, `jev.ts` | offline mock (never sees gold labels); Jev placeholder |
| `src/route/ambiguity.ts` | pack-size / variant ambiguity check → review instead of guessing |
| `src/route/*` | isotonic calibration, threshold selection, router, JSONL review queue |
| `src/catalog/load.ts` | catalog CSV parser with column-name mapping for real item masters |
| `src/config.ts`, `config/app.json` | runtime defaults (default unit, top-k, Sheets, LLM fallback, WhatsApp import) + env overrides |
| `src/intake/whatsapp.ts` | WhatsApp chat export parser (Android + iOS) and burst grouping |
| `src/extract/llmFallback.ts` | paid LLM fallback for lines the rules can't parse (strict JSON schema, own token cap) |
| `src/export/exporter.ts` | CSV export + Google Sheets exporter (service account, inert until configured) |
| `src/server/` | HTTP API (`app.ts`), entry point (`main.ts`) |
| `src/eval/run.ts` | eval harness → `reports/eval-<adapter>.json` + `.calibration.json` |
| `test/` | `node --test` unit and API tests |
| `scripts/` | synthetic data generators, CLI demo |
