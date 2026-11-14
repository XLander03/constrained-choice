# Order desk HTTP API (v0.5.1)

**Changes in v0.5.1:** the `403 origin_not_allowed` reply now carries `Access-Control-Allow-Origin: <request origin>` and
`Vary: Origin` (no credentials, methods or headers), so a page on a refused origin can read why; the request is still not
processed. `GET /health` answers without a token, returning only `ok`, `status`, `version`, `auth_required`, `limits` and
`adapter`, so a UI can learn `auth_required` before asking for the token. `/health` also gains `status` and `version`.

**Changes in milestone 5 (QA fixes; one breaking change: browser origins are now allow-listed):**
- **Security.** Only allow-listed browser origins may call the API (default `http://localhost:5173`, `http://localhost:5174`); any other
  `Origin` gets `403 origin_not_allowed` before anything is read or created, including on preflight. Optional bearer token
  (`API_TOKEN`), required when the server binds a non-loopback address. Without a token, only requests addressed to
  `localhost`/`127.0.0.1` are answered (`403 host_not_allowed`). See "Access control" below.
- **New errors:** `401 unauthorized`, `403 origin_not_allowed` / `host_not_allowed`, `400 bad_order_id` (an invalid `order_id` is
  no longer silently replaced), `422 too_many_lines` (over 400 product lines; was a retryable-looking `502`), `422 no_product_lines` on
  approving an order with no lines. Import with JSON `null` is now `400 bad_json` (was `500`).
- **New review reason `low_overlap`:** the picked SKU explains too little of what the retailer wrote (see field notes). New line fields
  `lexical_overlap` and `sku_in_current_catalog`; new order field `catalog_stale`; `approved.warnings`.
- **WhatsApp import is all-or-nothing:** if any group fails, nothing from that import is stored (safe to retry). A group with over
  400 lines is listed in `skipped` with `reason: "too_many_lines"` instead of failing the import.
- `GET /orders` items gain `channel`, `text_preview` and `source_kind`; `GET /orders?detail=1` returns full orders (one request for stats).
- `/health` gains `limits`, `min_lexical_overlap`, `auth_required`. `GET /catalog?limit=0` now clamps to 1.
- A request whose body isn't fully read (413, 401/403) is answered with `Connection: close`, so the next request doesn't hang.

**Changes in milestone 3 (additive, nothing removed):** `POST /orders/import/whatsapp`; new line fields `unit_defaulted` and
**Changes in milestone 3 (additive, nothing removed):** `POST /orders/import/whatsapp`; new line fields `unit_defaulted` and
`extracted_by`; new order fields `source` and `usage.llm_fallback`; `/health` gains `default_unit`, `llm_fallback`, `sheets_status`;
Sheets export is a real adapter (still `501` until configured) and can return `502 sheets_export_failed`.
Bare numbers ("maggi 5") now default to **case** (config), so `unit_unspecified` only appears if that default is switched off.

Plain JSON over HTTP, served by `node src/server/main.ts` (no framework, no build step). Default base URL: `http://127.0.0.1:8787`.
Binds `127.0.0.1` by default. See "Access control" for origins and the optional token.

**All bundled data is SYNTHETIC.** The confidence threshold was calibrated on the synthetic catalog and orders.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/health` | adapter, threshold, calibration file, catalog info |
| `POST` | `/orders/parse` | paste a WhatsApp/email order → lines with SKU, qty, unit, confidence, alternatives, `needs_review` |
| `POST` | `/orders/import/whatsapp` | upload a WhatsApp chat export (.txt) → one order per sender burst (or per message) |
| `GET` | `/orders` | list orders parsed since the server started (newest first): `order_id`, `status`, `created_at`, `retailer_id`, `channel`, `text_preview` (160 chars), `source_kind`, `summary`; `?detail=1` = full order objects |
| `GET` | `/orders/:id` | one order, same shape as the parse response |
| `POST` | `/orders/:id/approve` | reviewer decisions for flagged lines → approved order |
| `GET` | `/orders/:id/export.csv` | approved order as CSV (download) |
| `POST` | `/orders/:id/export/sheets` | append the approved order to the configured Google Sheet; `501` until configured |
| `POST` | `/catalog` | upload a catalog CSV (item master) that replaces the current one |
| `GET` | `/catalog?q=maggi&limit=20` | search the catalog (for the reviewer's "search all products" box) |

Server environment: `PORT` (8787), `HOST` (127.0.0.1), `DECISION_ADAPTER` (`mock` default, free; `openai` = paid, needs
`OPENAI_API_KEY`), `OPENAI_TOKEN_CAP` (100000 input tokens per server process, then `429`), `THRESHOLD` (override),
`ALLOWED_ORIGINS`, `API_TOKEN`, `DATA_DIR` (audit files; default `./var`), and the `config/app.json` overrides `DEFAULT_UNIT` (`case` default; `pc`, `dozen`, `strip`, or `none` = bare numbers
go to review), `SHEETS_SPREADSHEET_ID`, `SHEETS_SHEET_NAME`, `LLM_FALLBACK_ENABLED`, `LLM_FALLBACK_MODEL`, `LLM_FALLBACK_TOKEN_CAP`.
The paid LLM fallback runs only with `DECISION_ADAPTER=openai`, only for lines the rules can't parse, with its own token cap (20k per process).
State is in memory (orders are lost on restart). Audit files go to `var/` (gitignored): `review-queue.jsonl`,
`approved-orders.jsonl`, `catalog-uploaded.csv`.

## Access control

| Setting | Default | Effect |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. A non-loopback `HOST` (e.g. `0.0.0.0`) **refuses to start without `API_TOKEN`**. |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://localhost:5174` | Comma-separated exact origins (scheme://host:port) allowed from a browser. Requests from any other `Origin` → `403 origin_not_allowed`, reads and writes alike, before the body is read. That 403 echoes the origin in `Access-Control-Allow-Origin` (with `Vary: Origin`, no credentials) so the page can display it; a refused preflight is still a failed preflight. Requests without an `Origin` header (curl, scripts) are unaffected. `*` is only accepted together with `API_TOKEN`. `CORS_ORIGIN` is accepted as an alias. |
| `API_TOKEN` | unset | At least 16 characters. When set, every request except `OPTIONS` and a token-less `GET /health` needs `Authorization: Bearer <token>` or `X-API-Key: <token>`, else `401 unauthorized`. A wrong token is `401` on `/health` too. Never logged. |
| (no token) | | Only requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]` are answered (`403 host_not_allowed` otherwise), which blocks DNS-rebinding pages. |

The browser UI on `http://localhost:5173` needs no changes for local use. If it is opened as `http://127.0.0.1:5173`, add that origin.
For a shared deployment, set `API_TOKEN` and have the UI send it (it should come from the user, not from the UI bundle).

## Errors

Every error is JSON with a stable `code`:

```json
{ "error": { "code": "unresolved_lines", "message": "Some lines still need a decision.",
  "details": { "lines": [ { "line_id": "ord_demo1#1", "problem": "needs review (pack_size_ambiguous,low_confidence)" } ] } } }
```

| Status | `code` |
|---|---|
| 400 | `text_required`, `bad_json`, `bad_line`, `unknown_line`, `empty_catalog`, `bad_order_id` |
| 401 | `unauthorized` (`API_TOKEN` set, token missing or wrong; `GET /health` without a token is not an error) |
| 403 | `origin_not_allowed`, `host_not_allowed` |
| 404 | `order_not_found`, `not_found` |
| 409 | `order_exists`, `already_approved`, `not_approved` |
| 413 | `text_too_long` (20,000 chars), `body_too_large` (5 MB request body; the connection is closed after the reply), `too_many_orders` (WhatsApp import > 200 orders) |
| 422 | `unresolved_lines`, `invalid_catalog`, `no_messages` (not a WhatsApp export), `too_many_lines` (over 400 product lines in one order; `details: { lines, max_lines }`; split the order), `no_product_lines` (approve on an order with no lines) |
| 429 | `token_budget_exceeded` (paid adapter hit `OPENAI_TOKEN_CAP`) |
| 501 | `sheets_not_configured` (message says what's missing: sheet id, credentials env var, or credentials file) |
| 502 | `decision_provider_error` (Decisions API failed or timed out after 15 s; retrying can help), `sheets_export_failed` (Google returned an error) |

Limits (also in `/health.limits`): 5 MB request body, 20,000 characters of order text, 400 product lines per order, 200 orders per WhatsApp import.

## `POST /orders/parse`

Request (`Content-Type: application/json`). Only `text` is required.

```json
{
  "text": "Bhai order likho\nmaggi 70g 3 peti\nmaggi 2 peti\nred bull 250ml 1 peti",
  "channel": "whatsapp",
  "retailer_id": "raju-kirana",
  "order_id": "ord_demo1"
}
```

- `channel`: `whatsapp` | `email` | `manual` (default `manual`).
- `order_id`: optional, `[A-Za-z0-9_-]{1,64}`; generated (`ord_xxxxxxxx`) if omitted; `400 bad_order_id` if invalid; `409` if it already exists.
- `text`: up to 20,000 characters and 400 product lines (`413 text_too_long`, `422 too_many_lines`).

Response `201` (trimmed to one auto line and one review line; `alternatives` has up to 5 entries plus any `ambiguous_with` SKUs):

```json
{
  "order_id": "ord_demo1",
  "status": "parsed",
  "retailer_id": "raju-kirana",
  "channel": "whatsapp",
  "text": "Bhai order likho\nmaggi 70g 3 peti\nmaggi 2 peti\nred bull 250ml 1 peti",
  "created_at": "2026-11-14T08:13:49.249Z",
  "adapter": "mock",
  "catalog_version": "syn-mwg4pujx",
  "threshold": 0.9858,
  "summary": { "lines": 3, "auto": 1, "needs_review": 2 },
  "usage": { "requests": 1, "input_tokens": 841, "cost_usd": 0.0000841, "cost_inr_at_88": 0.0074 },
  "lines": [
    {
      "line_id": "ord_demo1#0", "line_no": 1, "raw": "maggi 70g 3 peti", "item_text": "maggi 70g",
      "qty": 3, "unit": "case", "size_hint": { "value": 70, "unit": "g" }, "price_hint": null,
      "sku": { "sku_id": "SKU0034", "label": "Nestle Maggi 2-Minute Noodles Masala 70g", "brand": "Nestle",
               "product": "Maggi 2-Minute Noodles", "variant": "Masala", "pack_size": 70, "pack_unit": "g",
               "mrp_inr": 14, "case_qty": 96, "strip_qty": null },
      "none_of_these": false,
      "confidence": 0.9943, "calibrated_confidence": 0.9858,
      "needs_review": false, "review_reasons": [], "ambiguous_with": [],
      "alternatives": [
        { "sku_id": "SKU0036", "label": "Nestle Maggi 2-Minute Noodles Masala 560g", "none_of_these": false, "p": 0.0021, "mrp_inr": 112 },
        { "sku_id": "SKU0033", "label": "Nestle Maggi 2-Minute Noodles Masala 32g", "none_of_these": false, "p": 0.0011, "mrp_inr": 7 }
      ]
    },
    {
      "line_id": "ord_demo1#1", "line_no": 2, "raw": "maggi 2 peti", "item_text": "maggi",
      "qty": 2, "unit": "case", "size_hint": null, "price_hint": null,
      "sku": { "sku_id": "SKU0036", "label": "Nestle Maggi 2-Minute Noodles Masala 560g", "...": "..." },
      "none_of_these": false,
      "confidence": 0.3441, "calibrated_confidence": 0,
      "needs_review": true, "review_reasons": ["pack_size_ambiguous", "low_confidence"],
      "ambiguous_with": ["SKU0033", "SKU0034", "SKU0035", "SKU0036"],
      "alternatives": [
        { "sku_id": "SKU0033", "label": "Nestle Maggi 2-Minute Noodles Masala 32g", "none_of_these": false, "p": 0.1966, "mrp_inr": 7 },
        { "sku_id": "SKU0035", "label": "Nestle Maggi 2-Minute Noodles Masala 280g", "none_of_these": false, "p": 0.1489, "mrp_inr": 56 },
        { "sku_id": "SKU0034", "label": "Nestle Maggi 2-Minute Noodles Masala 70g", "none_of_these": false, "p": 0.1198, "mrp_inr": 14 }
      ]
    }
  ],
  "approved": null
}
```

Field notes:
- `unit`: `pc` | `dozen` | `case` (peti, box, dabba, ctn, crate, bori, bora, bag) | `strip` (ladi) | `unspecified` (bare number,
  only when the default unit is switched off).
- `unit_defaulted: true` means the retailer wrote a bare number and the unit came from the distributor default (case). Show it as
  "assumed case" so the reviewer can glance at it; it does not by itself send the line to review.
- `extracted_by`: `rules` or `llm` (the paid fallback parsed a line the rules couldn't, e.g. "maggi 70g three boxes").
- `qty` can be `null` (no quantity found) → `review_reasons` contains `qty_missing`.
- `sku` is `null` when the model answered none of these (`none_of_these: true`). `alternatives` still lists the shortlist.
- `alternatives[].none_of_these: true` (with `sku_id: null`) is the model's "not in the list" option and its probability.
- `confidence` is the provider's raw number; `calibrated_confidence` is the estimated probability the pick is right
  (isotonic fit on the dev split). Routing compares `calibrated_confidence` to `threshold`.
- `review_reasons` (any → `needs_review: true`): `none_of_these`, `refused`, `qty_missing`, `unit_unspecified`,
  `pack_size_ambiguous` (the line doesn't say which pack), `variant_ambiguous` (doesn't say which variant), `low_confidence`,
  `low_overlap` (the picked SKU's names and aliases cover less than `min_lexical_overlap`, default 0.55, of the line's words,
  weighted by rarity; e.g. "red bull 250ml" vs Red Label Tea. Applies to every adapter).
- `lexical_overlap`: that share (0–1), or `null` when there is no pick or no product words to judge.
- `sku_in_current_catalog`: `false` when the catalog was replaced after parsing and no longer has this SKU. `catalog_stale` (order
  level) is `true` whenever the order was parsed on an older catalog version.
- `ambiguous_with`: SKUs that all fit the line equally; the UI should offer exactly these first.
- `source`: `{ "kind": "paste" }`, or for imports `{ "kind": "whatsapp_export", "import_id", "sender", "first_at", "last_at", "message_count", "first_line" }`.
- `usage.llm_fallback`: `null`, or `{ requests, input_tokens, output_tokens, lines, cost_usd }` when the fallback ran; `usage.cost_*` includes it.

## `POST /orders/import/whatsapp`

Upload the `.txt` from WhatsApp → chat → More → Export chat → *Without media*. Send it as the raw body (`Content-Type: text/plain`,
options in the query string) or as JSON. Both Android (`14/11/26, 9:05 am - Name: text`, 12h or 24h) and iOS
(`[14/11/26, 9:05:12 AM] Name: text`) layouts work, including multi-line messages; system notices, `<Media omitted>`, "image omitted",
deleted messages and `<This message was edited>` are dropped.

| Option | Default | Meaning |
|---|---|---|
| `group` | `burst` | `burst` = consecutive messages from one sender, each within `burst_minutes` of the previous, form one order; `message` = one order per message |
| `burst_minutes` | 15 | gap that ends a burst; a message from anyone else also ends it |
| `exclude_senders` | none | the distributor's own name(s), so replies like "ok bhai" aren't parsed (array in JSON, comma-separated in the query) |
| `date_order` | `auto` | `dmy` / `mdy`; auto looks for a day > 12 anywhere in the file and falls back to `dmy` |

```http
POST /orders/import/whatsapp?exclude_senders=Sharma%20Distributors
Content-Type: text/plain

14/11/26, 9:05 am - Raju Kirana: maggi 5
lux pink 100g 2 box
14/11/26, 9:06 am - Raju Kirana: jaldi bhejna
14/11/26, 9:30 am - Sharma Distributors: ok bhai
```

Response `201`. Each order has exactly the parse-response shape, with `channel: "whatsapp"`, `retailer_id` = sender name and
`created_at` = first message time (exports have no timezone, so times are local wall-clock without `Z`). Groups with no product
lines are listed in `skipped` instead of becoming orders; so are groups over 20,000 characters (`text_too_long`) or 400 lines
(`too_many_lines`). **All-or-nothing:** if the decision provider fails on any group, the import returns the error with
`details: { import_id, failed_group, orders_saved: 0 }` and stores nothing, so retrying can't create duplicates. Send the file as
`text/plain`: JSON-escaping can push a 4.9 MB export over the 5 MB body limit.

```json
{
  "import_id": "wa_f69050da", "format": "android", "date_order": "dmy", "group": "burst", "burst_minutes": 15,
  "messages": 2, "system_lines": 0, "media_skipped": 0,
  "summary": { "orders": 1, "skipped": 0, "lines": 2, "auto": 1, "needs_review": 1, "cost_inr_at_88": 0.00507 },
  "orders": [ { "order_id": "wa_f69050da_1", "status": "parsed", "retailer_id": "Raju Kirana", "channel": "whatsapp",
                "source": { "kind": "whatsapp_export", "import_id": "wa_f69050da", "sender": "Raju Kirana",
                            "first_at": "2026-11-14T09:05:00", "last_at": "2026-11-14T09:06:00", "message_count": 2, "first_line": 1 },
                "lines": [ { "line_id": "wa_f69050da_1#0", "raw": "maggi 5", "qty": 5, "unit": "case", "unit_defaulted": true,
                             "extracted_by": "rules", "needs_review": true, "review_reasons": ["pack_size_ambiguous", "low_confidence"], "...": "..." } ],
                "...": "..." } ],
  "skipped": [ { "sender": "Raju Kirana", "at": "2026-11-14T14:20:00", "reason": "no_product_lines", "text": "jaldi bhejna" } ]
}
```

Errors: `422 no_messages` (not an export), `413 too_many_orders` (over 200 candidate orders), `429`/`502` as for parse.
Each created order is also available at `GET /orders/:id` and is approved/exported individually.

## `POST /orders/:id/approve`

Lines **not** listed are approved as parsed, but only if they don't need review; every `needs_review` line must be listed.
Listed lines override the model:

```json
{
  "approved_by": "ramesh",
  "lines": [
    { "line_id": "ord_demo1#1", "sku_id": "SKU0034", "qty": 2, "unit": "case" },
    { "line_id": "ord_demo1#2", "sku_id": null }
  ]
}
```

- `sku_id: null` = not stocked / skip; it's exported with `status: "skipped"`.
- `qty` and `unit` are optional and default to the parsed values. A kept line needs `qty > 0` and a unit in `pc|dozen|case|strip`
  (so an `unspecified` unit must be set here).
- `422 unresolved_lines` lists each line that still needs a decision or has a bad value. `409 already_approved` on a second call.
  `422 no_product_lines` for an order with no lines.
- If the catalog was replaced since parsing, approval still succeeds but `approved.warnings` lists
  `{ line_id, code: "sku_not_in_current_catalog", sku_id, message }` for SKUs the current catalog doesn't have.

Response `200`: the full order (as in parse) with `status: "approved"` and:

```json
"approved": {
  "order_id": "ord_demo1", "approved_by": "ramesh", "approved_at": "2026-11-14T08:13:54.954Z",
  "lines": [
    { "line_id": "ord_demo1#0", "line_no": 1, "status": "ok", "sku_id": "SKU0034", "label": "Nestle Maggi 2-Minute Noodles Masala 70g",
      "qty": 3, "unit": "case", "units_total": 288, "mrp_inr": 14, "source": "auto" },
    { "line_id": "ord_demo1#1", "line_no": 2, "status": "ok", "sku_id": "SKU0034", "label": "Nestle Maggi 2-Minute Noodles Masala 70g",
      "qty": 2, "unit": "case", "units_total": 192, "mrp_inr": 14, "source": "reviewed" },
    { "line_id": "ord_demo1#2", "line_no": 3, "status": "skipped", "sku_id": null, "label": "",
      "qty": 1, "unit": "case", "units_total": null, "mrp_inr": null, "source": "reviewed" }
  ]
}
```

`units_total` converts to selling units: case × `case_qty`, dozen × 12, strip × `strip_qty`, pc × 1.

## `GET /orders/:id/export.csv`

`200 text/csv` with `Content-Disposition: attachment; filename="<order_id>.csv"`; `409 not_approved` before approval.

```csv
order_id,retailer_id,line_no,status,sku_id,product,qty,unit,units_total,mrp_inr,source,raw_text,approved_by,approved_at
ord_demo1,raju-kirana,1,ok,SKU0034,Nestle Maggi 2-Minute Noodles Masala 70g,3,case,288,14,auto,maggi 70g 3 peti,ramesh,2026-11-14T08:13:54.954Z
ord_demo1,raju-kirana,2,ok,SKU0034,Nestle Maggi 2-Minute Noodles Masala 70g,2,case,192,14,reviewed,maggi 2 peti,ramesh,2026-11-14T08:13:54.954Z
ord_demo1,raju-kirana,3,skipped,,,1,case,,,reviewed,red bull 250ml 1 peti,ramesh,2026-11-14T08:13:54.954Z
```

Cells starting with `= + - @` are prefixed with `'` so spreadsheet apps don't treat them as formulas.

## `POST /orders/:id/export/sheets`

Appends the approved order's rows (same columns as the CSV; a header row is written first if the tab is empty) to the configured
Google Sheet, using a service account. Until it's set up (see README, "Google Sheets setup") it returns
`501 sheets_not_configured` with the missing piece in `message`. `/health` reports `sheets_export_configured` and `sheets_status`.

```json
{ "location": "https://docs.google.com/spreadsheets/d/<sheet id>", "updatedRange": "Orders!A1:N4", "rows": 4 }
```

## `POST /catalog`

Send the CSV as the raw body with `Content-Type: text/csv` (e.g. `fetch(url, { method: "POST", body: file })`), or as JSON
`{ "csv": "..." }`. Max 5 MB. The new catalog replaces the old one only if it's valid.

Columns are matched case-insensitively with common synonyms (Tally/Busy/Marg exports usually work as-is):

| Field | Required | Accepted headers |
|---|---|---|
| SKU id | yes | `sku_id`, `sku`, `item_code`, `code`, `item_id`, `id`, `product_code` |
| Product name | yes | `product`, `item_name`, `name`, `product_name`, `description`, `item` |
| Brand / variant | no | `brand`, `manufacturer`, `company` / `variant`, `flavour`, `colour`, `type` |
| Pack size / unit | no (read from the name, e.g. "Maggi 70g") | `pack_size`, `size`, `weight` / `pack_unit`, `uom`, `unit` |
| MRP | no, but helps "10 wala" matching | `mrp_inr`, `mrp`, `price`, `rate` |
| Units per case | no (default 1, with a warning) | `case_qty`, `units_per_case`, `case_size`, `conversion` |
| Units per strip, category, aliases (`|`-separated) | no | `strip_qty` / `category`, `group` / `aliases`, `synonyms`, `keywords` |

Request:

```http
POST /catalog
Content-Type: text/csv

Item Code,Item Name,Brand,MRP,Units per case
K1,Kurkure Masala Munch 90g,PepsiCo,20,60
K2,Kurkure Masala Munch 40g,PepsiCo,10,120
```

Response `200`:

```json
{
  "source": "uploaded", "version": "up-mwg4x1a2", "sku_count": 2, "loaded_at": "2026-11-14T08:20:00.000Z", "data_label": "UPLOADED",
  "warnings": ["no pack_size column: pack size will be read from the product name when possible"],
  "columns": { "sku_id": "Item Code", "product": "Item Name", "brand": "Brand", "variant": null, "pack_size": null,
               "pack_unit": null, "mrp_inr": "MRP", "case_qty": "Units per case", "strip_qty": null, "category": null, "aliases": null },
  "note": "Confidence threshold was calibrated on the synthetic catalog; re-run calibration on labelled orders for this catalog before trusting auto-accept."
}
```

Response `422 invalid_catalog`: `details.errors` (up to 50, e.g. `"row 7: duplicate SKU id A12"`, or `"row 5: 6 fields but the header
has 5; quote fields that contain commas or quotes"`), `details.warnings` (e.g. rows with fewer fields than the header), `details.columns`.

## `GET /catalog?q=&limit=`

`limit` 1–50 (default 20; out-of-range values are clamped). Without `q` it returns the first items. Response: catalog info plus `items: [ <sku object as in parse> ]`.

## `GET /health`

No token needed. When `API_TOKEN` is set and the request has no token, only the public subset is returned:

```json
{ "ok": true, "status": "ok", "version": "0.5.1", "auth_required": true, "adapter": "mock",
  "limits": { "max_body_bytes": 5242880, "max_order_chars": 20000, "max_lines_per_order": 400 } }
```

With the right token, or when no token is configured (loopback-only), the full object:

```json
{ "ok": true, "status": "ok", "version": "0.5.1", "adapter": "mock", "threshold": 0.8333, "top_k": 8, "default_unit": "case", "allow_unspecified_unit": false, "llm_fallback": false,
  "calibration": { "file": "reports/eval-mock.calibration.json", "data_label": "SYNTHETIC", "target_precision": 0.98, "threshold": 0.9858 },
  "catalog": { "source": "synthetic", "version": "syn-mwg4ohhj", "sku_count": 299, "loaded_at": "2026-11-14T08:12:44.551Z", "data_label": "SYNTHETIC" },
  "sheets_export_configured": false, "sheets_status": "no spreadsheet id (config sheets.spreadsheetId or env SHEETS_SPREADSHEET_ID)",
  "limits": { "max_body_bytes": 5242880, "max_order_chars": 20000, "max_lines_per_order": 400 }, "min_lexical_overlap": 0.55, "auth_required": false }
```

---

# UI requirements (for the UI build)

Audience: a distributor's order clerk on a laptop, often with the WhatsApp Web tab beside it. Goal: a 6-line order handled in under
30 s, with review lines taking under 5 s each. Desktop first; a usable narrow layout is a bonus. Keep it calm and dense, like a good
inbox, not a dashboard.

## Screens

1. **Paste order** (home). Also an **Import WhatsApp chat** action: drop a `.txt` export, optional "your name in the chat"
   (→ `exclude_senders`), then show the import summary (orders created, skipped groups with reason) and list the new orders.
   Paste: A large textarea ("Paste a WhatsApp or email order"), optional retailer field, channel toggle
   (WhatsApp / Email / Manual), "Parse" button (Ctrl/Cmd+Enter). A banner shows when data is synthetic (`/health` →
   `catalog.data_label`) and which adapter is live (mock = free demo, openai = paid).
2. **Order review** (after parse; also `GET /orders/:id`). Two panes: original message on the left with the line being reviewed
   highlighted (`raw` text), parsed lines on the right as rows: line no, raw text, product label, qty + unit, confidence, status.
   - Auto lines: green/neutral, collapsed, still editable.
   - Review lines: amber, expanded, with human-readable reasons: `pack_size_ambiguous` → "Which pack size?",
     `variant_ambiguous` → "Which variant?", `none_of_these` → "Not found in catalog", `low_confidence` → "Not sure",
     `unit_unspecified` → "Unit? (pc / dozen / case / strip)", `qty_missing` → "Quantity?".
   - Lines with `unit_defaulted: true` get a small "assumed case" badge (not amber). Lines with `extracted_by: "llm"` can show a
     subtle "AI-read qty" marker.
   - Header summary: "4 lines · 3 auto · 1 to review", order cost in ₹ (`usage.cost_inr_at_88`), Approve button disabled
     until every review line is decided.
3. **Approved** state of the same screen: read-only rows with `units_total`, "Download CSV" (`/orders/:id/export.csv`),
   "Send to Google Sheets" (disabled with `/health.sheets_status` as the tooltip while `sheets_export_configured` is false;
   on success link to `location`), "New order".
4. **Orders list** (`GET /orders`): order id, retailer, time, lines/auto/review counts, status chip. Click opens the order.
5. **Catalog** (`GET/POST /catalog`): current source (synthetic/uploaded), SKU count, loaded time; CSV upload (drag-and-drop +
   file picker); on `422` show the row errors list; on `200` show detected column mapping + warnings and the calibration note.
   A search box over the catalog is a nice extra.

## Review interaction (the core of the product)

- A review row shows the model's pick plus **one-tap chips** for the options: `ambiguous_with` SKUs first (all packs/variants
  that fit), then `alternatives` by probability, each with label, pack and ₹MRP. A "None / not stocked" chip sends `sku_id: null`.
  A "Search catalog…" dropdown (`GET /catalog?q=`) covers anything not offered.
- Qty stepper and unit toggle (pc / dozen / case / strip) are on every row; required when the unit is `unspecified`.
- "Confirm" accepts the model's pick as-is (send it as an override so it's logged as reviewed).
- Keyboard first: J/K move between lines, 1–5 pick a chip, 0 = none, Enter confirms the row, Ctrl/Cmd+Enter approves the order.
  Focus jumps to the next unresolved line after each decision.
- Approve sends `POST /orders/:id/approve` with only the lines the reviewer touched (every review line must be included).
  On `422`, scroll to and highlight the listed lines with their `problem` text.

## States to design

Empty (no orders yet), parsing (spinner on the button; the paid adapter takes ~0.2–0.5 s per order), parse error (`502`
provider error, `429` budget hit, `413` too long), order with 0 lines found ("No product lines found, check the paste"),
all-auto order (one-click approve), order with only review lines, already approved (`409`), catalog upload success / invalid,
Sheets not configured / Sheets export failed (`502`), WhatsApp import with skipped groups or `422 no_messages`.
Show "SYNTHETIC DATA" clearly whenever the synthetic catalog is loaded.

Milestone 5 additions: `low_overlap` → "Name doesn't match the product"; `422 too_many_lines` → "Over 400 lines, split the order"
(not retryable); `502` is the only retryable parse error; `401 unauthorized` → ask for the API token; `403 origin_not_allowed` →
"This UI's address isn't allowed by the server (ALLOWED_ORIGINS)"; `catalog_stale` / `sku_in_current_catalog: false` → a warning on the
order and line; `approved.warnings` after approval.
