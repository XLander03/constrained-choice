import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { ApiError, type ImportOptions, type ImportResult } from "../api/types.ts";
import { useApi } from "../app/api-context.tsx";
import { paths } from "../app/routes.ts";
import { formatTime } from "../lib/domain.ts";
import { describeError } from "../lib/errors.ts";
import { SAMPLE_CHAT_DISTRIBUTOR, sampleChatExport } from "../lib/sampleChat.ts";

const SKIP_REASON: Record<string, string> = { no_product_lines: "no product lines", text_too_long: "over 20,000 characters, split it", too_many_lines: "over 400 lines, split the order" };

const FORMAT_LABEL: Record<ImportResult["format"], string> = { android: "Android", ios: "iOS", mixed: "Mixed Android/iOS", unknown: "Unknown" };
const utf8Bytes = (t: string) => new TextEncoder().encode(t).length;
const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

function importError(e: unknown): { text: string; retryable: boolean; nothingSaved: boolean } {
  const nothingSaved = e instanceof ApiError && e.details?.orders_saved === 0;
  if (e instanceof ApiError && e.code === "no_messages")
    return { text: "That file doesn't look like a WhatsApp export. In WhatsApp open the chat → More → Export chat → Without media, and drop the .txt here.", retryable: false, nothingSaved };
  if (e instanceof ApiError && e.code === "too_many_orders") return { text: e.message, retryable: false, nothingSaved };
  const d = describeError(e, "The import");
  // The server already says "Nothing from this import was saved" on all-or-nothing failures; don't repeat it.
  return { text: d.text, retryable: d.retryable, nothingSaved };
}

/** Import a WhatsApp chat export (.txt) → one order per sender burst (POST /orders/import/whatsapp). */
export function ImportChat() {
  const { api, bump, health } = useApi();
  const maxBytes = health.limits.maxBodyBytes;
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [me, setMe] = useState("");
  const [group, setGroup] = useState<ImportOptions["group"]>("burst");
  const [burst, setBurst] = useState(15);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<{ text: string; retryable: boolean; nothingSaved: boolean } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function read(f: File) {
    setError(null); setResult(null);
    const text = await f.text();
    // Measure what will actually be sent: the decoded text re-encoded as UTF-8 (the raw text/plain body), not File.size.
    const bytes = utf8Bytes(text);
    if (bytes > maxBytes) { setError({ text: `The file is ${formatBytes(bytes)}; the server accepts up to ${formatBytes(maxBytes)}. Export a shorter date range.`, retryable: false, nothingSaved: false }); return; }
    setFile({ name: f.name, text });
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) void read(f); };

  async function run() {
    if (!file || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await api.importWhatsApp(file.text, { group, burstMinutes: burst, excludeSenders: me.split(",").map(s => s.trim()).filter(Boolean), dateOrder: "auto" });
      setResult(r); bump();
    } catch (e) { setError(importError(e)); }
    finally { setBusy(false); }
  }

  if (result) return (
    <div className="panel-body import-result" style={{ display: "grid", gap: 12 }}>
      <div className="banner ok" role="status" style={{ margin: 0 }}>
        <span className="badge solid">Imported</span>
        <span className="grow"><b>{result.summary.orders}</b> order{result.summary.orders === 1 ? "" : "s"} from {result.messages} messages · <b>{result.summary.auto}</b> lines auto · <b>{result.summary.needsReview}</b> to review · ₹{result.summary.costInr.toFixed(4)}</span>
      </div>
      <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>
        {FORMAT_LABEL[result.format] ?? result.format} export, dates read as {result.dateOrder === "dmy" ? "day/month" : "month/day"}, grouped {result.group === "burst" ? `by sender bursts (${result.burstMinutes} min)` : "one order per message"}
        {result.systemLines ? ` · ${result.systemLines} system line${result.systemLines === 1 ? "" : "s"} dropped` : ""}{result.mediaSkipped ? ` · ${result.mediaSkipped} media/deleted skipped` : ""}.
      </p>
      {result.orders.length > 0 && (
        <ul className="import-list" aria-label="Orders created">
          {result.orders.map(o => (
            <li key={o.orderId}>
              <Link to={paths.review(o.orderId)}>
                <span className="mono muted">{formatTime(o.createdAt)}</span>
                <b>{o.retailer ?? "Unknown"}</b>
                <span className="muted">{o.summary.lines} lines · {o.summary.needsReview ? <span className="warn-text">{o.summary.needsReview} to review</span> : "all auto"}</span>
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {result.skipped.length > 0 && (
        <div className="skip-list" role="note">
          <div className="err-head">{result.skipped.length} group{result.skipped.length === 1 ? "" : "s"} skipped</div>
          <ul>{result.skipped.map((s, i) => <li key={i}><b>{s.sender}</b> · {formatTime(s.at)} · {SKIP_REASON[s.reason] ?? s.reason}: <span className="mono">“{s.text.slice(0, 60)}{s.text.length > 60 ? "…" : ""}”</span></li>)}</ul>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {result.orders[0] && <Link className="btn btn-primary" to={paths.review((result.orders.find(o => o.summary.needsReview) ?? result.orders[0]).orderId)}>Review first order →</Link>}
        <button type="button" className="btn" onClick={() => { setResult(null); setFile(null); }}>Import another chat</button>
      </div>
    </div>
  );

  return (
    <div className="panel-body" style={{ display: "grid", gap: 12 }}>
      <div className="drop small" data-over={drag} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
        {file ? <p><b className="mono">{file.name}</b> · {file.text.split("\n").length} lines · {formatBytes(utf8Bytes(file.text))} · <button type="button" className="linkish" onClick={() => setFile(null)}>remove</button></p>
          : <p>Drop a WhatsApp chat export (<span className="mono">.txt</span>) here, or <button type="button" className="linkish" onClick={() => input.current?.click()}>choose a file</button>.</p>}
        <p className="muted" style={{ fontSize: 11.5 }}>WhatsApp → open the chat → More → Export chat → <b>Without media</b>. Android and iPhone exports both work.</p>
        <input ref={input} type="file" accept=".txt,text/plain" className="sr-only" tabIndex={-1} aria-label="WhatsApp chat export file" onChange={e => { const f = e.target.files?.[0]; if (f) void read(f); e.target.value = ""; }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "end" }}>
        <label className="field"><span>Your name in the chat <span className="muted">(your replies are ignored)</span></span>
          <input className="input" value={me} onChange={e => setMe(e.target.value)} placeholder={`e.g. ${SAMPLE_CHAT_DISTRIBUTOR}`} maxLength={200} /></label>
        <div className="field" role="group" aria-labelledby="grp-l"><span id="grp-l">One order per</span>
          <div className="seg" style={{ height: 32 }}>
            <button type="button" aria-pressed={group === "burst"} onClick={() => setGroup("burst")} style={{ height: 29 }} title="Consecutive messages from one sender form one order">Burst</button>
            <button type="button" aria-pressed={group === "message"} onClick={() => setGroup("message")} style={{ height: 29 }}>Message</button>
          </div>
        </div>
      </div>
      {group === "burst" && (
        <label className="field inline-field"><span>A gap longer than</span>
          <input className="input" type="number" min={1} max={240} value={burst} onChange={e => setBurst(Math.max(1, Number(e.target.value) || 15))} style={{ width: 64 }} />
          <span>minutes, or a reply from anyone else, starts a new order.</span></label>
      )}
      {error && <div className="banner error" role="alert" style={{ margin: 0 }}>
        <span className="grow">{error.nothingSaved && <b>Import failed, nothing was saved. </b>}{error.text}</span>
        {error.retryable && <button type="button" className="btn btn-sm" onClick={() => void run()}>Retry import</button>}
      </div>}
      <div className="paste-actions">
        <div className="samples"><span className="muted" style={{ fontSize: 11.5 }}>Try:</span>
          <button type="button" className="sample-chip" onClick={() => { setFile({ name: "WhatsApp Chat with Sharma Distributors.txt", text: sampleChatExport() }); setMe(SAMPLE_CHAT_DISTRIBUTOR); setError(null); }}>Sample chat export</button>
        </div>
        <button type="button" className="btn btn-primary btn-lg" onClick={run} disabled={!file || busy} aria-busy={busy}>
          {busy ? <><span className="spinner" aria-hidden="true" /> Importing…</> : "Import chat →"}
        </button>
      </div>
    </div>
  );
}
