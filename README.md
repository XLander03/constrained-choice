# decision-engine (build #1: distributor order → SKU lines)

Independent venture project. Not related to the Builders Cup or company roadmap. **All data is SYNTHETIC.**

```
npm install          # dev deps only (typescript, @types/node)
npm run eval         # full pipeline + eval on data/ with the MOCK decision adapter (no key, no cost)
node scripts/demo.ts "parle g 10 wala 2 peti, blue lays 20rs 1 box"
npm run typecheck
# later, once approved and OPENAI_API_KEY is set (paid):
npm run eval:openai
```

Node ≥ 22.18 runs the `.ts` files directly (type stripping), so there's no build step. See `SPEC.md` for the design.

| Path | What |
|---|---|
| `src/types.ts` | data model |
| `src/extract/extractor.ts` | stage 1: line splitter + qty/unit extractor (rules) |
| `src/retrieve/retriever.ts` | stage 2: BM25 + trigram-vector hybrid shortlist (top-k 20) |
| `src/decide/adapter.ts` | stage 3 interface + price table |
| `src/decide/openai.ts` | OpenAI Decisions API adapter (request builder, parser, fetch client) |
| `src/decide/mock.ts` | offline mock adapter (never sees gold labels) |
| `src/decide/jev.ts` | Jev placeholder |
| `src/route/*` | stage 4: isotonic calibration, threshold selection, router, JSONL review queue |
| `src/pipeline.ts` | wires the stages, one decision request per order |
| `src/eval/run.ts` | stage 5: eval harness → `reports/eval-<adapter>.json` |
| `scripts/` | synthetic data generators, demo |
