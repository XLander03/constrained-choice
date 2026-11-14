import { Fragment, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Order } from "../api/types.ts";
import { useApi } from "../app/api-context.tsx";
import { paths } from "../app/routes.ts";
import { ChannelLabel } from "../components/bits.tsx";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.tsx";
import { downloadBlob } from "../lib/csv.ts";
import { UNIT_LABEL, formatInr, formatTime } from "../lib/domain.ts";
import { loadOrders } from "../lib/stats.ts";
import { useAsync } from "../lib/useAsync.ts";

export function ApprovedScreen() {
  const { api, version } = useApi();
  const [params] = useSearchParams();
  const highlight = params.get("order");
  const list = useAsync(async () => (await loadOrders(api, s => s === "approved")).sort((a, b) => b.approved!.approvedAt.localeCompare(a.approved!.approvedAt)), [api, version]);
  const [open, setOpen] = useState<string | null>(highlight);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<{ id: string; msg: string } | null>(null);

  async function exportCsv(o: Order) {
    setExporting(o.orderId); setExportError(null);
    try { const r = await api.exportCsv(o.orderId); downloadBlob(r.blob, r.filename); }
    catch (e) { setExportError({ id: o.orderId, msg: (e as Error).message }); }
    finally { setExporting(null); }
  }

  const orders = list.data ?? [];
  const value = orders.reduce((a, o) => a + o.approved!.totalInr, 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">03 · Approved</p>
          <h1>Approved orders</h1>
          <p className="lede">Ready for Tally, Busy or your DMS. Export each order as CSV.</p>
        </div>
        {orders.length > 0 && <div style={{ textAlign: "right" }}><div className="total-label">{orders.length} orders · at MRP</div><div className="total">{formatInr(value)}</div></div>}
      </header>

      {exportError && <div className="banner error" role="alert"><span className="grow">Export of {exportError.id} failed: {exportError.msg}</span>
        <button type="button" className="btn btn-sm" onClick={() => { const o = orders.find(x => x.orderId === exportError.id); if (o) void exportCsv(o); }}>Retry</button></div>}

      <section className="panel">
        {list.status === "error" && !list.data ? <ErrorState title="Couldn't load approved orders" error={list.error} onRetry={list.reload} />
          : !list.data ? <SkeletonRows rows={5} cols={6} />
          : orders.length === 0 ? <EmptyState title="No approved orders yet" action={<Link to={paths.inbox()} className="btn btn-primary">Go to inbox</Link>}>Approve an order from the review screen and it shows up here, ready to export.</EmptyState>
          : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Approved</th><th>Order</th><th>Retailer</th><th className="r">Lines</th><th className="r hide-sm">Reviewed</th><th className="r">Value</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {orders.map(o => {
                    const a = o.approved!;
                    const reviewed = a.lines.filter(l => l.source === "reviewed").length;
                    const skipped = a.lines.filter(l => l.status === "skipped").length;
                    const isOpen = open === o.orderId;
                    return (
                      <Fragment key={o.orderId}>
                        <tr className={`clickable${o.orderId === highlight ? " flash" : ""}`} onClick={() => setOpen(isOpen ? null : o.orderId)}>
                          <td className="num" style={{ whiteSpace: "nowrap" }}>{formatTime(a.approvedAt)}<div className="muted" style={{ fontSize: 11 }}>by {a.approvedBy}</div></td>
                          <td><button type="button" className="btn btn-sm btn-ghost mono" aria-expanded={isOpen} onClick={e => { e.stopPropagation(); setOpen(isOpen ? null : o.orderId); }}>{isOpen ? "▾" : "▸"} {o.orderId}</button></td>
                          <td><div className="retailer">{o.retailer ?? <span className="muted">Unknown retailer</span>}</div><ChannelLabel channel={o.channel} /></td>
                          <td className="r num">{a.lines.length - skipped}{skipped ? <div className="muted" style={{ fontSize: 11 }}>{skipped} skipped</div> : null}</td>
                          <td className="r num hide-sm">{reviewed}</td>
                          <td className="r num" style={{ fontWeight: 600 }}>{formatInr(a.totalInr)}</td>
                          <td className="r" style={{ whiteSpace: "nowrap" }}>
                            <Link to={paths.review(o.orderId)} className="btn btn-sm btn-ghost hide-sm" onClick={e => e.stopPropagation()}>Open</Link>{" "}
                            <button type="button" className="btn btn-sm" onClick={e => { e.stopPropagation(); void exportCsv(o); }} disabled={exporting === o.orderId} aria-label={`Download ${o.orderId} as CSV`}>
                              {exporting === o.orderId ? <span className="spinner" aria-hidden="true" /> : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 21h16"/></svg>} CSV
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="detail"><td colSpan={7} style={{ padding: "6px 12px 12px" }}>
                            <table className="mini-lines">
                              <thead><tr><th>#</th><th>Retailer wrote</th><th>SKU</th><th className="r">Qty</th><th className="r hide-sm">Units</th><th className="r">Amount</th><th className="hide-sm">Source</th></tr></thead>
                              <tbody>{a.lines.map(l => (
                                <tr key={l.lineId}>
                                  <td className="muted">{l.lineNo}</td><td className="mono">{o.lines.find(x => x.lineId === l.lineId)?.raw}</td>
                                  <td>{l.status === "ok" ? <>{l.label} <span className="muted mono">{l.skuId}</span></> : <span className="muted">Skipped · not stocked</span>}</td>
                                  <td className="r num">{l.status === "ok" ? `${l.qty} ${UNIT_LABEL[l.unit]}` : "—"}</td>
                                  <td className="r num hide-sm">{l.unitsTotal ?? "—"}</td>
                                  <td className="r num">{l.amountInr !== null ? formatInr(l.amountInr) : "—"}</td>
                                  <td className="hide-sm">{l.source === "auto" ? <span className="badge ok">Auto</span> : <span className={`badge ${l.changed ? "warn" : "ok"}`}>{l.changed ? "Corrected" : "Reviewed"}</span>}</td>
                                </tr>
                              ))}</tbody>
                            </table>
                          </td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  );
}
