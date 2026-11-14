// Milestone 3: cheap LLM fallback for lines the rules extractor could not parse (qty === null) — and ONLY those.
// One structured-output request per order covering all such lines, behind its own token cap.
// Numbers are guarded: a qty the model returns must be visible in the raw text (digits or a number word), else ignored.
import type { ExtractedLine, IncomingOrder, OrderUnit } from "../types.ts";
import { redactSecrets } from "../decide/openai.ts";
import { NO_EXTRACTION_USAGE, UNIT_WORDS, type ExtractionUsage, type LineExtractor } from "./extractor.ts";

export interface LlmParsedLine { index: number; is_order_line: boolean; qty: number | null; unit: OrderUnit; item_text: string }
export interface LlmLineParser {
  /** Parse raw line texts; `context` is the full message. */
  parse(raws: string[], context: string): Promise<{ lines: LlmParsedLine[]; usage: ExtractionUsage }>;
}

export class LlmBudgetExceededError extends Error {}

export const LLM_UNITS: OrderUnit[] = ["pc", "dozen", "case", "strip", "unspecified"];
export const FALLBACK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["lines"],
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["index", "is_order_line", "qty", "unit", "item_text"],
        properties: {
          index: { type: "integer" },
          is_order_line: { type: "boolean" },
          qty: { type: ["number", "null"] },
          unit: { type: "string", enum: LLM_UNITS },
          item_text: { type: "string" },
        },
      },
    },
  },
} as const;

const SYSTEM = [
  "You extract order quantities from Indian FMCG retailer messages (Hindi/English mix).",
  "For each numbered line return: is_order_line (false for greetings, payment or delivery chatter),",
  "qty = the number written next to the unit word, counted in that unit ('two dozen' → qty 2 unit dozen, 'a dozen' → 1 dozen, 'four ladi' → 4 strip);",
  "never multiply out, and never use pack size (70g, 1kg) or price ('10 wala', 'rs 20') as qty.",
  "unit: case (peti, petti, box, carton, ctn, dabba, crate, bori, bora, bag), dozen (dzn, darjan), strip (ladi), pc (piece, packet, pkt, nos), unspecified (bare number).",
  "item_text = the product words without the quantity and unit. Use null qty if no quantity is stated.",
].join(" ");

const WORD_NUMS: Record<string, number> = {
  a: 1, an: 1, one: 1, ek: 1, two: 2, do: 2, three: 3, teen: 3, four: 4, char: 4, chaar: 4, five: 5, paanch: 5, panch: 5, six: 6, chhe: 6, che: 6,
  seven: 7, saat: 7, eight: 8, aath: 8, nine: 9, nau: 9, ten: 10, das: 10, eleven: 11, gyarah: 11, twelve: 12, barah: 12, fifteen: 15, pandrah: 15,
  twenty: 20, bees: 20, "twenty-five": 25, pachees: 25, thirty: 30, tees: 30, fifty: 50, pachas: 50, hundred: 100, sau: 100,
  half: 0.5, aadha: 0.5, adha: 0.5, dedh: 1.5, dhai: 2.5, couple: 2, pair: 2,
};
/** Is `qty` actually written in the text? Blocks a model from inventing quantities. */
export function qtySupportedByText(qty: number, raw: string): boolean {
  const t = raw.toLowerCase();
  if ([...t.matchAll(/\d+(?:\.\d+)?/g)].some(m => Number(m[0]) === qty)) return true;
  return t.split(/[^a-z-]+/).some(w => WORD_NUMS[w] === qty);
}

export function estimateTokens(text: string) { return Math.ceil(text.length / 3.5); }

/** OpenAI Chat Completions with strict JSON-schema output. Key is passed in, never logged. */
export class OpenAILlmLineParser implements LlmLineParser {
  private opts: { apiKey: string; model: string; inputPerMTokUsd: number; outputPerMTokUsd: number; tokenCap: number; maxOutputTokens: number; baseUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number };
  spentTokens = 0;
  constructor(opts: OpenAILlmLineParser["opts"]) { this.opts = opts; }
  async parse(raws: string[], context: string) {
    const user = `Full message:\n${context.slice(0, 2000)}\n\nLines to parse:\n${raws.map((r, i) => `${i}: ${r}`).join("\n")}`;
    const projected = estimateTokens(SYSTEM + user) + 150 + this.opts.maxOutputTokens;   // +150: schema/format overhead
    if (this.spentTokens + projected > this.opts.tokenCap)
      throw new LlmBudgetExceededError(`LLM fallback token cap: spent ${this.spentTokens}, next projected ${projected}, cap ${this.opts.tokenCap}`);
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "order_lines", strict: true, schema: FALLBACK_SCHEMA } },
      max_completion_tokens: this.opts.maxOutputTokens,
    };
    if (/^gpt-5/.test(this.opts.model)) body.reasoning_effort = "minimal";
    const r = await (this.opts.fetchFn ?? fetch)(`${this.opts.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20000),
    });
    if (!r.ok) throw new Error(`LLM fallback ${r.status}: ${redactSecrets((await r.text()).slice(0, 400))}`);
    const j = await r.json() as { choices: { message: { content: string | null; refusal?: string | null } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
    const inTok = j.usage?.prompt_tokens ?? 0, outTok = j.usage?.completion_tokens ?? 0;
    this.spentTokens += inTok + outTok;
    const usage: ExtractionUsage = { requests: 1, inputTokens: inTok, outputTokens: outTok, llmLines: 0,
      costUsd: (inTok * this.opts.inputPerMTokUsd + outTok * this.opts.outputPerMTokUsd) / 1e6 };
    const content = j.choices?.[0]?.message?.content;
    if (!content) return { lines: [], usage };
    let parsed: { lines?: LlmParsedLine[] };
    try { parsed = JSON.parse(content); } catch { return { lines: [], usage }; }
    return { lines: Array.isArray(parsed.lines) ? parsed.lines : [], usage };
  }
}

/** Unit word actually written in the line (peti, dozen, ladi, bags…), using the same vocabulary as the rules extractor. */
export function unitFromText(raw: string): OrderUnit | null {
  const found = raw.toLowerCase().split(/[^a-z]+/).map(w => UNIT_WORDS[w]).filter(Boolean);
  return found.length ? found[found.length - 1] : null;
}

/** Rules first; the LLM sees only lines whose quantity the rules couldn't find. Any LLM failure → keep the rules output (→ review). */
export class FallbackExtractor implements LineExtractor {
  private rules: LineExtractor; private llm: LlmLineParser;
  constructor(rules: LineExtractor, llm: LlmLineParser) { this.rules = rules; this.llm = llm; }
  async extract(order: IncomingOrder) { return (await this.extractDetailed(order)).lines; }
  async extractDetailed(order: IncomingOrder): Promise<{ lines: ExtractedLine[]; usage: ExtractionUsage }> {
    const lines = await this.rules.extract(order);
    const todo = lines.map((l, i) => ({ l, i })).filter(x => x.l.qty === null);
    if (!todo.length) return { lines, usage: NO_EXTRACTION_USAGE };
    let res: Awaited<ReturnType<LlmLineParser["parse"]>>;
    try { res = await this.llm.parse(todo.map(x => x.l.raw), order.text); }
    catch (e) { if (process.env.NODE_ENV !== "test") console.warn(`[llm-fallback] skipped: ${e instanceof Error ? e.message : e}`); return { lines, usage: NO_EXTRACTION_USAGE }; }
    // Lines the model calls "not an order line" are NOT dropped: losing a real item silently is worse than one extra review row.
    const out = [...lines]; let llmLines = 0;
    for (const p of res.lines) {
      const t = todo[p.index]; if (!t || typeof p !== "object") continue;
      if (p.is_order_line === false) continue;
      const qtyOk = typeof p.qty === "number" && p.qty > 0 && p.qty <= 10000 && qtySupportedByText(p.qty, t.l.raw);
      if (!qtyOk) continue;                                                 // stays qty_missing → review
      // Unit: a unit word written in the text wins (deterministic, same vocabulary as the rules); else the model's answer.
      const unit = unitFromText(t.l.raw) ?? (LLM_UNITS.includes(p.unit) ? p.unit : "unspecified");
      const item = typeof p.item_text === "string" && p.item_text.trim() ? p.item_text.trim().toLowerCase().slice(0, 200) : t.l.itemText;
      out[t.i] = { ...t.l, qty: p.qty, unit, itemText: item, extractor: "llm" }; llmLines++;
    }
    return { lines: out, usage: { ...res.usage, llmLines } };
  }
}
