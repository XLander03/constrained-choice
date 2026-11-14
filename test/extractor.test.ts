import assert from "node:assert/strict";
import { test } from "node:test";
import { RulesExtractor } from "../src/extract/extractor.ts";
import { catalog } from "./helpers.ts";

const ex = new RulesExtractor(catalog);
const run = async (text: string) => ex.extract({ orderId: "T", channel: "whatsapp", text });

test("splits a WhatsApp message into lines and drops chatter", async () => {
  const lines = await run("Bhai order likho\nparle g 10 wala 2 peti\nblue lays 20rs 1 box\njaldi bhejna");
  assert.deepEqual(lines.map(l => [l.qty, l.unit]), [[2, "case"], [1, "case"]]);
});

test("price ('10 wala') and size ('70g') are hints, never the quantity", async () => {
  const [a] = await run("parle g 10 wala 2 peti");
  assert.equal(a.priceHint, 10); assert.equal(a.qty, 2);
  const [b] = await run("maggi 70g 3 peti");
  assert.deepEqual(b.sizeHint, { value: 70, unit: "g" }); assert.equal(b.qty, 3);
});

test("Hindi number words and unit vocabulary", async () => {
  const [l] = await run("do dozen good day");
  assert.equal(l.qty, 2); assert.equal(l.unit, "dozen");
  const [s] = await run("clinic plus 10 ladi");
  assert.equal(s.unit, "strip");
});

test("last qty+unit wins when the pack also has a count", async () => {
  const [l] = await run("whisper XL 20 pcs 3 pkt");
  assert.equal(l.qty, 3); assert.equal(l.unit, "pc");
});

test("bare number becomes 'unspecified' unit, comma lists split when each part has a qty", async () => {
  const lines = await run("maggi 5, lux sabun 2 peti");
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].qty, lines[0].unit], [5, "unspecified"]);
});

test("numeric brand names are not read as quantities", async () => {
  const [l] = await run("5 star 2 box");
  assert.equal(l.qty, 2); assert.match(l.itemText, /5 star/);
});
