import assert from "node:assert/strict";
import { test } from "node:test";
import { RulesExtractor } from "../src/extract/extractor.ts";
import { FallbackExtractor, OpenAILlmLineParser, qtySupportedByText, type LlmLineParser } from "../src/extract/llmFallback.ts";
import { catalog } from "./helpers.ts";

const rules = new RulesExtractor(catalog);
const order = (text: string) => ({ orderId: "F", channel: "whatsapp" as const, text });
const fake = (answer: (raws: string[]) => object[]): LlmLineParser & { calls: string[][] } => {
  const calls: string[][] = [];
  return { calls, async parse(raws) { calls.push(raws); return { lines: answer(raws) as any, usage: { requests: 1, inputTokens: 100, outputTokens: 20, costUsd: 0.00001, llmLines: 0 } }; } };
};

test("only lines the rules can't parse go to the LLM", async () => {
  const llm = fake(raws => raws.map((_, index) => ({ index, is_order_line: true, qty: 3, unit: "case", item_text: "maggi 70g" })));
  const { lines, usage } = await new FallbackExtractor(rules, llm).extractDetailed(order("parle g 10 wala 2 peti\nmaggi 70g three boxes"));
  assert.deepEqual(llm.calls, [["maggi 70g three boxes"]]);
  assert.deepEqual([lines[1].qty, lines[1].unit, lines[1].extractor], [3, "case", "llm"]);
  assert.equal(lines[0].extractor, "rules"); assert.equal(usage.llmLines, 1);
});

test("no LLM call when the rules parse everything", async () => {
  const llm = fake(() => []);
  await new FallbackExtractor(rules, llm).extract(order("maggi 70g 3 peti"));
  assert.equal(llm.calls.length, 0);
});

test("invented quantities are rejected; unit word in the text wins", async () => {
  const llm = fake(() => [{ index: 0, is_order_line: true, qty: 24, unit: "pc", item_text: "dettol soap 75g" },
                          { index: 1, is_order_line: true, qty: 20, unit: "unspecified", item_text: "tata salt 1kg" }]);
  const { lines } = await new FallbackExtractor(rules, llm).extractDetailed(order("dettol soap 75g two dozen\ntata salt 1kg twenty bags"));
  assert.equal(lines[0].qty, null);                     // 24 is not written anywhere → stays for review
  assert.deepEqual([lines[1].qty, lines[1].unit], [20, "case"]);   // "bags" = case (distributor policy)
  assert.equal(qtySupportedByText(1, "parle g - a dozen"), true);
  assert.equal(qtySupportedByText(12, "parle g - a dozen"), false);
});

test("LLM failure keeps the rules output (line goes to review)", async () => {
  const llm: LlmLineParser = { async parse() { throw new Error("boom"); } };
  const lines = await new FallbackExtractor(rules, llm).extract(order("maggi 70g three boxes"));
  assert.equal(lines[0].qty, null);
});

test("OpenAI parser: strict json_schema request, token cap enforced before calling, no key in errors", async () => {
  const bodies: any[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: [{ index: 0, is_order_line: true, qty: 3, unit: "case", item_text: "maggi" }] }) } }],
      usage: { prompt_tokens: 300, completion_tokens: 40 } }), { status: 200 });
  }) as typeof fetch;
  const p = new OpenAILlmLineParser({ apiKey: "test-key", model: "gpt-5-nano", inputPerMTokUsd: 0.05, outputPerMTokUsd: 0.4, tokenCap: 1200, maxOutputTokens: 600, fetchFn });
  const r = await p.parse(["maggi three boxes"], "maggi three boxes");
  assert.equal(bodies[0].response_format.type, "json_schema");
  assert.equal(bodies[0].response_format.json_schema.strict, true);
  assert.equal(r.usage.inputTokens, 300); assert.equal(r.lines[0].qty, 3);
  await assert.rejects(() => p.parse(["x"], "x"), /token cap/);      // 340 spent + ~970 projected > 1200 cap
  assert.equal(bodies.length, 1);
  const failing = new OpenAILlmLineParser({ apiKey: "k", model: "gpt-5-nano", inputPerMTokUsd: 0, outputPerMTokUsd: 0, tokenCap: 99999, maxOutputTokens: 10,
    fetchFn: (async () => new Response("Incorrect API key provided: " + ["sk", "proj", "FAKEFAKE0000"].join("-"), { status: 401 })) as typeof fetch });
  await assert.rejects(() => failing.parse(["x"], "x"), (e: Error) => !/FAKEFAKE/.test(e.message));
});
