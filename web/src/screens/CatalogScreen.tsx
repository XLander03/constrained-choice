import { useRef, useState, type DragEvent } from "react";
import { ApiError, type CatalogUploadResult } from "../api/types.ts";
import { useApi } from "../app/api-context.tsx";
import { ErrorState } from "../components/States.tsx";
import { previewCatalog, type CatalogPreview } from "../lib/catalogPreview.ts";
import { formatTime } from "../lib/domain.ts";
import { useAsync } from "../lib/useAsync.ts";

// A Tally-style export: different header names, size in the product name. Matches API.md's column synonyms.
const EXAMPLE_TALLY = `Item Code,Item Name,Brand,MRP,Units per case,Group,Synonyms
K1,Kurkure Masala Munch 90g,PepsiCo,20,60,snacks,kurkure|kurkure masala
K2,Kurkure Masala Munch 40g,PepsiCo,10,120,snacks,kurkure 10 wala|kurkure chota
T1,Tata Salt 1kg,Tata,28,25,staples,tata namak|namak
F1,Fortune Soyabean Oil 1L,Fortune,165,12,staples,fortune oil|soya tel
P1,Parle-G Biscuit 55g,Parle,5,144,biscuits,parle g|parle g 5 wala
P2,Parle-G Biscuit 110g,Parle,10,96,biscuits,parle g 10 wala
`;
const EXAMPLE_ERRORS = `sku_id,product,brand,mrp_inr,case_qty
A10,Amul Butter 100g,Amul,60,40
,Haldiram Bhujia 200g,Haldiram,55,48
A12,,Amul,30,96
A10,Amul Butter 500g,Amul,275,20
B20,Bru Instant Coffee 2g,Bru,2,960
`;

type Step =
  | { kind: "pick" }
  | { kind: "preview"; csv: string; name: string; preview: CatalogPreview }
  | { kind: "uploading"; csv: string; name: string; preview: CatalogPreview }
  | { kind: "rejected"; csv: string; name: string; preview: CatalogPreview; serverErrors: string[]; message: string }
  | { kind: "done"; name: string; result: CatalogUploadResult }
  | { kind: "error"; error: Error; retry: () => void };

const FIELD_LABEL: Record<string, string> = { sku_id: "SKU id", product: "Product", brand: "Brand", variant: "Variant", pack_size: "Pack size", pack_unit: "Pack unit", mrp_inr: "MRP", case_qty: "Units per case", strip_qty: "Units per strip", category: "Category", aliases: "Aliases" };

export function CatalogScreen() {
  const { api, version, bump } = useApi();
  const info = useAsync(() => api.catalogInfo(), [api, version]);
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [over, setOver] = useState(false);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [resetting, setResetting] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const preview = (csv: string, name: string) => { setOnlyErrors(false); setStep({ kind: "preview", csv, name, preview: previewCatalog(csv) }); };
  async function readFile(f: File) {
    if (!/\.(csv|txt)$/i.test(f.name) && !/csv|text\/plain/.test(f.type)) { setStep({ kind: "error", error: new Error(`${f.name} isn't a CSV file. Export the item master as CSV first.`), retry: () => setStep({ kind: "pick" }) }); return; }
    if (f.size > 5 * 1024 * 1024) { setStep({ kind: "error", error: new Error("That file is over 5 MB, the API's limit. Split it or drop unused columns."), retry: () => setStep({ kind: "pick" }) }); return; }
    preview(await f.text(), f.name);
  }
  async function upload(csv: string, name: string, p: CatalogPreview) {
    setStep({ kind: "uploading", csv, name, preview: p });
    try { const result = await api.uploadCatalog(csv); bump(); setStep({ kind: "done", name, result }); }
    catch (e) {
      if (e instanceof ApiError && e.code === "invalid_catalog") setStep({ kind: "rejected", csv, name, preview: p, serverErrors: e.catalogErrors, message: e.message });
      else setStep({ kind: "error", error: e as Error, retry: () => void upload(csv, name, p) });
    }
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void readFile(f); };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">04 · Catalog</p>
          <h1>Catalog</h1>
          <p className="lede">Upload an item master as CSV. Tally, Busy and Marg exports usually work as they are. A valid upload replaces the whole catalog; an invalid one changes nothing.</p>
        </div>
        {info.data && (
          <div className="cat-info" aria-label="Current catalog">
            <span className={`badge ${info.data.dataLabel === "SYNTHETIC" ? "warn" : "ok"}`}>{info.data.dataLabel === "SYNTHETIC" ? "Synthetic" : "Uploaded"}</span>
            <span><b className="num">{info.data.skuCount}</b> SKUs</span>
            <span className="muted">loaded {formatTime(info.data.loadedAt)}</span>
            <span className="muted mono">{info.data.version}</span>
            {api.reset && <button type="button" className="btn btn-sm btn-ghost" disabled={resetting} onClick={async () => { setResetting(true); await api.reset!(); bump(); setResetting(false); setStep({ kind: "pick" }); }}
              title="Mock only: restore the synthetic catalog and the demo orders">{resetting ? "Resetting…" : "Reset demo data"}</button>}
          </div>
        )}
      </header>

      {step.kind === "pick" && (
        <div style={{ display: "grid", gap: 14 }}>
          <div className="drop" data-over={over} role="button" tabIndex={0} aria-label="Choose a catalog CSV file, or drop one here"
            onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
            onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
            <strong>Drop a CSV here, or choose a file</strong>
            <span className="muted">Needs an SKU id column (<span className="mono">sku_id, item_code, code…</span>) and a product name column (<span className="mono">product, item_name, name…</span>). MRP, units per case, pack size, strip size, category and aliases are optional. Max 5 MB.</span>
            <span className="btn btn-primary" aria-hidden="true">Choose file</span>
            <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" tabIndex={-1} onChange={e => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ""; }} />
          </div>
          <p className="muted" style={{ textAlign: "center", display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", alignItems: "center" }}>
            No file handy?
            <button type="button" className="btn btn-sm" onClick={() => preview(EXAMPLE_TALLY, "tally-export-example.csv")}>Tally-style example</button>
            <button type="button" className="btn btn-sm" onClick={() => preview(EXAMPLE_ERRORS, "example-with-errors.csv")}>Example with errors</button>
          </p>
        </div>
      )}
      {step.kind === "error" && <div className="panel"><ErrorState title="Upload failed" error={step.error} onRetry={step.retry} /><p style={{ textAlign: "center", paddingBottom: 20 }}><button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: "pick" })}>Start over</button></p></div>}
      {step.kind === "done" && <UploadDone name={step.name} r={step.result} onAgain={() => setStep({ kind: "pick" })} />}
      {(step.kind === "preview" || step.kind === "uploading" || step.kind === "rejected") && (
        <PreviewView name={step.name} p={step.preview} busy={step.kind === "uploading"} onlyErrors={onlyErrors} setOnlyErrors={setOnlyErrors}
          serverErrors={step.kind === "rejected" ? step.serverErrors : null} serverMessage={step.kind === "rejected" ? step.message : null}
          currentCount={info.data?.skuCount ?? null}
          onCancel={() => setStep({ kind: "pick" })} onConfirm={() => upload(step.csv, step.name, step.preview)} />
      )}
    </div>
  );
}

function Mapping({ columns }: { columns: Record<string, string | null> }) {
  return (
    <div className="mapping">{Object.entries(columns).map(([k, v]) => (
      <div key={k}><div className="k">{FIELD_LABEL[k] ?? k}</div><div className={`v${v ? "" : " none"}`}>{v ?? "not found"}</div></div>
    ))}</div>
  );
}

function UploadDone({ name, r, onAgain }: { name: string; r: CatalogUploadResult; onAgain: () => void }) {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="banner ok" role="status"><span className="badge solid">Loaded</span><span className="grow"><b>{r.skuCount} SKUs</b> from {name} are now the catalog ({r.version}). New orders are matched against it.</span><button type="button" className="btn btn-sm" onClick={onAgain}>Upload another</button></div>
      <div className="banner warn"><span className="grow">{r.note}</span></div>
      {r.warnings.length > 0 && <section className="panel"><div className="panel-head"><h2>Warnings</h2></div><ul className="err-list warn">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></section>}
      <section className="panel"><div className="panel-head"><h2>Detected columns</h2><span className="muted" style={{ fontSize: 11.5 }}>Field ← header in your file</span></div><Mapping columns={r.columns} /></section>
    </div>
  );
}

function PreviewView({ name, p, busy, onlyErrors, setOnlyErrors, serverErrors, serverMessage, currentCount, onCancel, onConfirm }: {
  name: string; p: CatalogPreview; busy: boolean; onlyErrors: boolean; setOnlyErrors: (b: boolean) => void;
  serverErrors: string[] | null; serverMessage: string | null; currentCount: number | null; onCancel: () => void; onConfirm: () => void;
}) {
  const errors = serverErrors ?? p.errors;
  const rows = p.rows.map((r, i) => ({ r, line: i + 2 })).filter(x => !onlyErrors || p.rowErrors.has(x.line));
  const shown = rows.slice(0, 200);
  const ok = errors.length === 0 && p.skuCount > 0;
  // Which header column each error points at, for cell highlighting.
  const errCol = (msg: string) => /SKU id/i.test(msg) ? p.columns.sku_id : /product name/i.test(msg) ? p.columns.product : null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14 }}>
      <div className="summary-strip">
        <div><p className="eyebrow">File</p><div className="mono" style={{ marginTop: 6, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div></div>
        <div><p className="eyebrow">Rows</p><div className="v">{p.totalRows}</div></div>
        <div><p className="eyebrow">SKUs read</p><div className="v">{p.skuCount}{currentCount !== null ? <span className="muted" style={{ fontSize: 13, fontFamily: "var(--font-sans)" }}> · replaces {currentCount}</span> : null}</div></div>
        <div><p className="eyebrow" style={{ color: errors.length ? "var(--danger)" : undefined }}>Errors</p><div className="v" style={{ color: errors.length ? "var(--danger)" : undefined }}>{errors.length}</div></div>
      </div>

      {serverMessage && <div className="banner error" role="alert"><span className="grow">The API rejected the file: {serverMessage}</span></div>}
      {errors.length > 0 && (
        <section className="panel" aria-labelledby="err-h">
          <div className="panel-head"><h2 id="err-h">{errors.length} error{errors.length > 1 ? "s" : ""} to fix</h2><span className="muted" style={{ fontSize: 11.5 }}>The whole file is rejected until these are fixed; the current catalog stays as it is</span></div>
          <ul className="err-list">{errors.map((e, i) => { const m = /^row (\d+):\s*(.*)$/.exec(e); return <li key={i}><span className="mono">{m ? `Row ${m[1]}` : "File"}</span><span>{m ? m[2] : e}</span></li>; })}</ul>
        </section>
      )}
      {p.warnings.length > 0 && (
        <section className="panel" aria-labelledby="warn-h">
          <div className="panel-head"><h2 id="warn-h">{p.warnings.length} warning{p.warnings.length > 1 ? "s" : ""}</h2><span className="muted" style={{ fontSize: 11.5 }}>Uploads fine, but matching will be weaker</span></div>
          <ul className="err-list warn">{p.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </section>
      )}
      {Object.keys(p.columns).length > 0 && <section className="panel"><div className="panel-head"><h2>Detected columns</h2><span className="muted" style={{ fontSize: 11.5 }}>Field ← header in your file</span></div><Mapping columns={p.columns} /></section>}

      {p.rows.length > 0 && (
        <section className="panel" aria-labelledby="prev-h">
          <div className="panel-head">
            <h2 id="prev-h">Preview</h2>
            {p.rowErrors.size > 0 && <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12 }}><input type="checkbox" checked={onlyErrors} onChange={e => setOnlyErrors(e.target.checked)} /> Only rows with errors</label>}
          </div>
          <div className="table-wrap" style={{ maxHeight: 380 }}>
            <table className="table">
              <thead><tr><th>Row</th><th>Status</th>{p.header.map((c, i) => <th key={i} className="mono" style={{ textTransform: "none", letterSpacing: 0 }}>{c}</th>)}</tr></thead>
              <tbody>{shown.map(({ r, line }) => {
                const errs = p.rowErrors.get(line); const cols = new Set((errs ?? []).map(errCol));
                return (
                  <tr key={line}>
                    <td className="muted num">{line}</td>
                    <td>{errs ? <span className="badge danger" title={errs.join("; ")}>{errs[0]}</span> : <span className="badge ok">OK</span>}</td>
                    {p.header.map((c, i) => <td key={i} className={errs && cols.has(c) ? "cell-err" : undefined} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r[i] || <span className={errs && cols.has(c) ? "" : "muted"} style={errs && cols.has(c) ? { color: "var(--danger)" } : undefined}>{errs && cols.has(c) ? "empty" : "—"}</span>}
                    </td>)}
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          {rows.length > shown.length && <div className="panel-body muted" style={{ borderTop: "1px solid var(--line)" }}>Showing the first {shown.length} of {rows.length} rows.</div>}
        </section>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>{ok ? "Cancel" : "Choose another file"}</button>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 12 }}>{ok ? `This replaces the current catalog${currentCount !== null ? ` of ${currentCount} SKUs` : ""}.` : "Fix the errors in the file and choose it again."}</span>
          <button type="button" className="btn btn-primary btn-lg" onClick={onConfirm} disabled={busy || !ok}>
            {busy ? <><span className="spinner" aria-hidden="true" /> Uploading…</> : `Replace catalog with ${p.skuCount} SKU${p.skuCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
