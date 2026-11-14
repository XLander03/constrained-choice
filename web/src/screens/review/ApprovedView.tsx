import { useState } from "react";
import { Link, useLocation } from "react-router";
import { ApiError, type Order } from "../../api/types.ts";
import { useApi } from "../../app/api-context.tsx";
import { paths } from "../../app/routes.ts";
import { ChannelLabel } from "../../components/bits.tsx";
import { downloadBlob } from "../../lib/csv.ts";
import { UNIT_LABEL, formatInr, formatTime } from "../../lib/domain.ts";

/** Approved state of the review screen (API.md screen 3): read-only lines with units_total, CSV, Sheets, new order. */
export function ApprovedView({ order }: { order: Order }) {
  const { api, health } = useApi();
  const loc = useLocation();
  const just = (loc.state as { justApproved?: boolean } | null)?.justApproved;
  const a = order.approved!;
  const [busy, setBusy] = useState<"csv" | "sheets" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string; retry?: () => void; link?: string } | null>(null);
  const kept = a.lines.filter(l => l.status === "ok");

  async function csv() {
    setBusy("csv"); setMsg(null);
    try { const r = await api.exportCsv(order.orderId); downloadBlob(r.blob, r.filename); setMsg({ kind: "ok", text: `Downloaded ${r.filename}.` }); }
    catch (e) { setMsg({ kind: "error", text: `CSV export failed: ${(e as Error).message}`, retry: () => void csv() }); }
    finally { setBusy(null); }
  }
  async function sheets() {
    setBusy("sheets"); setMsg(null);
    try { const r = await api.exportSheets(order.orderId); setMsg({ kind: "ok", text: `Sent to Google Sheets${r.rows ? ` (${r.rows} rows)` : ""}.`, link: r.location }); }
    catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      setMsg(code === "sheets_not_configured" ? { kind: "error", text: (e as Error).message }
        : code === "sheets_export_failed" ? { kind: "error", text: `Google Sheets returned an error: ${(e as Error).message}. The CSV download still works.`, retry: () => void sheets() }
        : { kind: "error", text: `Sheets export failed: ${(e as Error).message}`, retry: () => void sheets() });
    }
    finally { setBusy(null); }
  }

  return (
    <div className="page">
      <header className="review-head">
        <div>
          <p className="eyebrow">Approved <span className="muted">· {order.orderId}</span></p>
          <h1>{order.retailer ?? "Unknown retailer"}</h1>
          <div className="meta-row">
            <span><ChannelLabel channel={order.channel} /></span>
            <span>Received <b>{formatTime(order.createdAt)}</b></span>
            <span>Approved <b>{formatTime(a.approvedAt)}</b> by <b>{a.approvedBy}</b></span>
            <span><b>{kept.length}</b> lines kept{a.lines.length - kept.length ? <> · <b>{a.lines.length - kept.length}</b> skipped</> : null}</span>
          </div>
        </div>
        <div className="approve-box" style={{ gridTemplateColumns: "auto" }}>
          <div style={{ textAlign: "right" }}><div className="total-label">Order value · at MRP</div><div className="total">{formatInr(a.totalInr)}</div></div>
        </div>
      </header>

      {just && <div className="banner ok" role="status"><span className="badge solid">Approved</span><span className="grow">Order approved. Download the CSV for Tally, Busy or your DMS.</span></div>}
      {a.warnings.length > 0 && <div className="banner warn" role="note"><span className="badge warn">Check before import</span><span className="grow">
        {a.warnings.length === 1 ? a.warnings[0].message : <>{a.warnings.length} SKUs aren't in the current catalog, so a DMS/Tally import may reject them: {a.warnings.map(w => w.skuId).join(", ")}.</>}</span></div>}
      {order.catalogStale && !a.warnings.length && <div className="banner warn" role="note"><span className="grow">Parsed on an older catalog ({order.catalogVersion}). Every approved SKU is still in the current catalog.</span></div>}
      {msg && <div className={`banner ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}><span className="grow">{msg.text}{msg.link && <> <a href={msg.link} target="_blank" rel="noreferrer">Open the sheet ↗</a></>}</span>{msg.retry && <button type="button" className="btn btn-sm" onClick={msg.retry}>Retry</button>}</div>}

      <div className="action-row">
        <button type="button" className="btn btn-primary btn-lg" onClick={csv} disabled={busy === "csv"}>
          {busy === "csv" ? <span className="spinner" aria-hidden="true" /> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 21h16"/></svg>}
          Download CSV
        </button>
        <span title={health.sheetsExportConfigured ? "Append this order to the configured Google Sheet" : `Not configured on the server: ${health.sheetsStatus}`}>
          <button type="button" className="btn btn-lg" onClick={sheets} disabled={!health.sheetsExportConfigured || busy === "sheets"} aria-describedby="sheets-note">Send to Google Sheets</button>
        </span>
        <span id="sheets-note" className="muted" style={{ fontSize: 11.5 }}>{health.sheetsExportConfigured ? "" : "Sheets export isn't set up on the server yet (hover for what's missing)."}</span>
        <span style={{ flex: 1 }} />
        <Link to={paths.approved(order.orderId)} className="btn btn-lg btn-ghost">All approved orders</Link>
        <Link to={paths.inbox()} className="btn btn-lg">New order →</Link>
      </div>

      <section className="panel" aria-labelledby="al-h" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2 id="al-h">Approved lines</h2><span className="muted" style={{ fontSize: 11.5 }}>Units = qty × case / dozen / strip size</span></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>Retailer wrote</th><th>SKU</th><th className="r">Qty</th><th className="r hide-sm">Units</th><th className="r hide-sm">MRP</th><th className="r">Amount</th><th>Source</th></tr></thead>
            <tbody>{a.lines.map(l => {
              const raw = order.lines.find(x => x.lineId === l.lineId)?.raw ?? "";
              return (
                <tr key={l.lineId} style={l.status === "skipped" ? { color: "var(--muted-fg)" } : undefined}>
                  <td className="muted num">{l.lineNo}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{raw}</td>
                  <td>{l.status === "ok" ? <><div style={{ fontWeight: 600 }}>{l.label}</div><div className="mono muted" style={{ fontSize: 11 }}>{l.skuId}</div>{a.warnings.some(w => w.lineId === l.lineId) && <span className="tag danger" style={{ marginTop: 4 }} title={a.warnings.find(w => w.lineId === l.lineId)!.message}>Not in current catalog</span>}</> : <span className="badge plain">Skipped · not stocked</span>}</td>
                  <td className="r num">{l.status === "ok" ? `${l.qty} ${UNIT_LABEL[l.unit]}` : "—"}</td>
                  <td className="r num hide-sm">{l.unitsTotal ?? "—"}</td>
                  <td className="r num hide-sm">{l.mrpInr !== null ? formatInr(l.mrpInr) : "—"}</td>
                  <td className="r num" style={{ fontWeight: 600 }}>{l.amountInr !== null ? formatInr(l.amountInr) : "—"}</td>
                  <td>{l.source === "auto" ? <span className="badge ok">Auto</span> : <span className={`badge ${l.changed ? "warn" : "ok"}`}>{l.changed ? "Corrected" : "Reviewed"}</span>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
