import { Link } from "react-router";
import type { ReviewReason } from "../api/types.ts";
import { useApi } from "../app/api-context.tsx";
import { paths } from "../app/routes.ts";
import { EmptyState, ErrorState, LoadingState } from "../components/States.tsx";
import { REASON_HELP, REASON_SHORT, formatInr, formatPct, formatUsd } from "../lib/domain.ts";
import { computeStats, loadOrders, type DeskStats } from "../lib/stats.ts";
import { useAsync } from "../lib/useAsync.ts";

export function StatsScreen() {
  const { api, version, health } = useApi();
  const st = useAsync(async () => computeStats(await loadOrders(api)), [api, version]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">05 · Stats</p>
          <h1>How the desk is doing</h1>
          <p className="lede">Computed in the browser from {api.mode === "mock" ? "this tab's mock orders" : "the orders the API has parsed since it started (one GET /orders?detail=1)"}.{health.catalog.dataLabel === "SYNTHETIC" ? " Synthetic data: these describe the demo, not model accuracy." : ""}</p>
        </div>
        {st.data && <button type="button" className="btn" onClick={st.reload} disabled={st.status === "loading"}>{st.status === "loading" ? <span className="spinner" aria-hidden="true" /> : null} Refresh</button>}
      </header>
      {st.status === "error" && !st.data ? <div className="panel"><ErrorState title="Couldn't load stats" error={st.error} onRetry={st.reload} /></div>
        : !st.data ? <div className="panel"><LoadingState label="Crunching…" /></div>
        : st.data.linesTotal === 0 ? <div className="panel"><EmptyState title="No parsed orders yet" action={<Link to={paths.inbox()} className="btn btn-primary">Go to inbox</Link>}>Parse an order and the numbers start here.</EmptyState></div>
        : <StatsBody s={st.data} />}
    </div>
  );
}

function StatsBody({ s }: { s: DeskStats }) {
  const reasons = (Object.entries(s.reasonCounts) as [ReviewReason, number][]).sort((a, b) => b[1] - a[1]);
  const maxR = Math.max(1, ...reasons.map(r => r[1]));
  const review = s.linesTotal - s.linesAuto;
  return (
    <>
      <div className="kpis">
        <div className="kpi accent"><p className="eyebrow">Auto-accepted</p><div className="v">{formatPct(s.autoAcceptedPct)}</div><div className="sub">{s.linesAuto} of {s.linesTotal} lines{s.threshold !== null ? ` at ≥ ${(s.threshold * 100).toFixed(1)}% calibrated confidence` : ""}</div></div>
        <div className="kpi"><p className="eyebrow">Lines reviewed</p><div className="v">{s.linesReviewed}</div><div className="sub">{s.linesChanged} corrected · {s.skipped} skipped as not stocked</div></div>
        <div className="kpi"><p className="eyebrow">Cost per order</p><div className="v">{formatUsd(s.costPerOrderUsd)}</div><div className="sub">≈ {formatInr(s.costPer1000OrdersInr)} per 1,000 orders at ₹88/$</div></div>
        <div className="kpi"><p className="eyebrow">Orders</p><div className="v">{s.ordersApproved}<span className="muted" style={{ fontSize: 22 }}> / {s.ordersParsed}</span></div><div className="sub">approved / parsed</div></div>
      </div>
      <div className="stats-grid">
        <section className="panel" aria-labelledby="why-h">
          <div className="panel-head"><h2 id="why-h">Why lines went to review</h2><span className="muted" style={{ fontSize: 11.5 }}>A line can have more than one reason</span></div>
          <div className="panel-body bars">
            {reasons.length === 0 ? <p className="muted">No line has needed review yet.</p> : reasons.map(([r, n]) => (
              <div key={r} className="bar-row" title={REASON_HELP[r]}>
                <span>{REASON_SHORT[r]}</span>
                <span className="bar-track" role="img" aria-label={`${REASON_SHORT[r]}: ${n} lines`}><span className={`bar-fill${r === "none_of_these" || r === "refused" ? " danger" : ""}`} style={{ width: `${(n / maxR) * 100}%`, display: "block" }} /></span>
                <span className="num" style={{ textAlign: "right" }}>{n}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel" aria-labelledby="flow-h">
          <div className="panel-head"><h2 id="flow-h">Line flow</h2></div>
          <div className="panel-body funnel">
            <div className="funnel-row"><span>Lines parsed</span><span className="v">{s.linesTotal}</span></div>
            <div className="funnel-row"><span>Auto-accepted <span className="muted">· no human touch</span></span><span className="v">{s.linesAuto}</span></div>
            <div className="funnel-row"><span>Sent to review</span><span className="v">{review}</span></div>
            <div className="funnel-row"><span>Reviewed in approved orders</span><span className="v">{s.linesReviewed}</span></div>
            <div className="funnel-row"><span>Corrected by the reviewer <span className="muted">· {s.linesReviewed ? formatPct(s.linesChanged / s.linesReviewed) : "—"} of reviewed</span></span><span className="v">{s.linesChanged}</span></div>
          </div>
        </section>
      </div>
    </>
  );
}
