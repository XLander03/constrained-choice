import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, isFullSku, type Order, type OrderUnit, type ParsedLine, type SkuRef, type SkuSummary } from "../../api/types.ts";
import { useApi } from "../../app/api-context.tsx";
import { paths, useRouteParams } from "../../app/routes.ts";
import { ChannelLabel, Confidence, Kbd, ReasonTag } from "../../components/bits.tsx";
import { EmptyState, ErrorState, LoadingState } from "../../components/States.tsx";
import { UNIT_HINT, UNIT_LABEL, formatInr, formatTime, unitsAllowed } from "../../lib/domain.ts";
import { describeError } from "../../lib/errors.ts";
import { useAsync } from "../../lib/useAsync.ts";
import { ApprovedView } from "./ApprovedView.tsx";
import { approveGate, draftProblem, initReview, lineAmount, reducer, toApproveInput, type Draft, type ReviewState } from "./model.ts";

export function ReviewScreen() {
  const { orderId } = useRouteParams("review");
  const { api, version } = useApi();
  const order = useAsync(() => api.getOrder(orderId), [api, orderId, version]);
  if (order.status === "error") return (
    <div className="page">
      <ErrorState title={`Couldn't open order ${orderId}`} error={order.error} onRetry={order.reload} />
      <p style={{ textAlign: "center" }}><Link to={paths.inbox()} className="btn">← Back to inbox</Link></p>
    </div>
  );
  if (!order.data) return <div className="page"><LoadingState label={`Opening ${orderId}…`} /></div>;
  if (order.data.approved) return <ApprovedView order={order.data} />;
  if (order.data.lines.length === 0) return (
    <div className="page">
      <header className="review-head">
        <div><p className="eyebrow">02 · Review <span className="muted">· {order.data.orderId}</span></p><h1>{order.data.retailer ?? "Unknown retailer"}</h1></div>
        <div className="approve-box">
          <button type="button" className="btn btn-primary btn-lg" disabled aria-describedby="approve-reason-empty">Approve order</button>
          <p id="approve-reason-empty" className="approve-reason">⚠ Nothing to approve: no product lines were found in this message</p>
        </div>
      </header>
      <div className="panel"><EmptyState title="No product lines found" action={<Link to={paths.inbox()} className="btn btn-primary">← Back to the paste box</Link>}>
      Check the paste: each order line needs a product and a quantity, like “parle g 10 wala 2 peti”. Greetings and notes such as “jaldi bhejna” are ignored.
    </EmptyState><pre className="source-text" style={{ borderTop: "1px solid var(--line)", margin: 0 }}>{order.data.text}</pre></div>
    </div>
  );
  return <ReviewDesk key={order.data.orderId} order={order.data} />;
}

const isTyping = (el: Element | null) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable);

function ReviewDesk({ order }: { order: Order }) {
  const { api, bump } = useApi();
  const navigate = useNavigate();
  const lines = order.lines;
  const reduce = useMemo(() => reducer(lines), [lines]);
  const [s, dispatch] = useReducer(reduce, order, initReview);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SkuSummary[]>([]);
  const [problems, setProblems] = useState<Map<string, string>>(new Map());
  const [toast, setToast] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<{ text: string; retry: boolean } | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const qtyRefs = useRef<(HTMLInputElement | null)[]>([]);

  const gate = approveGate(s.drafts);
  const total = s.drafts.reduce((a, d) => a + (lineAmount(d) ?? 0), 0);
  const resolved = s.drafts.filter(d => d.status !== "pending").length;
  const autoCount = s.drafts.filter(d => d.status === "auto").length;
  const cur = lines[s.cursor];

  // Options in the alternatives panel: model alternatives first, then catalog search hits.
  const options = useMemo(() => {
    const alts = cur ? cur.alternatives.map(a => ({ sku: a.sku as SkuRef | SkuSummary, p: a.p as number | null, fits: !!a.fits })) : [];
    // While the reviewer is searching, their results lead; the model's probability is kept where the SKU was shortlisted.
    if (query.trim()) return search.map(sku => { const a = alts.find(x => x.sku.skuId === sku.skuId); return { sku, p: a?.p ?? null, fits: a?.fits ?? false }; }).slice(0, 9);
    return alts.slice(0, 9);
  }, [cur, search, query]);
  // The retriever always returns its nearest SKUs, so say so when none of them mention what was typed.
  const weakSearch = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    return words.length > 0 && search.length > 0 && !search.some(x => words.some(w => x.label.toLowerCase().includes(w)));
  }, [query, search]);

  useEffect(() => { setQuery(""); setSearch([]); }, [s.cursor, s.altOpen]);
  useEffect(() => {
    if (!query.trim()) { setSearch([]); return; }
    let alive = true; const t = setTimeout(() => api.searchCatalog(query, 8).then(r => alive && setSearch(r), () => alive && setSearch([])), 120);
    return () => { alive = false; clearTimeout(t); };
  }, [query, api]);
  useEffect(() => { rowRefs.current[s.cursor]?.scrollIntoView({ block: "nearest" }); }, [s.cursor]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2600); return () => clearTimeout(t); }, [toast]);

  const say = (m: string) => setAnnounce(m);
  const describe = (d: Draft) => d.sku ? `${d.sku.label}, ${d.qty ?? "?"} ${UNIT_LABEL[d.unit]}` : "no SKU";

  const confirm = useCallback((i: number) => {
    const d = s.drafts[i]; const p = draftProblem(d);
    if (p) {
      const how = !d.sku ? "press a or 1–9 to pick one" : d.unit === "unspecified" ? "press u to choose a unit" : d.unit === "strip" ? "pick a sachet SKU (a) or change the unit (u)" : "press e to edit the quantity";
      setToast(`Line ${i + 1}: ${p}. ${how[0].toUpperCase()}${how.slice(1)}.`);
      if (!d.sku || d.unit === "strip") dispatch({ type: "openAlts" });
      return;
    }
    dispatch({ type: "confirm", index: i }); say(`Line ${i + 1} confirmed: ${describe(d)}`);
  }, [s.drafts]);

  const pick = useCallback((i: number, sku: SkuRef | SkuSummary) => {
    dispatch({ type: "pick", index: i, sku }); say(`Line ${i + 1} set to ${sku.label}`); gridRef.current?.focus();
    setProblems(p => { if (!p.has(lines[i].lineId)) return p; const n = new Map(p); n.delete(lines[i].lineId); return n; });
    // Alternatives carry only id, label and MRP. Look the SKU up for case/strip sizes so the amount can be shown.
    if (!isFullSku(sku)) api.searchCatalog(sku.label, 10).then(r => { const full = r.find(x => x.skuId === sku.skuId); if (full) dispatch({ type: "enrich", sku: full }); }, () => { /* amount stays "—" */ });
  }, [api, lines]);

  const stale = lines.flatMap((l, i) => (l.skuInCurrentCatalog === false && s.drafts[i].sku?.skuId === l.choice?.skuId && s.drafts[i].status !== "not_stocked" ? [i] : []));
  const approve = useCallback(async () => {
    if (!gate.ok || approving) { if (!gate.ok) setToast(gate.reason); return; }
    setApproving(true); setApproveError(null);
    try { await api.approveOrder(order.orderId, toApproveInput(lines, s.drafts)); bump(); navigate(paths.review(order.orderId), { replace: true, state: { justApproved: true } }); }
    catch (e) {
      setApproving(false);
      if (e instanceof ApiError && e.code === "unresolved_lines") {
        const m = new Map(e.lineProblems.map(p => [p.lineId, p.problem])); setProblems(m);
        const first = lines.findIndex(l => m.has(l.lineId)); if (first >= 0) dispatch({ type: "focus", index: first });
        setApproveError({ text: `${m.size} line${m.size === 1 ? "" : "s"} still need${m.size === 1 ? "s" : ""} a decision. They're highlighted below.`, retry: false });
      } else if (e instanceof ApiError && e.code === "already_approved") { bump(); navigate(0); }
      else { const d = describeError(e, "Approving"); setApproveError({ text: d.text, retry: d.retryable }); }
    }
  }, [gate, approving, api, order.orderId, lines, s.drafts, bump, navigate]);

  // Keyboard-first review. Keys are ignored while typing in a field (the field handles its own Enter/Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || (e.metaKey && e.key !== "Enter") || (e.ctrlKey && e.key !== "Enter")) return;
      if (isTyping(document.activeElement)) return;
      const i = s.cursor; const k = e.key;
      const handled = () => e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && k === "Enter") { handled(); void approve(); return; }
      if (s.altOpen) {
        if (k === "ArrowDown" || k === "j") { handled(); dispatch({ type: "altMove", delta: 1, count: options.length }); return; }
        if (k === "ArrowUp" || k === "k") { handled(); dispatch({ type: "altMove", delta: -1, count: options.length }); return; }
        if (k === "Enter") { handled(); const o = options[s.altIndex]; if (o) pick(i, o.sku); return; }
        if (k === "Escape" || k === "a") { handled(); dispatch({ type: "closeAlts" }); return; }
        if (k === "/") { handled(); searchRef.current?.focus(); return; }
      } else {
        if (k === "ArrowDown" || k === "j") { handled(); dispatch({ type: "move", delta: 1 }); return; }
        if (k === "ArrowUp" || k === "k") { handled(); dispatch({ type: "move", delta: -1 }); return; }
        if (k === "Enter") { handled(); confirm(i); return; }
        if (k === "a" || k === " ") { handled(); dispatch({ type: "openAlts" }); return; }
        if (k === "/") { handled(); dispatch({ type: "openAlts" }); setTimeout(() => searchRef.current?.focus(), 0); return; }
        if (k === "n") { handled(); const n = s.drafts.findIndex((d, x) => x > i && d.status === "pending"); const m = n >= 0 ? n : s.drafts.findIndex(d => d.status === "pending"); if (m >= 0) dispatch({ type: "focus", index: m }); return; }
      }
      if (/^[1-9]$/.test(k)) { const o = options[Number(k) - 1]; if (o) { handled(); pick(i, o.sku); } return; }
      if (k === "x" || k === "0") { handled(); dispatch({ type: "notStocked", index: i }); say(`Line ${i + 1} marked not stocked`); return; }
      if (k === "u") { handled(); dispatch({ type: "cycleUnit", index: i }); return; }
      if (k === "e") { handled(); qtyRefs.current[i]?.focus(); qtyRefs.current[i]?.select(); return; }
      if (k === "+" || k === "=") { handled(); dispatch({ type: "qty", index: i, qty: (s.drafts[i].qty ?? 0) + 1 }); return; }
      if (k === "-") { handled(); dispatch({ type: "qty", index: i, qty: Math.max(1, (s.drafts[i].qty ?? 2) - 1) }); return; }
      if (k === "z") { handled(); dispatch({ type: "revert", index: i }); say(`Line ${i + 1} reverted`); return; }
      if (k === "?") { handled(); setShowHelp(h => !h); return; }
      if (k === "Escape") { setShowHelp(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s, options, approve, confirm, pick]);

  return (
    <div className="page">
      <header className="review-head">
        <div>
          <p className="eyebrow">02 · Review <span className="muted">· {order.orderId}</span></p>
          <h1>{order.retailer ?? "Unknown retailer"}</h1>
          <div className="meta-row">
            <span><ChannelLabel channel={order.channel} /></span>
            <span>Received <b>{formatTime(order.createdAt)}</b></span>
            {order.source.kind === "whatsapp_export" && <span title={`Import ${order.source.importId}, from line ${order.source.firstLine} of the export`}>Chat import · <b>{order.source.messageCount}</b> message{order.source.messageCount === 1 ? "" : "s"}</span>}
            <span><b>{order.summary.lines}</b> lines · <b>{order.summary.auto}</b> auto · <b style={{ color: order.summary.needsReview ? "var(--warn-ink)" : undefined }}>{order.summary.needsReview}</b> to review</span>
            <span title={`$${order.usage.costUsd} · ${order.usage.inputTokens} input tokens · ${order.usage.requests} request${order.usage.llmFallback ? ` · includes AI line-reading for ${order.usage.llmFallback.lines} line(s), $${order.usage.llmFallback.costUsd}` : ""}`}>Model cost <b>₹{order.usage.costInr.toFixed(4)}</b></span>
            <span title="Calibrated confidence needed to auto-accept a line">Auto-accept at <b>{(order.threshold * 100).toFixed(1)}%</b></span>
            <span>Adapter <b>{order.adapter}</b></span>
          </div>
        </div>
        <div className="approve-box">
          <div style={{ textAlign: "right" }}>
            <div className="total-label">Order value · at MRP</div>
            <div className="total" aria-live="polite">{formatInr(total)}</div>
          </div>
          {<button type="button" className="btn btn-primary btn-lg" onClick={approve} disabled={!gate.ok || approving} aria-describedby="approve-reason" aria-keyshortcuts="Control+Enter Meta+Enter">
                {approving ? <><span className="spinner" aria-hidden="true" /> Approving…</> : "Approve order"}
              </button>}
          {<p id="approve-reason" className={`approve-reason${gate.ok ? " ready" : ""}`}>
            {gate.ok ? <>✓ {gate.reason}. <Kbd>⌘</Kbd><Kbd>Enter</Kbd> to approve</> : <>⚠ {gate.reason}</>}
          </p>}
        </div>
      </header>

      {approveError && <div className="banner error" role="alert"><span className="grow">Approve failed: {approveError.text}</span>{approveError.retry && <button type="button" className="btn btn-sm" onClick={approve}>Retry</button>}</div>}
      {order.catalogStale && <div className="banner warn" role="note"><span className="badge warn">Catalog changed</span><span className="grow">This order was parsed on an older catalog ({order.catalogVersion}).{stale.length ? <> {stale.length} picked SKU{stale.length === 1 ? " is" : "s are"} no longer in the current catalog (line{stale.length === 1 ? "" : "s"} {stale.map(i => i + 1).join(", ")}); pick a current SKU or a DMS/Tally import may reject {stale.length === 1 ? "it" : "them"}.</> : " Every picked SKU is still in the current catalog."}</span></div>}
      {order.summary.needsReview === 0 && <div className="banner ok"><span className="grow">Every line was auto-accepted. Check the total and approve with one click.</span></div>}

      <div className="review-grid">
        <SourcePanel order={order} state={s} onSelect={i => dispatch({ type: "focus", index: i })} />

        <section className="panel" aria-labelledby="lines-h">
          <div className="panel-head">
            <h2 id="lines-h">Order lines</h2>
            <div className="progress" style={{ minWidth: 260 }}>
              <span className="num">{resolved}/{lines.length} resolved</span>
              <span className="progress-bar" aria-hidden="true">
                <span className="p-auto" style={{ width: `${(autoCount / lines.length) * 100}%` }} />
                <span className="p-done" style={{ width: `${((resolved - autoCount) / lines.length) * 100}%` }} />
              </span>
            </div>
          </div>
          <div className="lines-head" aria-hidden="true">
            <span>#</span><span>Retailer wrote</span><span>Qty · unit</span><span>SKU</span><span>Confidence</span><span className="r">Amount</span>
          </div>
          <div ref={gridRef} className="lines" role="grid" aria-label="Order lines. j and k move, Enter confirms, a opens alternatives." aria-rowcount={lines.length} tabIndex={0}
            aria-activedescendant={`line-${s.cursor}`}>
            {lines.map((l, i) => (
              <LineRow key={l.lineId} index={i} line={l} draft={s.drafts[i]} active={i === s.cursor} threshold={order.threshold} problem={problems.get(l.lineId)}
                rowRef={el => { rowRefs.current[i] = el; }} qtyRef={el => { qtyRefs.current[i] = el; }}
                onFocus={() => dispatch({ type: "focus", index: i })}
                onToggleAlts={() => { dispatch({ type: "focus", index: i }); dispatch({ type: s.altOpen && i === s.cursor ? "closeAlts" : "openAlts" }); }}
                onConfirm={() => confirm(i)}
                onQty={q => dispatch({ type: "qty", index: i, qty: q })}
                onUnit={u => { dispatch({ type: "unit", index: i, unit: u }); }}
                onDone={() => gridRef.current?.focus()}
                alts={i === s.cursor && s.altOpen ? (
                  <AltPanel options={options} weak={weakSearch} active={s.altIndex} query={query} setQuery={setQuery} searchRef={searchRef} line={l}
                    onPick={sku => pick(i, sku)} onNotStocked={() => { dispatch({ type: "notStocked", index: i }); gridRef.current?.focus(); }}
                    onClose={() => { dispatch({ type: "closeAlts" }); gridRef.current?.focus(); }}
                    onMove={d => dispatch({ type: "altMove", delta: d, count: options.length })} />
                ) : null} />
            ))}
          </div>
        </section>
      </div>

      {(
        <div className="shortcut-bar" role="note" aria-label="Keyboard shortcuts">
          <span className="only-sm">Keyboard shortcuts available on desktop</span>
          <span className="opt"><Kbd>j</Kbd><Kbd>k</Kbd> move</span>
          <span className="opt"><Kbd>Enter</Kbd> confirm</span>
          <span className="opt"><Kbd>a</Kbd> alternatives</span>
          <span className="opt"><Kbd>1</Kbd>–<Kbd>9</Kbd> pick</span>
          <span className="opt"><Kbd>0</Kbd> not stocked</span>
          <span className="opt"><Kbd>u</Kbd> unit</span>
          <span className="opt"><Kbd>e</Kbd> qty</span>
          <span className="opt"><Kbd>n</Kbd> next flagged</span>
          {showHelp && <>
            <span><Kbd>/</Kbd> search catalog</span><span><Kbd>+</Kbd><Kbd>-</Kbd> qty</span><span><Kbd>z</Kbd> revert line</span><span><Kbd>Esc</Kbd> close</span>
          </>}
          <span className="grow" />
          <span className="opt"><Kbd>⌘</Kbd><Kbd>Enter</Kbd> approve</span>
          <button type="button" className="btn btn-sm btn-ghost opt" style={{ color: "inherit" }} onClick={() => setShowHelp(h => !h)} aria-expanded={showHelp}><Kbd>?</Kbd> {showHelp ? "Less" : "More"}</button>
        </div>
      )}
      <div className="sr-only" aria-live="polite">{announce}</div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function SourcePanel({ order, state, onSelect }: { order: Order; state: ReviewState; onSelect: (i: number) => void }) {
  // Find each line's raw span in the original message, in order, so the message reads as it was sent.
  const parts = useMemo(() => {
    const out: { text: string; line?: number }[] = []; let pos = 0; const t = order.text;
    order.lines.forEach((l, i) => {
      const at = t.indexOf(l.raw, pos);
      if (at < 0) return;
      if (at > pos) out.push({ text: t.slice(pos, at) });
      out.push({ text: l.raw, line: i }); pos = at + l.raw.length;
    });
    out.push({ text: t.slice(pos) });
    return out;
  }, [order]);
  return (
    <aside className="panel source" aria-labelledby="src-h">
      <div className="panel-head"><h2 id="src-h">Original message</h2><ChannelLabel channel={order.channel} /></div>
      <div className="source-text">
        {parts.map((p, k) => p.line === undefined ? <span key={k}>{p.text}</span> : (
          <mark key={k} className={`${state.cursor === p.line ? "active" : ""} ${state.drafts[p.line].status === "pending" ? "flag" : ""}`}
            onClick={() => onSelect(p.line!)} title={`Line ${p.line + 1}`}>{p.text}</mark>
        ))}
      </div>
      <div className="panel-body" style={{ borderTop: "1px solid var(--line)", fontSize: 11.5 }} >
        <span className="muted">Chatter lines (“jaldi bhejna”, greetings, signatures) are ignored. Underlined spans became order lines.</span>
      </div>
    </aside>
  );
}

interface RowProps {
  index: number; line: ParsedLine; draft: Draft; active: boolean; threshold: number; problem?: string;
  rowRef: (el: HTMLDivElement | null) => void; qtyRef: (el: HTMLInputElement | null) => void;
  onFocus: () => void; onToggleAlts: () => void; onConfirm: () => void; onQty: (q: number | null) => void; onUnit: (u: OrderUnit) => void; onDone: () => void;
  alts: React.ReactNode;
}

const STATUS_TEXT: Record<Draft["status"], string> = { auto: "Auto-accepted", pending: "Needs review", confirmed: "Confirmed", changed: "Changed", not_stocked: "Not stocked" };

function LineRow(p: RowProps) {
  const { line: l, draft: d } = p;
  const amount = lineAmount(d);
  const units = unitsAllowed(d.sku);
  const flagged = l.route === "review";
  const staleSku = l.skuInCurrentCatalog === false && d.sku?.skuId === l.choice?.skuId && d.status !== "not_stocked";
  return (
    <>
      <div ref={p.rowRef} id={`line-${p.index}`} className="line" role="row" aria-rowindex={p.index + 1} aria-selected={p.active}
        data-state={d.status} data-none={!d.sku} data-problem={!!p.problem} onMouseDown={p.onFocus}
        aria-label={`Line ${p.index + 1}: ${l.raw}. ${STATUS_TEXT[d.status]}${l.reasons.length ? `, flagged ${l.reasons.join(", ").replace(/_/g, " ")}` : ""}`}>
        <span className="c-no line-no" role="gridcell">{p.index + 1}</span>
        <div className="c-raw" role="gridcell">
          <div className="line-raw">{l.raw}</div>
          {(flagged || (l.unitDefaulted && d.unit === l.unit) || l.extractedBy === "llm" || staleSku) && <div className="line-reasons">
            {staleSku && <span className="tag danger" title="The catalog was replaced after this order was parsed and no longer has this SKU. Pick a current one (a or /).">Not in current catalog</span>}
            {flagged && l.reasons.map(r => <ReasonTag key={r} reason={r} short />)}
            {flagged && l.otherReasons.map(r => <span key={r} className="tag">{r.replace(/_/g, " ")}</span>)}
            {l.unitDefaulted && d.unit === l.unit && <span className="tag neutral" title={`The retailer wrote a bare number, so the distributor default unit (${UNIT_LABEL[l.unit]}) was assumed. Press u to change it.`}>assumed {UNIT_LABEL[l.unit]}</span>}
            {l.extractedBy === "llm" && <span className="tag neutral" title="The rules couldn't read this line, so the AI fallback read the product and quantity. Check the qty.">AI-read qty</span>}
          </div>}
          {p.problem && <div className="line-problem" role="alert">{p.problem}</div>}
        </div>
        <div className="c-qty qty" role="gridcell">
          <label className="sr-only" htmlFor={`qty-${p.index}`}>Quantity for line {p.index + 1}</label>
          <input id={`qty-${p.index}`} ref={p.qtyRef} type="number" min={1} step="any" inputMode="decimal" value={d.qty ?? ""} disabled={d.status === "not_stocked"}
            aria-invalid={d.qty === null} onFocus={p.onFocus}
            onChange={e => p.onQty(e.target.value === "" ? null : Number(e.target.value))}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); p.onDone(); p.onConfirm(); } if (e.key === "Escape") p.onDone(); }} />
          <label className="sr-only" htmlFor={`unit-${p.index}`}>Unit for line {p.index + 1}</label>
          <select id={`unit-${p.index}`} value={d.unit} disabled={d.status === "not_stocked"} aria-invalid={d.unit === "unspecified" || !(units as OrderUnit[]).includes(d.unit)} onFocus={p.onFocus}
            onChange={e => { p.onUnit(e.target.value as OrderUnit); p.onDone(); }}>
            {d.unit === "unspecified" && <option value="unspecified">unit?</option>}
            {d.unit !== "unspecified" && !(units as OrderUnit[]).includes(d.unit) && <option value={d.unit}>{UNIT_LABEL[d.unit]} (n/a)</option>}
            {units.map(u => <option key={u} value={u} title={UNIT_HINT[u]}>{UNIT_LABEL[u]}</option>)}
          </select>
        </div>
        <div className="c-sku sku" role="gridcell">
          <div className="sku-main">
            {d.sku ? <>
              <div className="sku-name" title={d.sku.label}>{d.sku.label}</div>
              <div className="sku-sub"><span className="mono">{d.sku.skuId}</span>{d.sku.mrpInr !== null ? ` · MRP ${formatInr(d.sku.mrpInr)}` : ""}{isFullSku(d.sku) ? ` · case of ${d.sku.caseQty}${d.sku.stripQty ? ` · strip of ${d.sku.stripQty}` : ""}` : ""}</div>
            </> : <div className="sku-none">{d.status === "not_stocked" ? "Not stocked" : "None of these"}<div className="sku-sub" style={{ fontWeight: 400 }}>{d.status === "not_stocked" ? "Left out of the order" : "No shortlisted SKU matched"}</div></div>}
            <div className="line-status">
              <span className={`badge ${d.status === "pending" ? "warn" : d.status === "not_stocked" ? "plain" : "ok"}`}>{STATUS_TEXT[d.status]}</span>
              {d.status === "pending" && p.active && <span className="muted hint">{d.sku ? <><Kbd>Enter</Kbd> confirm</> : <><Kbd>a</Kbd> pick a SKU</>}</span>}
            </div>
          </div>
          {<button type="button" className="btn btn-sm" onClick={p.onToggleAlts} aria-expanded={p.active && !!p.alts} aria-haspopup="listbox"
            aria-label={`Alternatives for line ${p.index + 1}`} title="Alternatives (a)">
            Change <span aria-hidden="true">▾</span>
          </button>}
        </div>
        <div className="c-conf" role="gridcell">{l.choice ? <Confidence value={l.confidence} threshold={p.threshold} accepted={l.route === "auto"} /> : <span className="conf-val muted">{l.pNone !== null ? `none ${Math.round(l.pNone * 100)}%` : "—"}</span>}</div>
        <div className="c-amt r amount" role="gridcell">{amount !== null ? formatInr(amount) : <span className="muted" title={d.sku && !isFullSku(d.sku) ? "Looking up pack size…" : "Needs a SKU, quantity and unit"}>—</span>}</div>
      </div>
      {p.alts}
    </>
  );
}

interface AltProps {
  options: { sku: SkuRef | SkuSummary; p: number | null; fits: boolean }[]; weak: boolean; active: number; query: string; setQuery: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>; line: ParsedLine;
  onPick: (s: SkuRef | SkuSummary) => void; onNotStocked: () => void; onClose: () => void; onMove: (d: number) => void;
}

function AltPanel(p: AltProps) {
  const listId = `alts-${p.line.lineId}`;
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => { boxRef.current?.scrollIntoView({ block: "nearest" }); }, []);
  return (
    <div ref={boxRef} className="alts" role="dialog" aria-label={`Alternatives for “${p.line.raw}”`}>
      <div className="alts-head">
        <label className="sr-only" htmlFor={`${listId}-q`}>Search the catalog</label>
        <input id={`${listId}-q`} ref={p.searchRef} className="input" placeholder="Search catalog: brand, product, size…  ( / )" value={p.query} onChange={e => p.setQuery(e.target.value)}
          role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={`${listId}-${p.active}`} autoComplete="off"
          onKeyDown={e => {
            if (e.key === "ArrowDown") { e.preventDefault(); p.onMove(1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); p.onMove(-1); }
            else if (e.key === "Enter") { e.preventDefault(); const o = p.options[p.active]; if (o) p.onPick(o.sku); }
            else if (e.key === "Escape") { e.preventDefault(); p.onClose(); }
          }} />
        <button type="button" className="btn btn-sm btn-danger" onClick={p.onNotStocked}><Kbd>0</Kbd> None / not stocked</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={p.onClose} aria-label="Close alternatives"><Kbd>Esc</Kbd></button>
      </div>
      <ul id={listId} role="listbox" aria-label="Alternatives">
        {p.weak && <li className="alt-note" role="presentation">Nothing in the catalog mentions “{p.query.trim()}”. Closest SKUs below; if none fit, press <Kbd>0</Kbd> to mark it not stocked.</li>}
        {p.options.length === 0 && <li className="muted" style={{ padding: "10px 12px" }}>No matches. Try a brand or size, or mark the line not stocked.</li>}
        {p.options.map((o, i) => (
          <li key={o.sku.skuId} id={`${listId}-${i}`} role="option" aria-selected={i === p.active} className="alt" onMouseDown={e => { e.preventDefault(); p.onPick(o.sku); }}>
            <Kbd>{String(i + 1)}</Kbd>
            <span style={{ minWidth: 0 }}>
              <span className="sku-name" style={{ display: "block" }}>{o.sku.label}</span>
              <span className="sku-sub"><span className="mono">{o.sku.skuId}</span>{isFullSku(o.sku) ? ` · ${o.sku.packSize}${o.sku.packUnit} · case of ${o.sku.caseQty}` : ""}{o.p === null ? " · from catalog search" : ""}</span>
            </span>
            <span className="num" style={{ textAlign: "right" }}>{o.fits ? <span className="fits" title="Matches everything the retailer wrote; only the pack size or variant is open">fits · </span> : null}{o.sku.mrpInr !== null ? formatInr(o.sku.mrpInr) : "—"}</span>
            <span className="p">{o.p === null ? "" : o.p < 0.001 ? "<0.1%" : `${(o.p * 100).toFixed(o.p < 0.01 ? 1 : 0)}%`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
