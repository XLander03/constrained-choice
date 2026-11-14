# Order desk (web)

The front end for decision-engine. It turns messy WhatsApp and email orders from kirana retailers into SKU order lines,
then lets a clerk review the flagged lines and export the approved order. It follows the contract in [`../API.md`](../API.md) (milestone 5, backend v0.5.0).

**All bundled data is SYNTHETIC**: the catalog, the retailers and the orders are invented.

## Run it

```bash
cd web
npm install
npm run dev          # http://localhost:5173, in-browser mock (no backend needed)
npm run build        # tsc -b (strict) + vite build → dist/
npm run typecheck    # tsc only
npm run preview      # serve dist/ at http://localhost:5174
```

**Open the UI at `http://localhost:5173` (dev) or `http://localhost:5174` (preview), not `http://127.0.0.1:…`.** The backend only
answers browser requests from the origins in `ALLOWED_ORIGINS` (default `http://localhost:5173,http://localhost:5174`), and
`127.0.0.1` is a different origin. `vite.config.ts` binds both servers to `localhost` for this reason. Opened anywhere else, the UI
shows "This address isn't allowed by the server" with a link to the localhost address.

Built and tested with Node v24.22.1 (Vite 7 needs Node 20.19+ or 22.12+).

## Mock or real API

The client is chosen at build/dev time by one variable:

| `VITE_API_BASE` | Client | Data |
|---|---|---|
| unset (default) | `MockClient` | Runs in the browser and persists to `localStorage` (`od.mock.v4`). Seeds 16 incoming messages and 4 approved orders from `../data/orders.jsonl`. |
| e.g. `http://localhost:8787` | `HttpClient` | The real backend (`cd .. && npm run serve`). Only origins in `ALLOWED_ORIGINS` are allowed. |

```bash
# terminal 1 (backend)
cd .. && npm run serve
# terminal 2 (UI against it)
VITE_API_BASE=http://localhost:8787 npm run dev     # then open http://localhost:5173
```

Use `DATA_DIR=/tmp/od-test npm run serve` to test against a throwaway data folder.

### API token

If the backend runs with `API_TOKEN` (16+ characters), every request needs it. The UI asks for the token at runtime after the first
`401`, and again if a later request is rejected. The dialog sits over the open screen, so review drafts survive. The token is kept in memory.
It goes to `sessionStorage` (`od.apiToken`) only if you tick "Remember for this browser tab". It's sent only as
`Authorization: Bearer …`. **Sidebar → Forget API token** clears it. The token never comes from a `VITE_*` variable and is never
in the bundle (`src/api/token.ts` doesn't read `import.meta.env`).

You can also put the value in `web/.env.local` (see `.env.example`). **Never put API keys or other secrets in `VITE_*` variables or
anywhere in this folder.** Everything here ships to the browser. The OpenAI key lives only in the backend's environment.

The sidebar footer shows which client is active ("In-browser mock" or "Live API") and the decision adapter
(`mock` is free; `openai` is paid). In mock mode, **Catalog → Reset demo data** restores the seed.

### How the mock works

The mock is a real implementation, not canned JSON. `src/api/mock/server.ts` is a port of `../src/server/app.ts`, and it imports
the backend's own modules from `../src`:

- the pipeline (`RulesExtractor`, `HybridRetriever`, `MockDecisionAdapter`, `processOrder`), with the same policy as the server:
  the `OverlapScorer` floor (`min_lexical_overlap`, 0.55 from `config/app.json`) and `MAX_LINES_PER_ORDER`
  (a `TooManyLinesError` maps to `422 too_many_lines`);
- the isotonic calibrator and threshold from `../reports/eval-mock.calibration.json`;
- the runtime defaults from `../config/app.json` (default unit, topK, descStyle, WhatsApp grouping);
- `catalogFromCsv`, the WhatsApp export parser, and `orderToCsv` / `unitsTotal`.

So routing, review reasons (including `low_overlap`), approve validation and warnings, `catalog_stale`, the all-or-nothing import
and the CSV bytes all match the server. It returns the same snake_case
JSON, and both clients go through `src/api/map.ts`, the only place that converts from the wire format to UI types.
`node:fs` and `node:crypto` are aliased to a small shim (`src/lib/node-shim.ts`); only pure functions are called.

This couples the web build to the backend tree. If the backend adds a top-level Node import, add the names to the shim.

## Screens

| Route | Screen |
|---|---|
| `/inbox` | Two tabs. **Paste** takes a message, retailer and channel, then parses it (Ctrl/Cmd+Enter); it has sample messages. **Import chat** takes a WhatsApp `.txt` export plus "your name in the chat" and grouping options, then shows a summary with skipped groups. The list beside them shows incoming, needs-review, ready and approved orders. |
| `/orders/:id/review` | **Review.** The original message on the left, with the current line highlighted, and the lines on the right. Flagged lines are amber, with reasons. The panel shows alternatives, with `ambiguous_with` packs first, and a catalog search. You also get the order value, the cost and the threshold. Approve stays disabled, with the reason shown, until every flagged line is decided. Once approved, the screen goes read-only and offers Download CSV and Send to Google Sheets. |
| `/approved` | Approved orders. Click a row to expand its lines; each row has a CSV download. |
| `/catalog` | Catalog CSV upload. It shows a client-side preview with the server's own parser: row errors, warnings, column mapping and a table. Then you confirm the replace. The examples cover Tally-style headers and a file with errors. |
| `/stats` | Computed from orders: auto-accepted %, lines reviewed and corrected, cost per order, review reasons, and line flow. |

## Errors and warnings

| Server says | UI |
|---|---|
| `401 unauthorized` | Token dialog (see above). |
| `403 origin_not_allowed` / `host_not_allowed` | Full-page "This address isn't allowed by the server", with the allowed origins. |
| `422 too_many_lines` | "Over 400 lines, split the order (this one has N)." No retry. |
| `422 no_product_lines` | Approve is disabled on orders with no product lines: "Nothing to approve: no product lines were found in this message". The inbox row says "Nothing to approve". |
| `502 decision_provider_error` / dropped connection | The only errors that offer **Retry**. |
| `catalog_stale: true` | An amber "Catalog changed" banner on review, plus a red **Not in current catalog** tag on lines with `sku_in_current_catalog: false`. |
| `approved.warnings` | A "Check before import" banner on the approved view, and the same per-line tag. |

Copy lives in `src/lib/errors.ts` (`describeError`).

**Chat import** sends the file as raw `text/plain; charset=utf-8`, with options in the query string. The size check before sending
measures the UTF-8 bytes of exactly that body against `/health.limits.max_body_bytes`. Imports are all-or-nothing: on a failure the
banner says "Import failed, nothing was saved." Groups over 400 lines are listed under skipped ("over 400 lines, split the order").

## Keyboard (review screen)

| Key | Action |
|---|---|
| `j` / `k` or `↓` / `↑` | Next / previous line (inside the alternatives panel: move the highlight) |
| `Enter` | Confirm the line (inside the panel: pick the highlighted option) |
| `a` or `Space` | Open / close the alternatives |
| `1`–`9` | Pick an alternative |
| `/` | Search the whole catalog |
| `0` or `x` | Not stocked (the line is sent as `sku_id: null` and exported as skipped) |
| `u` | Cycle the unit (pc / dozen / case / strip). Strip only appears for SKUs sold by the strip. |
| `e` | Edit the quantity. `+` / `-` step it. |
| `z` | Revert the line to the model's parse |
| `n` | Jump to the next flagged line |
| `Ctrl/Cmd + Enter` | Approve the order |
| `?` | Show all shortcuts |
| `Esc` | Close the panel or help |

A shortcut bar is always visible on desktop. Every action also works with the mouse and on narrow screens.

## Line badges

- **Which pack size? / Which variant? / Not found in catalog / Name doesn't match the product / Not sure / Quantity? / Unit?** are the review reasons (labels from API.md). Any reason flags the line.
- **assumed case**: the retailer wrote a bare number ("surf excel 4"), so the distributor default unit applies. It doesn't flag the line by itself.
- **AI-read qty**: the paid LLM fallback read this line because the rules couldn't (only with `DECISION_ADAPTER=openai`).
- The confidence meter shows the calibrated confidence with five bars and a %. It's green when the line was auto-accepted. It never relies on colour alone.

## Layout

```
src/
  api/        wire.ts (API.md JSON) · types.ts (UI types) · map.ts (wire→UI) · client.ts (interface)
              http.ts (fetch) · index.ts (VITE_API_BASE switch) · mock/ (server.ts port + mockClient.ts)
  app/        routes (typed paths), layout + sidebar, API/health context, theme
  screens/    InboxScreen, ImportChat, review/ (ReviewScreen, model.ts reducer, ApprovedView), ApprovedScreen, CatalogScreen, StatsScreen
  components/ loading / error-with-retry / empty states, confidence meter, badges
  lib/        domain (units, reason labels, formatting), stats, desk list, catalog preview, sample chat export
  styles.css  design tokens (light + dark via html[data-theme]), components, responsive rules (1180 / 900 / 760 px)
```

Dependencies: react, react-dom and react-router. No UI kit, state library or CSS framework.

## Contract notes and gaps

- **No intake queue endpoint.** The "New" messages in the inbox exist only in the mock. With the real API, orders arrive by paste or chat import.
- **`GET /orders`** now has `channel` and `text_preview`, which the inbox shows.
- **Alternatives carry no `case_qty`/`strip_qty`.** When you pick one, the UI fetches the full SKU through `GET /catalog?q=` so it can show amounts and validate strip.
- **No stats endpoint.** Stats are computed client-side from one `GET /orders?detail=1`.
- **No catalog dry-run.** The preview runs `catalogFromCsv` in the browser (the same code as the server). `POST /catalog` replaces the whole catalog and there's no restore endpoint.
- **Sheets** returns `501` until it's configured. The button is disabled, and `/health.sheets_status` is shown as its tooltip.
- **Token is shared, not per user.** `approved_by` still defaults to `reviewer`.
- **The `403 origin_not_allowed` response has no CORS headers**, so the browser can't read it. A blocked request looks like a network
  error. The UI infers the 403 when the page's origin isn't one of the default allowed origins. A server with a custom
  `ALLOWED_ORIGINS` that excludes 5173/5174 shows a network error naming `ALLOWED_ORIGINS` instead.
- **`/health` needs the token too**, so `auth_required` can't be read before the token is entered. The UI treats any `401` as "token needed".
- **Order value is at MRP** (`units_total × mrp_inr`), not distributor rates.
- Times from WhatsApp imports have no timezone. They're shown as local wall-clock time.

## Screenshots

`scripts/screenshots*.mjs` regenerate them. They need `playwright-core`, which isn't a dependency: install it in a scratch folder
and point `executablePath` at a local Chrome. `screenshots/` contains headless Chromium captures at 1440×900, plus dark mode and 400 px
variants.

- `scripts/screenshots-qa.mjs` takes the milestone 5 mock shots (`01`, `01d`, `01e`, `02`, `02d`, `02m`–`02o`, `03`, `03a`, `03b`, `05`)
  against `npm run dev`.
- `scripts/screenshots-access.mjs` takes `07-*` (token) and `08-*` (too_many_lines, origin blocked) against real backends:
  - `API_TOKEN=… npm run serve` on :8787, with `VITE_API_BASE=http://localhost:8787 npx vite --port 5174`;
  - `ALLOWED_ORIGINS=http://localhost:5173 PORT=8788` with `VITE_API_BASE=http://localhost:8788 npx vite --port 5175`.
- `06-*` are older captures from the milestone 3 HTTP API.
