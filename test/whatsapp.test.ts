import assert from "node:assert/strict";
import { test } from "node:test";
import { groupMessages, parseWhatsAppExport } from "../src/intake/whatsapp.ts";

const ANDROID = [
  "14/11/26, 9:00 am - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.",
  "14/11/26, 9:05\u202fam - Raju Kirana: Bhai order likho",
  "parle g 10 wala 2 peti",
  "maggi 70g 3 peti",
  "14/11/26, 9:07 am - Raju Kirana: blue lays 20rs 1 box",
  "14/11/26, 9:30 am - Sharma Distributors: ok bhai",
  "14/11/26, 9:31 am - Raju Kirana: <Media omitted>",
  "14/11/26, 2:15 pm - Raju Kirana: tata namak 2 bori",
  "14/11/26, 2:16 pm - Raju Kirana: surf 1kg 1 peti <This message was edited>",
].join("\n");
const IOS = [
  "\u200e[11/14/26, 9:05:12\u202fAM] Gupta Kirana: maggi 2 peti",
  "surf excel 1kg 5 dzn",
  "[11/14/26, 9:06:40\u202fAM] Gupta Kirana: \u200eimage omitted",
  "[11/14/26, 12:06:40\u202fPM] Gupta Kirana: lux pink 100g 2 box",
  "[11/14/26, 12:30:00\u202fAM] Gupta Kirana: late night order: 1 peti tide 1kg",
].join("\n");

test("Android export: multi-line messages, system notices and media placeholders", () => {
  const p = parseWhatsAppExport(ANDROID);
  assert.equal(p.format, "android"); assert.equal(p.systemLines, 1); assert.equal(p.skippedMedia, 1);
  assert.equal(p.messages[0].text, "Bhai order likho\nparle g 10 wala 2 peti\nmaggi 70g 3 peti");
  assert.equal(p.messages[0].at, "2026-11-14T09:05:00");
  assert.equal(p.messages.at(-1)!.at, "2026-11-14T14:16:00");
  assert.equal(p.messages.at(-1)!.text, "surf 1kg 1 peti");
});

test("iOS export: bracketed timestamps with seconds, 12 AM/PM, month-first dates detected", () => {
  const p = parseWhatsAppExport(IOS);
  assert.equal(p.format, "ios"); assert.equal(p.dateOrder, "mdy");
  assert.deepEqual(p.messages.map(m => m.at), ["2026-11-14T09:05:12", "2026-11-14T12:06:40", "2026-11-14T00:30:00"]);
  assert.equal(p.messages[0].text, "maggi 2 peti\nsurf excel 1kg 5 dzn");
});

test("24-hour Android and day-first detection", () => {
  const p = parseWhatsAppExport("25/12/2026, 21:05 - A: maggi 2 peti\n25/12/2026, 21:06 - A: lux 1 box");
  assert.equal(p.dateOrder, "dmy"); assert.equal(p.messages[0].at, "2026-12-25T21:05:00");
});

test("grouping: bursts merge same-sender messages until a gap or another sender", () => {
  const p = parseWhatsAppExport(ANDROID);
  const bursts = groupMessages(p.messages, { group: "burst", burstMinutes: 15, exclude: ["sharma distributors"] });
  assert.deepEqual(bursts.map(b => [b.sender, b.messageCount]), [["Raju Kirana", 2], ["Raju Kirana", 2]]);
  assert.match(bursts[0].text, /blue lays/);
  const perMessage = groupMessages(p.messages, { group: "message", exclude: ["Sharma Distributors"] });
  assert.equal(perMessage.length, 4);
  const withReply = groupMessages(p.messages, { group: "burst" });
  assert.equal(withReply.filter(g => g.sender === "Sharma Distributors").length, 1);
});
