// WhatsApp "Export chat" (.txt, without media) parser. Handles both common layouts:
//   Android: "14/11/26, 9:05 am - Raju Kirana: maggi 2 peti"      (also 24h "21:05", "14.11.26", 4-digit years)
//   iOS:     "[14/11/26, 9:05:12 AM] Raju Kirana: maggi 2 peti"   (often with a leading U+200E mark)
// Lines without a timestamp continue the previous message (multi-line messages). System notices and media
// placeholders are dropped. Messages are then grouped into orders: one per message, or per contiguous burst
// (same sender, gaps ≤ burstMinutes). Exports carry no timezone, so timestamps are returned as local "YYYY-MM-DDTHH:MM:SS".

export interface WaMessage { at: string; sender: string; text: string; line: number }
export interface WaParseResult { format: "android" | "ios" | "mixed" | "unknown"; dateOrder: "dmy" | "mdy"; messages: WaMessage[]; systemLines: number; skippedMedia: number }
export interface WaOrderGroup { sender: string; firstAt: string; lastAt: string; text: string; messageCount: number; firstLine: number }

const INVISIBLE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const SPACES = /[\u202f\u00a0\u2007]/g;
const TIME = String.raw`(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?`;
const DATE = String.raw`(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{1,4})`;
const RE_IOS = new RegExp(String.raw`^\[${DATE},?\s+${TIME}\]\s*(.*)$`);
const RE_ANDROID = new RegExp(String.raw`^${DATE},?\s+${TIME}\s+[-–]\s+(.*)$`);
const MEDIA = /^(<media omitted>|<attached: .*>|(image|video|audio|sticker|gif|document|contact card) omitted|.*\(file attached\)|this message was deleted\.?|you deleted this message\.?|<this message was deleted>|null|missed (voice|video) call.*|waiting for this message.*)$/i;

type Head = { a: number; b: number; c: number; h: number; mi: number; s: number; ap: string | undefined; rest: string; style: "android" | "ios" };
function head(line: string): Head | null {
  const m = line.match(RE_IOS) ?? line.match(RE_ANDROID); if (!m) return null;
  return { a: +m[1], b: +m[2], c: +m[3], h: +m[4], mi: +m[5], s: m[6] ? +m[6] : 0, ap: m[7], rest: m[8], style: line.startsWith("[") ? "ios" : "android" };
}

/** Detect day/month order from the whole export: any first field > 12 → dmy, any second field > 12 → mdy, else dmy (India default). */
function detectDateOrder(hs: Head[], hint?: "dmy" | "mdy" | "auto"): "dmy" | "mdy" {
  if (hint === "dmy" || hint === "mdy") return hint;
  const rest = hs.filter(h => h.a <= 31);                                         // a > 31 = year-first, unambiguous
  if (rest.some(h => h.a > 12)) return "dmy";
  if (rest.some(h => h.b > 12)) return "mdy";
  return "dmy";
}
const pad = (n: number) => String(n).padStart(2, "0");
function toIso(h: Head, order: "dmy" | "mdy"): string | null {
  let y: number, mo: number, d: number;
  if (h.a > 31) { y = h.a; mo = h.b; d = h.c; }                                   // 2026-11-14 style
  else if (order === "dmy") { d = h.a; mo = h.b; y = h.c; } else { mo = h.a; d = h.b; y = h.c; }
  if (y < 100) y += 2000;
  let hour = h.h;
  if (h.ap) { const pm = /^p/i.test(h.ap); if (hour === 12) hour = pm ? 12 : 0; else if (pm) hour += 12; }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hour > 23 || h.mi > 59) return null;
  return `${y}-${pad(mo)}-${pad(d)}T${pad(hour)}:${pad(h.mi)}:${pad(h.s)}`;
}

export function parseWhatsAppExport(raw: string, opts: { dateOrder?: "dmy" | "mdy" | "auto" } = {}): WaParseResult {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map(l => l.replace(INVISIBLE, "").replace(SPACES, " ").trimEnd());
  const heads = lines.map(head);
  const order = detectDateOrder(heads.filter((h): h is Head => !!h), opts.dateOrder);
  const messages: WaMessage[] = []; let systemLines = 0, skippedMedia = 0; let cur: WaMessage | null = null;
  const styles = new Set<string>();
  const flush = () => {
    if (!cur) return;
    cur.text = cur.text.replace(/\s*<This message was edited>\s*$/i, "").trim();
    if (!cur.text || MEDIA.test(cur.text)) skippedMedia++; else messages.push(cur);
    cur = null;
  };
  lines.forEach((l, i) => {
    const h = heads[i];
    if (h) {
      flush();
      const at = toIso(h, order);
      const colon = h.rest.indexOf(": ");
      // System notices ("Messages and calls are end-to-end encrypted", "X added Y") have no "Sender: " part.
      if (!at || colon <= 0 || colon > 60) { systemLines++; return; }
      styles.add(h.style);
      cur = { at, sender: h.rest.slice(0, colon).trim(), text: h.rest.slice(colon + 2), line: i + 1 };
    } else if (cur && l.trim()) cur.text += "\n" + l;
  });
  flush();
  const format = styles.size === 2 ? "mixed" : styles.has("ios") ? "ios" : styles.has("android") ? "android" : "unknown";
  return { format, dateOrder: order, messages, systemLines, skippedMedia };
}

const minutes = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60000;

/** Group messages into candidate orders. `exclude` drops senders (e.g. the distributor's own replies), case-insensitive. */
export function groupMessages(msgs: WaMessage[], opts: { group?: "burst" | "message"; burstMinutes?: number; exclude?: string[] } = {}): WaOrderGroup[] {
  const ex = new Set((opts.exclude ?? []).map(s => s.trim().toLowerCase()));
  const gap = opts.burstMinutes ?? 15; const out: WaOrderGroup[] = [];
  let last: WaMessage | null = null;
  for (const m of msgs) {
    if (ex.has(m.sender.toLowerCase())) { last = null; continue; }          // a reply from someone else ends a burst
    const g = out[out.length - 1];
    if (opts.group !== "message" && g && last && last.sender === m.sender && minutes(last.at, m.at) <= gap && minutes(last.at, m.at) >= 0) {
      g.text += "\n" + m.text; g.lastAt = m.at; g.messageCount++;
    } else out.push({ sender: m.sender, firstAt: m.at, lastAt: m.at, text: m.text, messageCount: 1, firstLine: m.line });
    last = m;
  }
  return out;
}
