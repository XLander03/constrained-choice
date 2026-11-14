# Decision Engine, build #1: distributor order → SKU order lines

Status: milestone 5, QA hardening (origin allow-list + optional token, overlap guard, limits, atomic import); `rich` descriptions
are the default; CSV is the MVP output, Sheets off (14 Nov 2026).

**Decisions confirmed by the user (14 Nov 2026):** FMCG/kirana; no partner distributor yet, so data stays SYNTHETIC; intake = manual
paste or WhatsApp chat export; a bare number means **cases**, and bori / bora / crate / bag count as a case; approved orders go to a
Google Sheet; auto-accept precision bar 98%; a cheap paid LLM is allowed only for lines the rules can't parse. Independent venture project, separate from the Builders Cup and from the company roadmap.
**All data in this repo is SYNTHETIC.**

## 1. Problem

Indian FMCG distributors take most retailer orders as free text on WhatsApp, and some by email. A typical message:

```
Bhai order likho
parle g 10 wala 2 peti
blue lays 20rs 1 box
clinic plus 1rs 10 ladi
H&S cool menthol 5 ladi, maggi 70g 3 peti
jaldi bhejna
```

A person at the distributor reads each line, works out the SKU (brand, variant, pack size), converts "peti / dabba / ladi / dzn"
into units, and keys it into Tally, Busy or a DMS. That job is slow, error-prone and needs someone who knows the catalog. Messages mix
Hindi and English, use brand shorthand ("GD", "H&S", "blue lays"), give pack size as a price ("10 wala"), contain typos, and leave
things out ("maggi 2 peti", but which size?).

**Goal:** turn each message into structured lines `{sku_id, qty, unit}`. Lines the system is sure about go through automatically,
and everything else goes to a one-tap review queue. The target is ≥98% precision on auto-accepted lines, with coverage as high as that allows.

**Not in scope for the MVP:** pricing and schemes, credit limits, invoicing, delivery routing, voice notes (a good v2 idea for a voice team).

## 2. Architecture

```mermaid
flowchart LR
  A[WhatsApp / email / manual paste] --> B[1. Line splitter +<br/>qty/unit extractor<br/>rules first, cheap LLM fallback]
  B -->|ExtractedLine[]| C[2. Candidate retrieval<br/>BM25 + embeddings, RRF<br/>size/price boosts, top-k 20]
  CAT[(Catalog + alias store)] --> C
  C -->|line + shortlist| D[3. DecisionAdapter<br/>one request per order,<br/>one choice question per line]
  D -->|choice, probabilities,<br/>confidence| E[4. Calibrate + route]
  E -->|calibrated ≥ t and qty/unit known| F[Auto-accepted lines<br/>→ DMS / Tally export]
  E -->|low confidence, none_of_these,<br/>qty or unit missing,<br/>pack size / variant not stated| G[Review queue]
  G -->|corrections| CAT
  G --> F
  H[5. Eval harness<br/>accuracy · coverage@t · cost] -.-> B & C & D & E
```

Decision models are weak with numbers, so **stage 1 extracts quantities without the model**. The decision model only picks *which product*,
from a short list, which is what it is built for.

## 3. Module interfaces (TypeScript, Node ≥ 22.18)

The source of truth is `src/`. The excerpts below are kept in sync with it.

```ts
// src/types.ts
type OrderUnit = "pc" | "dozen" | "case" | "strip" | "unspecified";
interface IncomingOrder { orderId: string; channel: "whatsapp" | "email" | "manual"; retailerId?: string; receivedAt?: string; text: string }
interface ExtractedLine { lineId: string; orderId: string; raw: string; itemText: string; qty: number | null; unit: OrderUnit;
  sizeHint: { value: number; unit: string } | null; priceHint: number | null; extractor: "rules" | "llm" }
interface Candidate { sku: Sku; score: number; lexicalRank: number | null; vectorRank: number | null; lexicalScore?: number; vectorScore?: number }
const NONE = "__none__";
interface LineDecision { lineId: string; choice: string /* skuId | NONE */; probabilities: { skuId: string; p: number }[]; confidence: number; refused: boolean }
interface ResolvedLine { line: ExtractedLine; candidates: Candidate[]; decision: LineDecision; calibratedConfidence: number; route: "auto" | "review"; reason: string }

// Stage 1: src/extract/extractor.ts
interface LineExtractor { extract(order: IncomingOrder): Promise<ExtractedLine[]> }   // RulesExtractor now; LlmExtractor later
// Stage 2: src/retrieve/retriever.ts
interface CandidateRetriever { shortlist(line: ExtractedLine, k: number): Candidate[] } // HybridRetriever
interface EmbeddingProvider { embed(texts: string[]): ... }                              // TrigramEmbedder (local stand-in)
// Stage 3: src/decide/adapter.ts
interface DecisionAdapter { readonly name: string; decideOrder(req: OrderDecisionRequest): Promise<OrderDecisionResult> }
interface OrderDecisionRequest { order: IncomingOrder; lines: { line: ExtractedLine; candidates: Candidate[] }[] }
interface OrderDecisionResult { decisions: LineDecision[]; usage: DecisionUsage; raw?: unknown }
// Stage 4: src/route/*
interface Calibrator { fit(samples: { conf: number; correct: boolean }[]): void; apply(conf: number): number }
function chooseThreshold(samples, targetPrecision, minAccepted = 20): { threshold; precision; coverage }
function routeLine(line, candidates, decision, calibrator, policy: { threshold: number; allowUnspecifiedUnit: boolean; ambiguity?: "review" | "ignore" }): ResolvedLine
function checkAmbiguity(line, chosen: Sku, candidates): { ambiguous: boolean; kind: "pack_size" | "variant" | null; consistent: string[] }  // src/route/ambiguity.ts
interface ReviewQueue { enqueue(line: ResolvedLine): ReviewItem; list(status?): ReviewItem[]; resolve(id, resolution): void }
// Wiring: src/pipeline.ts
function processOrder(order: IncomingOrder, deps: PipelineDeps): Promise<ResolvedOrder>
```

### Stage 1: extractor (`RulesExtractor`)
- Splits on newlines, then on `,` `;` `+` `aur` `and` when every part has its own quantity. Strips `1)` / `1.` numbering, email
  headers and signatures, and chatter lines with no quantity ("jaldi bhejna", "payment monday ko").
- Quantity can be digits, Hindi number words (ek, do, teen, … das, barah) or fractions (aadha/half = 0.5, dedh = 1.5).
- Unit vocabulary maps to the canonical unit: peti/pet/ctn/carton/case/cs/box/dabba/crate/bori → `case`; dozen/dzn/doz/darjan → `dozen`;
  pc/pcs/nos/pkt/packet/bag → `pc`; ladi/strip → `strip`. A bare number becomes `unspecified`, and distributor policy decides what it means.
- When a line has several qty+unit matches, the last one is the order quantity ("whisper XL 20 pcs 3 pkt" → 3 pc).
- Size ("70g", "1 ltr") and price ("10 wala", "rs 20", "₹10") are pulled out as **hints for retrieval**, never as the quantity.
- Numeric brand names ("5 Star", "50-50", "2-Minute") are protected using the catalog.
- **LLM fallback (M3, `src/extract/llmFallback.ts`).** `FallbackExtractor` wraps the rules: only lines with `qty === null` are sent, in one
  request per order, to `gpt-5-nano` (Chat Completions, `response_format: json_schema`, `strict: true`, schema
  `{lines: [{index, is_order_line, qty|null, unit enum, item_text}]}`, `reasoning_effort: minimal`). Guards: own token cap
  (`llmFallback.tokenCap`, checked before each call), a qty is accepted only if it's written in the line (digits or a number word),
  a unit word in the text overrides the model's unit, lines are never dropped, and any error leaves the rules output (→ review).
- **Default unit (M3).** After extraction, a bare number gets `config.units.defaultUnitForBareNumber` (`case`) and `unitDefaulted: true`.
  Set it to `none` to route bare numbers to review instead.

### Stage 2: retrieval (`HybridRetriever`)
BM25 runs over brand, product, variant, size, MRP and aliases. A char-trigram cosine (typo-tolerant, local and free) stands in for real
embeddings behind `EmbeddingProvider`. The two are fused with reciprocal-rank fusion (k = 60), then size-hint and price-hint matches get a boost.
Default top-k is **8** since milestone 2 (recall@8 = 100% on the synthetic set, and it keeps a full 150-order calibration run
under the 200k-token cap). The API allows up to 254 + NONE.

### Intake: WhatsApp chat export (M3, `src/intake/whatsapp.ts`)
`parseWhatsAppExport` reads Android (`dd/mm/yy, h:mm am - Name: text`, 12h/24h, `.`/`-` separators, 4-digit years) and iOS
(`[dd/mm/yy, h:mm:ss AM] Name: text`, U+200E / U+202F marks) lines; untimestamped lines continue the previous message; system notices,
media placeholders, deleted and "edited" markers are dropped. Day/month order is detected over the whole file (default dmy).
`groupMessages` makes one order per message or per **burst** (same sender, gaps ≤ 15 min, broken by anyone else's message;
the distributor's own name can be excluded). Exposed as `POST /orders/import/whatsapp`.

## 4. Data model

**`data/catalog.csv`** (synthetic, 299 SKUs): `sku_id, brand, product, variant, pack_size, pack_unit, mrp_inr, case_qty, strip_qty, category, aliases (pipe-separated), data_label=SYNTHETIC`.
`case_qty` turns "peti" into units, and `strip_qty` turns "ladi" into sachets.

**`data/orders.jsonl`** (synthetic, 150 orders, 505 gold lines: 419 resolvable, 46 ambiguous, 40 out of catalog):
```json
{"order_id":"ORD0001","data_label":"SYNTHETIC","channel":"whatsapp","retailer":"Raju Kirana","text":"…","tags":["hinglish","typo"],
 "lines":[{"raw":"bru coffee 2g - 4 ladi","sku_id":"SKU0063","qty":4,"unit":"strip"},
          {"raw":"do dozen GD PISTA BADAM","sku_id":null,"ambiguous":true,"acceptable_sku_ids":["SKU0019","SKU0020"],"qty":2,"unit":"dozen"}]}
```
Tags: `hinglish, typo, abbreviation, hindi_number, unit_implicit, single_line, ambiguous, out_of_catalog`, plus 15 `handwritten`
edge-case orders (price-as-size, colour aliases like "blue lays", near-miss products, fractional qty, "same as last week", unknown units like crate/bori/bags).

**Production additions (not built yet):** `alias_store` (retailer- or distributor-specific phrase → sku, learned from review), `retailer_history`
(last N orders, used as a prior and for "same as last week"), and `audit_log` (request, response and final line, kept for disputes).

## 5. Decision API adapter

### OpenAI Decisions API (now)
Sources, checked 14 Nov 2026:
- Guide: https://developers.openai.com/api/docs/guides/decisions
- Reference: https://developers.openai.com/api/reference/resources/decisions/methods/create
- Launch post (GA, 22 Oct 2026): https://openai.com/index/decisions-api/

| Item | Verified value |
|---|---|
| Endpoint | `POST https://api.openai.com/v1/decisions` (SDK: `client.decisions.create`) |
| Model | `gpt-6-luna`, the only supported model |
| Body | `{ model, input, questions[], prompt_cache_key? }`. `input` is shared evidence (string or message array) |
| Choice question | `{ type: "choice", name, instructions, choices: [{ value, description? }] }`, **2–255 choices**, **1–400 questions** per request |
| Answer | `answers[]` in question order, echoing `name`. Choice → `{ choice, confidence, probabilities: [{ value, probability }] }`. Any question can return `{ type: "refusal" }` |
| Pricing | uncached input **$0.10 / 1M tokens**, output not charged. Cache hits are discounted and cache writes are charged, at "standard gpt-6-luna caching rates" |
| Caching | implicit breakpoint at the end of `input`, prefix ≥ 1,024 tokens. Question content is **not** part of the cached prefix |

Design choices that follow from the docs:
- **One request per order, with one choice question per line.** The whole message goes in `input` (shared evidence), and each line's shortlist goes in its question.
- **Readable choice values.** The docs advise meaningful values over opaque IDs, so each value is `"Parle Parle-G Biscuit 110g [SKU0002]"`, and the `[id]` suffix keeps it unique and reversible.
- **Choice descriptions.** Since milestone 4 the default `descStyle` is `rich` (MRP + up to 3 variant-specific aliases, ≈ 1,440
  tokens/order; §8 M4). Older styles: `minimal` (MRP only, the M2–M3 default), `compact` (MRP + 2 aliases) or `full`
  (milestone 1: MRP, case size, 4 aliases). Minimal cut tokens per order from ~3,500 to ~1,200. The trade-off is visible in §8: the
  model answers none_of_these more often on shorthand like "blue lays" or "lays green" (safe, but it costs coverage). Try `compact` next.
- **Budget guard.** Paid runs go through `BudgetedAdapter`, which estimates each request (JSON chars / 4 × max(1.35, observed ratio))
  and refuses it if the projected total would pass the cap. Observed actual/estimate ratio: 1.31.
- **Key handling.** The key is read only from `process.env.OPENAI_API_KEY`; provider error bodies are passed through `redactSecrets`.
- **`none_of_these` is always included**, as the docs recommend a fallback option.
- **Not verified:** what `confidence` means exactly, compared with the top probability. That's why we never threshold on it raw: we calibrate it (§6). Cache read and write prices are also unverified, so the price table defaults them to the uncached rate, which overstates cost slightly.

Code: `src/decide/openai.ts`. `buildDecisionsRequest` and `parseDecisionsResponse` are pure functions, and `OpenAIDecisionsAdapter` makes the fetch call with a 15 s timeout and no retries.
The key is read only from `process.env.OPENAI_API_KEY`.

### Jev (later) and others
`src/decide/jev.ts` is a placeholder. A third-party doc (docs.aimlapi.com, not checked against TypeSafe's own docs) says Jev/d1 use a different contract:
`state` instead of `input`, questions as an object keyed by name, `criteria: {key: description}` for options, and answers keyed by name. That's why the
adapter interface hides wire formats completely. The plan is to A/B the two on the same shortlists in week 4.

### Mock (offline)
`src/decide/mock.ts` turns retrieval signals into a seeded, noisy softmax. It **never sees gold labels**, and its accuracy validates the harness, not any model.
It reports token cost by building the exact OpenAI request body and estimating at about 4 characters per token.

## 6. Threshold and calibration
1. Run the pipeline on a labelled **dev** split (even-indexed orders) and record `(confidence, correct)` for every line where the model picked a SKU.
   A NONE answer always goes to review. A pick on an ambiguous gold line counts as **incorrect** (strict), because we'd rather ask.
2. Fit an **isotonic** calibrator (pool-adjacent-violators) from confidence to P(correct). Platt scaling is the fallback if data is thin.
3. Choose the **lowest threshold t** at which auto-accepted dev lines reach precision ≥ target (default 0.98, with at least 20 accepted lines). That gives maximum coverage at the target precision.
   Below the lowest confidence seen while fitting there is no evidence, so the calibrator returns 0 there (→ review) instead of
   extrapolating (M4; calibration files without `min_conf_seen` keep the old behaviour). The eval records the effective
   `raw_confidence_floor` in `reports/eval-<adapter>.calibration.json`.
4. Report on the held-out **test** split (odd orders). Re-fit monthly, or whenever the catalog, prompt or model changes.
5. Hard rules, applied whatever the confidence: `none_of_these`, refusal, missing qty, an `unspecified` unit (only possible when the default unit is off),
   or **pack-size / variant ambiguity** → review. The threshold is chosen only over dev lines that pass the hard rules, so the 98% target
   applies to what is actually auto-accepted.
6. **Ambiguity rule (milestone 2).** The smoke test showed the model confidently picking *a* pack when the retailer never said which
   ("maggi 2 peti", 60% of ambiguous lines). `checkAmbiguity` looks at the chosen SKU's family (same brand + product) in the shortlist and
   keeps the members that fit everything the line says: size hint, price hint, stray pack numbers ("20 pcs", "coke 750"), and variant
   words (variant name or aliases unique to that variant, typo-tolerant). If ≥2 remain, the line goes to review with `pack_size_ambiguous`
   or `variant_ambiguous`, and the fitting SKUs are returned as `ambiguousWith` for the reviewer. A price hint that fits no pack
   ("maggi 70 wala") is also ambiguous. On gold labels it flags 46/46 ambiguous lines and 3/418 resolvable ones (two of those are a
   catalog with two "1 pcs / 1 pack" agarbatti SKUs, which really is ambiguous).
7. **Overlap guard (milestone 5, provider-independent).** `OverlapScorer` (`src/route/overlap.ts`) measures the share of the line's
   content words (units, numbers and Hinglish filler removed) that the picked SKU's brand/product/variant/aliases explain, weighted by
   catalog IDF (words in no SKU get the maximum weight), typo-tolerant (edit distance 1 for 4+ letters, 3+ letter prefixes). Below
   `decision.minLexicalOverlap` (0.55) → review as `low_overlap`. On gold labels only 2 of 419 resolvable lines score below 0.55
   (both chatter-heavy: "same as last week + red label 250g"), while 33 of 40 out-of-catalog lines would be blocked even if the model
   picked their best-overlapping candidate. "red bull 250ml" vs Red Label Tea scores 0.38.
8. Planned extras: a margin feature (p1 − p2), shuffling candidate order across 2 runs for borderline lines (option order is known to move results), and per-category thresholds.

## 7. Review queue UX and HTTP API

Milestone 2 ships the backend as a plain `node:http` JSON API (`src/server/`); the web front end is built separately against
[`API.md`](API.md), which also holds the UI brief (screens, states, review interaction). Endpoints: `POST /orders/parse`,
`GET /orders[/:id]`, `POST /orders/:id/approve`, `GET /orders/:id/export.csv`, `POST /orders/:id/export/sheets` (501 stub),
`POST /catalog` (CSV upload with column-name mapping), `GET /catalog?q=`. Orders live in memory; review events and approved
orders are appended to `var/*.jsonl`.

UX outline (unchanged design intent):
- **Inbox:** one card per order, showing the original message on the left and parsed lines on the right. Auto lines are green, review lines amber with the reason ("low confidence", "not in catalog", "unit?").
- **Line fix:** the top 3–5 model suggestions are shown as one-tap chips with the pack size and MRP. There's also a search box over the catalog, a qty stepper and a unit toggle (pc, dozen, case, strip).
- **Learn:** a "remember this for this retailer" checkbox writes the phrase → SKU to the alias store, so the next order has it in the shortlist and in the prompt.
- **Out of catalog:** mark it as "not stocked", which drafts a reply to the retailer, or "new SKU", which notifies the catalog owner.
- **Finish:** "Approve order" exports CSV or JSON for Tally, Busy or the DMS, and can optionally send the retailer a WhatsApp confirmation listing the lines.
- **Keyboard first:** 1–5 picks a suggestion, J/K moves between lines, and Enter approves. The target is under 5 seconds per review line.
- Storage: `JsonlReviewQueue` now (append-only events), then SQLite or Postgres.

## 8. Eval metrics (`npm run eval`, writes `reports/eval-<adapter>.json`)
| Group | Metrics |
|---|---|
| Extraction | gold-line recall, spurious lines, exact qty %, exact unit % |
| Retrieval | recall@1 / @5 / @k for resolvable lines |
| Decision (top-1) | resolvable accuracy, OOC → NONE %, ambiguous → NONE %, ambiguous pick in acceptable set % |
| Routing (test split) | threshold fitted on dev, **coverage %** at t, **auto precision %** (product, and product + qty + unit), ambiguous and OOC auto-leaks, % orders fully auto and correct, raw-confidence sweep |
| Cost | requests, input tokens, tokens/order, $/order, $/1,000 orders, ₹/1,000 orders (at ₹88/$) |
| Slices | the same metrics for lines in orders tagged handwritten, typo, hinglish, abbreviation, etc. |

### Milestone 5: QA fixes (14 Nov 2026, SYNTHETIC, no paid tokens)

Eval Demo's end-to-end QA (`/workspace/decision-engine-qa/REPORT.md`, outside the repo) found 0 critical, 2 high, 4 medium, 9 low.
Backend fixes:

| QA item | Fix |
|---|---|
| H1 CORS `*`, no auth | Origin allow-list (default localhost:5173/5174) checked before the body is read, `403` otherwise; optional `API_TOKEN` (Bearer / X-API-Key, constant-time compare), mandatory on non-loopback `HOST`; loopback-only `Host` header without a token |
| H2 mock auto-accepts "red bull" as Red Label | Mock answers none_of_these when no option shares ≥ 60% of the line's words; plus the provider-independent overlap guard (§6.7) |
| M1 401 lines → 502 | Line limit checked after extraction, before any decision call: `422 too_many_lines` |
| M2 orphan orders on failed import | Import resolves every group first and stores only if all succeed; over-long groups are skipped |
| M3 iOS "This message was deleted." | Placeholder regex allows the trailing period (also "You deleted this message.", "Waiting for this message") |
| M4 hang after 413 | `Content-Length` pre-check; any reply to a request whose body wasn't fully read carries `Connection: close` |
| L1 / L3 / L4 / L5 / L7 / L8 | JSON `null` → 400; `limit` clamped; invalid `order_id` → 400; empty orders can't be approved; catalog rows with extra fields rejected; stale-catalog SKUs flagged on approve |

v0.5.1 (UI feedback): the `403 origin_not_allowed` reply echoes the request origin (no credentials) so the page can read it, and
`GET /health` answers without a token with a public subset (`status`, `version`, `auth_required`, `limits`, `adapter`).

Eval impact (same thresholds; replay, no new spend): OpenAI `rich` test split 76.3% → **75.9%** coverage (192/253), precision
still 100%; the guard sent 1 correct line to review. Mock: 79.8% coverage at 100% (without the guard 80.6% at 99.5%, 1 out-of-catalog
leak). `reports/eval-*.json` now include `at_threshold_test_without_overlap_guard` and `min_lexical_overlap`.

### Milestone 4: recalibration with `rich` descriptions (14 Nov 2026, SYNTHETIC)

One paid run, all 150 orders, top-k 8, `rich`, bare number = case, hard cap 230,000 input tokens (not hit; the guard did not stop).
Dev split: 209 picks, **0 wrong**, 208 pass the hard rules. Isotonic calibration therefore maps every pick to 1.0, and the 98% target
gives calibrated t = 1.0, i.e. every pick with raw confidence ≥ 0.46 (the lowest seen on dev) that passes the hard rules.
Test split, 253 lines (204 resolvable, 25 ambiguous, 24 out-of-catalog):

| | M4 `rich` | M3 `minimal` (replay) |
|---|---|---|
| Auto coverage | **76.3%** (193 lines) | 70.0% (177) |
| Auto precision (product + qty + unit) | **100%** (0 wrong) | 99.4% (1 wrong) |
| Orders fully auto and correct | 36.0% | 29.3% |
| Without the ambiguity rule | 78.3% / 98.0% (4 leaks) | |
| Bare numbers → review instead of case | 62.8% / 100% | 58.1% / 100% |
| Ambiguous / out-of-catalog auto leaks | 0 / 0 | 0 / 0 |

All 150 orders, top-1: resolvable correct 96.4%, answered none 3.6%, wrong-SKU picks 0; out-of-catalog → none 100%;
ambiguous → none 91.3%. Review reasons over all 505 lines: 97 none_of_these, 3 pack_size_ambiguous, 3 variant_ambiguous.
Cost: 150 requests, **215,627 input tokens, $0.0216 ≈ ₹1.90** (1,438 tokens/order, ≈ ₹12.65 per 1,000 orders), 28 s.
Caveat: 0 wrong picks on 209 dev lines means the true error rate is only bounded (≈ ≤ 1.4% at 95% confidence); the threshold
should be re-fitted on real orders, which will contain mistakes. Files: `reports/eval-openai.{json,calibration.json,decisions.jsonl}`;
the M2/M3 `minimal` run is kept as `reports/eval-openai-minimal.*`.

### Milestone 3 (14 Nov 2026, SYNTHETIC)

**Re-score under "bare number = case"** (replay of the M2 decisions, no new spend; threshold re-fitted on dev: 195 eligible
picks, calibrated t = 0.917). Test split, 253 lines:

| | OpenAI gpt-6-luna | Mock (harness check) |
|---|---|---|
| Auto coverage | **70.0%** (177 lines) | 77.1% |
| Auto precision (product + qty + unit) | **99.4%** (1 wrong) | 99.0% |
| Orders fully auto and correct | 29.3% | 41.3% |
| Same decisions, bare numbers → review (M2 policy) | 58.1% / 100% | 63.2% / 98.8% |
| Ambiguous / out-of-catalog auto leaks | 0 / 0 | 0 / 2 |

The 79 defaulted lines are correct by policy: the synthetic generator never assigned a true unit to bare numbers.
Gold label change: "Ashirwad atta 10 kilo - 5 bags" is now `case` (was `pc`), matching the bag = case policy.

**Choice descriptions A/B** (`reports/ab-minimal-38orders.json` vs `reports/ab-rich-38orders.json`). The 38 orders where `minimal`
answered none_of_these on a resolvable line, 163 gold lines, same shortlists (top-k 8):

| | minimal | rich |
|---|---|---|
| Resolvable correct | 68.5% | **93.7%** |
| Resolvable answered none | 31.5% | 6.3% |
| Wrong-SKU picks | 0 | 0 |
| OOC → none / ambiguous → none | 100% / 84.6% | 100% / 92.3% |
| Input tokens (actual) | 57,796 | 68,703 |

`rich` = MRP plus up to 3 aliases specific to the SKU's variant (aliases shared by the whole family are left out); brand, variant
and pack size are already in the choice value. 36 lines fixed, 0 broken: "blue lays", "green lays", "lays green", "26G LAYS GEEN",
"cola", "hamam", "amul cheese". Still none: "rin surf", "tomato ketchup 200 gram", "cinthol", "perk", "odonil", "fortune oil 1 litre".
This set is selected for minimal's failures, so it overstates the gain on a random sample; the full effect needs a recalibration run
with `rich` (≈ 220k tokens ≈ ₹2) before it becomes the default. Done in milestone 4 (above).

**LLM fallback check** (`reports/fallback-check.json`, 14 synthetic lines the rules can't parse): 13/14 qty + unit correct; the miss
("four ladi") stayed `qty_missing` → review. First version scored 9/14 (model multiplied "two dozen" into 24, which the
written-number guard rejected, and left units like "bags"/"packets" unspecified); the prompt now says "count in the stated unit"
and a unit word in the text wins. 3 requests, 1,143 input + 463 output tokens, ≈ ₹0.02.

**M3 spend:** Decisions A/B 68,703 tokens ($0.00687) + fallback checks 3,095 tokens (two runs, $0.00048) = 71,798 tokens ≈ ₹0.65.

### Milestone 2: OpenAI calibration run, all 150 orders (14 Nov 2026, SYNTHETIC)

Settings: top-k 8, `minimal` choice descriptions, hard cap 200,000 input tokens (not hit). Threshold fitted on the dev split
(even orders, 170 eligible picks) with isotonic calibration and a 98% precision target: calibrated t = 0.917 (dev precision 100%).
Reported on the held-out test split (75 orders, 253 lines):

| | OpenAI gpt-6-luna | Mock (harness check) |
|---|---|---|
| Auto coverage at t | **58.1%** (147 lines) | 60.5% |
| Auto precision (product) / (product + qty + unit) | **100% / 100%** | 99.3% / 99.3% |
| Without the ambiguity rule | 60.1% coverage, 97.4% precision (4 ambiguous leaks) | 60.9%, 98.7% |
| If bare numbers had a default unit | 70.0% coverage, 99.4% precision | 73.9%, 99.5% |
| Orders fully auto and correct | 18.7% | 18.7% |
| Resolvable lines: correct / answered none / wrong SKU | 89.0% / 10.8% / 1 line | 99.3% / 0.2% / 2 |
| Out-of-catalog → none_of_these | 100% | 20% |
| Ambiguous → none_of_these | 87% (rest caught by the ambiguity rule) | 2.2% |
| Input tokens | **181,728 actual** (1,212 per order) | 138,390 estimated |
| Cost | **$0.0182 ≈ ₹1.60 total**, ≈ ₹10.7 per 1,000 orders | — |
| Runtime | 27 s for 150 orders, sequential | — |

Test-split review reasons (all lines): none_of_these 125, unit_unspecified 79, variant_ambiguous 5, pack_size_ambiguous 2.
Biggest coverage levers, in order: a distributor default for bare numbers (+12 pts), richer choice descriptions so shorthand
("blue lays", "lays green") isn't answered none (most of the 10.8%), then retailer history for ambiguous packs.
Saved decisions: `reports/eval-openai.decisions.jsonl` (re-score free with `npm run eval:openai:replay`).
Caveat: 147 auto lines with 0 errors bounds true precision only loosely (95% upper bound on error ≈ 2%). Synthetic aliases come from
the same lists as the catalog, so real orders will be harder.

### Milestone 1 results (top-k 20, full choice descriptions)
**Mock, all 150 orders (harness check only):** extraction 99.8% line recall, 100% qty/unit. Retrieval recall@1 99.8%, @20 100%.
Test split at the fitted t = 0.85: coverage 64.8%, auto precision 98.2%. About 2,700 estimated tokens per order, ≈ ₹24 per 1,000 orders.

**OpenAI Decisions smoke test (first 20 orders, 71 lines, 20 real requests), next to the mock on the same 20:**

| | Mock | OpenAI gpt-6-luna |
|---|---|---|
| Resolvable lines correct (56) | 100% | **100%** |
| Out-of-catalog → none_of_these (5) | 40% | **100%** |
| Ambiguous → none_of_these (10) | 10% | **40%** (the other 60% picked a defensible pack) |
| Coverage / auto precision at raw t = 0.8 (test half) | 61.1% / 100% | 58.3% / 95.2% |
| Coverage / auto precision at raw t = 0.9 (test half) | 58.3% / 100% | 50.0% / 100% |
| Input tokens | ~57,000 (estimated) | **70,759 actual** (3,538 per order, ~997 per line) |
| Cost | — | **$0.0071 total ≈ ₹0.62**. $0.00035 per order ≈ **₹31 per 1,000 orders** |
| Latency | — | ~280 ms per order (sequential) |

Caveats: 20 orders is far too few to fit a threshold. The isotonic fit put t at 1.0 because every dev pick happened to be correct, so read the raw sweep instead.
The data is synthetic, and its aliases come from the same lists as the catalog, so extraction and retrieval scores are optimistic. Real orders will be harder.

## 9. Four-week milestone plan
| Week | Deliverables | Exit check |
|---|---|---|
| 1 | Real catalog from one distributor, plus 200–300 real anonymised orders labelled through a tiny labelling script. Harden the extractor on the real data and add `LlmExtractor` for lines the rules can't parse. Replace the trigram stand-in with a real embedding model if lexical recall@20 < 97%. Manual-paste CLI/web. | Extraction ≥ 97% exact qty+unit, and retrieval recall@20 ≥ 98% on real data |
| 2 | OpenAI adapter on the real dev set: tune choice descriptions and instructions, run the option-order shuffle test and a rerun-consistency check, fit isotonic and threshold. Add the margin feature. | ≥ 98% auto precision at ≥ 60% line coverage on the test split |
| 3 | Review queue web UI (§7; API done in M2), alias learning loop, retailer-history prior ("same as last week", default pack size), Tally/Busy CSV export. | Reviewer handles a 6-line order in < 30 s, and corrections show up in the next run |
| 4 | Pilot with 1 distributor (manual paste, or the WhatsApp Business Cloud API webhook if approved). Jev adapter and an A/B on the same shortlists. Daily metrics report (coverage, precision from reviewer corrections, ₹/order). | One week of live orders, with a measured precision and coverage report |

## 10. Risks
- **Synthetic optimism.** Real messages carry slang, local brands and photos of handwritten lists. Image input exists in the API but is not planned for the MVP.
- **Ambiguity is a business-policy question,** not a model problem ("maggi 2 peti" usually means the retailer's usual pack). Retailer history is the fix.
- **Model drift and option-order sensitivity.** Pin the eval set, re-run it on every change, and keep the shuffle test.
- **Data.** Retailer messages contain phone numbers and names. Strip PII before sending, and look at Zero Data Retention if a distributor asks.

## 11. Open questions

Answered 14 Nov 2026 (see the status note at the top): vertical, catalog (none yet → synthetic), intake, unit policy, output target
(Google Sheet), accuracy bar (98%), LLM fallback (approved, rules-unparseable lines only), repo (`XLander03/constrained-choice`).

Answered in milestone 4: `rich` choice descriptions are the default after one recalibration run (₹1.90). Output for the MVP
is CSV export; Google Sheets stays off (adapter kept, inert/501 until a spreadsheet and service-account key are provided).

Still open:
1. Google Sheets, later: which spreadsheet, and a service-account key file once a Google Cloud project exists (not created by us).
2. A design-partner distributor for real orders and an item master (needed before any real-world accuracy claim).
