# Decision Engine, build #1: distributor order → SKU order lines

Status: groundwork (14 Nov 2026). Independent venture project, separate from the Builders Cup and from the company roadmap.
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
  E -->|low confidence, none_of_these,<br/>qty or unit missing| G[Review queue]
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
function routeLine(line, candidates, decision, calibrator, policy: { threshold: number; allowUnspecifiedUnit: boolean }): ResolvedLine
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
- Planned: an `LlmExtractor` (cheap model with structured output) that runs only on lines the rules couldn't parse.

### Stage 2: retrieval (`HybridRetriever`)
BM25 runs over brand, product, variant, size, MRP and aliases. A char-trigram cosine (typo-tolerant, local and free) stands in for real
embeddings behind `EmbeddingProvider`. The two are fused with reciprocal-rank fusion (k = 60), then size-hint and price-hint matches get a boost.
Default top-k is 20, and the API allows up to 254 + NONE.

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
4. Report on the held-out **test** split (odd orders). Re-fit monthly, or whenever the catalog, prompt or model changes.
5. Hard rules, applied whatever the confidence: `none_of_these`, refusal, missing qty, or an `unspecified` unit (unless the distributor sets a default) → review.
6. Planned extras: a margin feature (p1 − p2), shuffling candidate order across 2 runs for borderline lines (option order is known to move results), and per-category thresholds.

## 7. Review queue UX (MVP outline)
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

### Results so far
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
| 3 | Review queue web UI (§7), alias learning loop, retailer-history prior ("same as last week", default pack size), Tally/Busy CSV export. | Reviewer handles a 6-line order in < 30 s, and corrections show up in the next run |
| 4 | Pilot with 1 distributor (manual paste, or the WhatsApp Business Cloud API webhook if approved). Jev adapter and an A/B on the same shortlists. Daily metrics report (coverage, precision from reviewer corrections, ₹/order). | One week of live orders, with a measured precision and coverage report |

## 10. Risks
- **Synthetic optimism.** Real messages carry slang, local brands and photos of handwritten lists. Image input exists in the API but is not planned for the MVP.
- **Ambiguity is a business-policy question,** not a model problem ("maggi 2 peti" usually means the retailer's usual pack). Retailer history is the fix.
- **Model drift and option-order sensitivity.** Pin the eval set, re-run it on every change, and keep the shuffle test.
- **Data.** Retailer messages contain phone numbers and names. Strip PII before sending, and look at Zero Data Retention if a distributor asks.

## 11. Open questions for the user
1. **Target vertical and first distributor:** FMCG/kirana as modelled here, or pharma, auto parts or building materials? Is there a distributor you can get as the week-1 design partner?
2. **Real catalog:** do you or the partner have an item master (Tally, Busy or Marg export)? And roughly 200 past WhatsApp orders, with their invoices, that we can label?
3. **Intake for the MVP:** manual paste or WhatsApp export first (zero setup), or the WhatsApp Business Cloud API (needs a Meta business account, number verification and per-conversation fees)?
4. **Unit policy:** what does a bare number mean ("maggi 5"): cases or pieces? And do bori, crate and bag map to case? This is per distributor.
5. **Output target:** which system should approved orders land in (Tally, Busy, Marg, a DMS, a Google Sheet)?
6. **Repo:** name and visibility (suggestion: private `decision-engine` or `orderdesk` under your GitHub account or an org)?
7. **Accuracy bar:** is 98% auto-precision the right target, or would a distributor rather have 99.5% precision with more lines going to review?
8. **Extraction fallback LLM:** OK to use a cheap structured-output model (for example an OpenAI mini model) only for lines the rules can't parse? It's paid, but small.
