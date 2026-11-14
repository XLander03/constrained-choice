import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { Channel } from "../api/types.ts";
import { useApi } from "../app/api-context.tsx";
import { paths } from "../app/routes.ts";
import { ChannelLabel, Kbd, StatusBadge, type DeskStatus } from "../components/bits.tsx";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.tsx";
import { formatTime } from "../lib/domain.ts";
import { describeError } from "../lib/errors.ts";
import { ImportChat } from "./ImportChat.tsx";
import { loadDesk, type DeskRow } from "../lib/desk.ts";
import { useAsync } from "../lib/useAsync.ts";

type Filter = "all" | DeskStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" }, { id: "incoming", label: "New" }, { id: "needs_review", label: "Needs review" }, { id: "ready", label: "Ready" }, { id: "approved", label: "Approved" },
];
const CHANNELS: { id: Channel; label: string }[] = [{ id: "whatsapp", label: "WhatsApp" }, { id: "email", label: "Email" }, { id: "manual", label: "Manual" }];
const SAMPLES: { label: string; retailer: string; text: string }[] = [
  { label: "Hinglish, 5 lines", retailer: "Sharma General Store", text: "Bhai order likho\nparle g 10 wala 2 peti\nblue lays 20rs 1 box\nclinic plus 1rs 10 ladi\nH&S cool menthol 5 ladi, maggi 70g 3 peti\njaldi bhejna" },
  { label: "Which pack?", retailer: "Laxmi Stores", text: "maggi 2 peti\nvim bar 3 dozen\nsurf excel 4\neverest kitchen king 100g 2 dabba" },
  { label: "Not in catalog", retailer: "New Krishna Kirana", text: "gillette guard razor 1 peti\nred bull 250ml 1 peti\nrin liquid 1L 3 peti\ntata salt 1kg 2 bori\nparle g 5 wala 1 peti" },
  { label: "Name mismatch", retailer: "Bharat Kirana", text: "lays american style cream onion 1 box\nmaggi 70g 3 peti\nclinic plus 1rs 10 ladi" },
];

export function InboxScreen() {
  const { api, version, bump, health } = useApi();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = (FILTERS.some(f => f.id === params.get("filter")) ? params.get("filter") : "all") as Filter;
  const desk = useAsync(() => loadDesk(api), [api, version]);

  const mode = params.get("intake") === "chat" ? "chat" : "paste";
  const setMode = (m: "paste" | "chat") => setParams(p => { const n = new URLSearchParams(p); if (m === "chat") n.set("intake", "chat"); else n.delete("intake"); return n; }, { replace: true });
  const [text, setText] = useState("");
  const [retailer, setRetailer] = useState("");
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [parsing, setParsing] = useState<string | null>(null);
  const [error, setError] = useState<{ msg: string; retry?: () => void } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const rows = desk.data ?? [];
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.id, f.id === "all" ? rows.length : rows.filter(r => r.status === f.id).length])) as Record<Filter, number>, [rows]);
  const shown = filter === "all" ? rows : rows.filter(r => r.status === filter);

  async function parsePaste() {
    if (!text.trim() || parsing) return;
    setParsing("paste"); setError(null);
    try { const o = await api.parseOrder({ text, channel, retailer: retailer.trim() || undefined }); bump(); navigate(paths.review(o.orderId)); }
    catch (e) { const d = describeError(e, "Parsing"); setError({ msg: d.text, retry: d.retryable ? () => void parsePaste() : undefined }); }
    finally { setParsing(null); }
  }

  async function open(r: DeskRow) {
    if (r.kind === "order") { navigate(paths.review(r.id)); return; }
    setParsing(r.id); setError(null);
    try { await api.parseOrder({ text: r.text, channel: r.channel, retailer: r.retailer, orderId: r.id }); bump(); navigate(paths.review(r.id)); }
    catch (e) { const d = describeError(e, "Parsing"); setError({ msg: d.text, retry: d.retryable ? () => void open(r) : undefined }); }
    finally { setParsing(null); }
  }

  const onPasteKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void parsePaste(); }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">01 · Inbox</p>
          <h1>Incoming orders</h1>
          <p className="lede">Paste a WhatsApp or email order, or pick one from the list. Lines the model is sure about are accepted automatically; the rest wait for you.</p>
        </div>
      </header>

      {health.catalog.dataLabel === "SYNTHETIC" && (
        <div className="banner warn"><span className="badge warn">Synthetic data</span><span className="grow">The synthetic catalog is loaded ({health.catalog.skuCount} invented SKUs). Decision adapter: <b>{health.adapter}</b>{health.adapter === "mock" ? ", a free offline demo" : health.adapter === "openai" ? ", paid per request" : ""}.</span></div>
      )}
      {error && <div className="banner error" role="alert"><span className="grow">{error.msg}</span>{error.retry && <button type="button" className="btn btn-sm" onClick={error.retry}>Retry</button>}<button type="button" className="btn btn-sm btn-ghost" onClick={() => setError(null)}>Dismiss</button></div>}

      <div className="inbox-grid">
        <section className="panel paste-panel" aria-labelledby="paste-h">
          <div className="panel-head">
            <h2 id="paste-h">{mode === "paste" ? "Paste an order" : "Import WhatsApp chat"}</h2>
            <div className="tabs mode" role="tablist" aria-label="How to add orders">
              <button type="button" role="tab" aria-selected={mode === "paste"} aria-controls="intake-panel" onClick={() => setMode("paste")}>Paste</button>
              <button type="button" role="tab" aria-selected={mode === "chat"} aria-controls="intake-panel" onClick={() => setMode("chat")}>Import chat</button>
            </div>
          </div>
          <div id="intake-panel" role="tabpanel" aria-labelledby="paste-h">
          {mode === "chat" ? <ImportChat /> : <>
          <div className="panel-body" style={{ display: "grid", gap: 12 }}>
            <label className="field">
              <span>Paste a WhatsApp or email order</span>
              <textarea ref={textRef} className="textarea" rows={9} value={text} onChange={e => setText(e.target.value)} onKeyDown={onPasteKey}
                placeholder={"Bhai order likho\nparle g 10 wala 2 peti\nblue lays 20rs 1 box"} spellCheck={false} />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "end" }}>
              <label className="field"><span>Retailer <span className="muted">(optional)</span></span>
                <input className="input" value={retailer} onChange={e => setRetailer(e.target.value)} placeholder="e.g. Raju Kirana" maxLength={64} /></label>
              <div className="field" role="group" aria-labelledby="chan-l"><span id="chan-l">Channel</span>
                <div className="seg" style={{ height: 32 }}>{CHANNELS.map(c => <button key={c.id} type="button" aria-pressed={channel === c.id} onClick={() => setChannel(c.id)} style={{ height: 29 }}>{c.label}</button>)}</div>
              </div>
            </div>
            <div className="paste-actions">
              <div className="samples" aria-label="Sample messages">
                <span className="muted" style={{ fontSize: 11.5 }}>Try:</span>
                {SAMPLES.map(s => <button key={s.label} type="button" className="sample-chip" onClick={() => { setText(s.text); setRetailer(s.retailer); textRef.current?.focus(); }}>{s.label}</button>)}
              </div>
              <button type="button" className="btn btn-primary btn-lg" onClick={parsePaste} disabled={!text.trim() || !!parsing} aria-busy={parsing === "paste"}>
                {parsing === "paste" ? <><span className="spinner" aria-hidden="true" /> Parsing…</> : "Parse order →"}
              </button>
            </div>
            <p className="muted" style={{ fontSize: 11.5, margin: 0 }}><Kbd>⌘</Kbd> <Kbd>Enter</Kbd> parses.{health.defaultUnit ? <> Bare numbers (“maggi 5”) are read as <b>{health.defaultUnit}</b>.</> : null}</p>
          </div>
          </>}
          </div>
        </section>

        <section className="panel" aria-labelledby="inbox-h">
          <div className="panel-head">
            <h2 id="inbox-h">Orders</h2>
            <div className="tabs" role="tablist" aria-label="Filter orders">
              {FILTERS.map(f => (
                <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setParams(p => { const n = new URLSearchParams(p); if (f.id === "all") n.delete("filter"); else n.set("filter", f.id); return n; }, { replace: true })}>
                  {f.label} <span className="count">{counts[f.id]}</span>
                </button>
              ))}
            </div>
          </div>
          {desk.status === "error" && !desk.data ? <ErrorState title="Couldn't load orders" error={desk.error} onRetry={desk.reload} />
            : !desk.data ? <SkeletonRows rows={8} cols={4} />
            : shown.length === 0 ? (
              <EmptyState title={filter === "all" ? "No orders yet" : "Nothing here"}
                action={filter !== "all" ? <button type="button" className="btn" onClick={() => setParams({})}>Show all</button> : undefined}>
                {filter === "incoming" && api.mode === "http" ? "The backend has no live intake queue yet: paste a message or import a WhatsApp chat export on the left."
                  : filter === "needs_review" ? "No orders are waiting for review." : filter === "all" ? "Paste an order on the left to get started." : "No orders with this status."}
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Received</th><th>Retailer</th><th className="hide-sm">Message</th><th className="r">Lines</th><th>Status</th><th><span className="sr-only">Action</span></th></tr></thead>
                  <tbody>
                    {shown.map(r => {
                      const verb = r.kind === "incoming" ? "Parse" : r.status === "approved" || r.status === "empty" ? "View" : "Review";
                      return (
                        <tr key={r.kind + r.id} className="clickable" onClick={() => open(r)}>
                          <td className="num" style={{ whiteSpace: "nowrap" }}>{formatTime(r.at)}<div className="mono muted" style={{ fontSize: 11 }}>{r.id}</div></td>
                          <td><div className="retailer">{r.retailer ?? <span className="muted">Unknown retailer</span>}</div>{r.kind === "incoming" ? <ChannelLabel channel={r.channel} /> : r.order.channel && <ChannelLabel channel={r.order.sourceKind === "whatsapp_export" ? "whatsapp" : r.order.channel} />}</td>
                          <td className="hide-sm">{r.kind === "incoming" ? <div className="msg-preview">{r.text}</div>
                            : <>{r.order.textPreview && <div className="msg-preview">{r.order.textPreview}</div>}
                              <span className="muted" style={{ fontSize: 11.5 }}>{r.order.summary.lines === 0 ? "Nothing to approve" : <>{r.order.summary.auto} auto{r.order.summary.needsReview ? <> · <b style={{ color: "var(--warn-ink)" }}>{r.order.summary.needsReview} to review</b></> : null}</>}{r.order.sourceKind === "whatsapp_export" ? " · chat import" : ""}</span></>}</td>
                          <td className="r num">{r.kind === "order" ? r.order.summary.lines : "—"}</td>
                          <td><StatusBadge status={r.status} /></td>
                          <td className="r">
                            <button type="button" className={`btn btn-sm${r.kind === "incoming" ? " btn-primary" : ""}`} onClick={e => { e.stopPropagation(); void open(r); }}
                              disabled={!!parsing} aria-label={`${verb} order ${r.id}${r.retailer ? ` from ${r.retailer}` : ""}`}>
                              {parsing === r.id ? <><span className="spinner" aria-hidden="true" /> Parsing</> : verb}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </section>
      </div>
    </div>
  );
}
