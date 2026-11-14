import { Link, NavLink, Outlet, useLocation } from "react-router";
import { apiBase, apiMode } from "../api/index.ts";
import { loadDesk, type DeskRow } from "../lib/desk.ts";
import { useApi } from "./api-context.tsx";
import { paths } from "./routes.ts";
import { getToken, setToken } from "../api/token.ts";
import { ThemeToggle } from "./theme.tsx";
import { useAsync } from "../lib/useAsync.ts";

export function Layout() {
  const { api, version, health } = useApi();
  const loc = useLocation();
  const desk = useAsync(() => loadDesk(api), [api, version, loc.pathname]);
  const items = desk.data ?? [];
  const fresh = items.filter(i => i.status === "incoming").length;
  const review = items.filter(i => i.status === "needs_review" || i.status === "ready").length;
  const approved = items.filter(i => i.status === "approved").length;
  const synthetic = health.catalog.dataLabel === "SYNTHETIC";

  const nav = [
    { to: paths.inbox(), label: "Inbox", count: fresh + review, warn: review > 0, title: `${fresh} new, ${review} in review` },
    { to: "/orders", label: "Review", count: review, warn: review > 0, title: `${review} parsed orders waiting for approval`, match: "/orders" },
    { to: paths.approved(), label: "Approved", count: approved, warn: false, title: `${approved} approved orders` },
    { to: paths.catalog(), label: "Catalog", count: null, warn: false, title: "Catalog upload" },
    { to: paths.stats(), label: "Stats", count: null, warn: false, title: "Stats" },
  ];

  return (
    <div className="shell">
      <a href="#main" className="sr-only">Skip to content</a>
      <aside className="sidebar" aria-label="Primary">
        <NavLink to={paths.inbox()} className="brand" aria-label="Order desk home">
          <span className="brand-mark" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M5 7h14M5 12h10M5 17h6"/></svg>
          </span>
          <span><span className="brand-name">Order desk</span><span className="brand-sub">WhatsApp → SKU lines</span></span>
        </NavLink>
        <nav className="nav">
          {nav.map((n, i) => {
            const active = n.match ? loc.pathname.startsWith(n.match) : loc.pathname.startsWith(n.to);
            return (
              <Link key={n.label} to={n.match ? firstReviewPath(items) : n.to} aria-current={active ? "page" : undefined} title={n.title}>
                <span className="nav-idx">0{i + 1}</span>
                <span>{n.label}</span>
                {n.count !== null && n.count > 0 ? <span className={`nav-count${n.warn ? " warn" : ""}`} aria-label={n.title}>{n.count}</span> : <span />}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          {synthetic && <span className="mode-badge" title="The synthetic catalog is loaded. Prices, SKUs and orders are invented.">Synthetic data</span>}
          <span className="adapter" title={apiMode === "http" ? `API at ${apiBase}` : "In-browser mock client: the backend pipeline runs in this tab, no network"}>
            <span className="dot" data-live={apiMode === "http"} aria-hidden="true" />
            <span>{apiMode === "http" ? "Live API" : "In-browser mock"}<br />adapter <b>{health.adapter}</b>{health.adapter === "mock" ? " (free)" : health.adapter === "openai" ? " (paid)" : ""}</span>
          </span>
          {apiMode === "http" && getToken() && <button type="button" className="btn btn-sm btn-ghost" title="Forget the API token in this tab" onClick={() => { setToken(null); window.location.reload(); }}>Forget API token</button>}
          <ThemeToggle />
        </div>
      </aside>
      <div className="main">
        <main id="main" tabIndex={-1}><Outlet /></main>
        <div className="footer-strip" aria-hidden="true">
          <span>{synthetic ? "Synthetic catalog · invented SKUs and prices" : `Uploaded catalog · ${health.catalog.skuCount} SKUs`}</span>
          <span>Prices shown at MRP · not distributor rates</span>
          <span>{apiMode === "http" ? `API ${apiBase}` : "Mock client · no network"}</span>
        </div>
      </div>
    </div>
  );
}

/** "Review" nav jumps to the oldest order waiting for review, or the inbox filtered to review if none is open. */
function firstReviewPath(items: DeskRow[]): string {
  const next = items.filter(i => i.status === "needs_review" || i.status === "ready").sort((a, b) => a.at.localeCompare(b.at))[0];
  return next ? paths.review(next.id) : `${paths.inbox()}?filter=needs_review`;
}
