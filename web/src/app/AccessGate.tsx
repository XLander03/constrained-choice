import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiBase } from "../api/index.ts";
import { setToken } from "../api/token.ts";

/** Asks for the API token (API.md "Access control": API_TOKEN on the server → every request needs `Authorization: Bearer`).
 *  The value only goes to token.ts (memory, optionally sessionStorage); nothing is written to the build or to VITE_* variables. */
export function TokenDialog({ rejected, onSubmit, onCancel, busy }: { rejected: boolean; onSubmit: () => void; onCancel?: () => void; busy?: boolean }) {
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = (e: FormEvent) => { e.preventDefault(); if (!value.trim()) return; setToken(value, remember); onSubmit(); };
  return (
    <div className="gate-backdrop">
      <form className="gate panel" role="dialog" aria-modal="true" aria-labelledby="gate-h" aria-describedby="gate-d" onSubmit={submit}>
        <div className="panel-head"><h2 id="gate-h">API token needed</h2><span className="badge warn">401</span></div>
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          <p id="gate-d" style={{ margin: 0 }}>The order desk API at <span className="mono">{apiBase}</span> is protected with a token (<span className="mono">API_TOKEN</span> on the server). Ask whoever runs it for the token.</p>
          {rejected && <div className="banner error" role="alert" style={{ margin: 0 }}><span className="grow">The server rejected that token. Check it and enter it again.</span></div>}
          <label className="field"><span>API token</span>
            <input ref={ref} className="input mono" type="password" autoComplete="off" spellCheck={false} value={value} onChange={e => setValue(e.target.value)} minLength={16} required aria-invalid={rejected} /></label>
          <label className="check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember for this browser tab <span className="muted">(sessionStorage, cleared when the tab closes)</span></label>
          <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>It's sent only to this API as <span className="mono">Authorization: Bearer …</span> and never stored in the app build.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
            <button type="submit" className="btn btn-primary" disabled={!value.trim() || busy}>{busy ? <><span className="spinner" aria-hidden="true" /> Checking…</> : "Use token"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

/** 403 origin_not_allowed / host_not_allowed: nothing the clerk can fix from inside the page except opening the right address. */
export function OriginBlocked({ code, onRetry }: { code: string; onRetry: () => void }) {
  const here = window.location.origin;
  const alt = here.includes("127.0.0.1") ? here.replace("127.0.0.1", "localhost") : null;
  return (
    <div className="page"><div className="state error" role="alert" style={{ maxWidth: 640, margin: "48px auto" }}>
      <h3>{code === "host_not_allowed" ? "The server only answers localhost" : "This address isn't allowed by the server"}</h3>
      {code === "host_not_allowed"
        ? <p>Without a token, the API only answers requests sent to <span className="mono">localhost</span>. Point <span className="mono">VITE_API_BASE</span> at <span className="mono">http://localhost:8787</span> or <span className="mono">http://127.0.0.1:8787</span>, or set <span className="mono">API_TOKEN</span> on the server.</p>
        : <p>The API at <span className="mono">{apiBase}</span> refused requests from <span className="mono">{here}</span>. It only accepts the origins in <span className="mono">ALLOWED_ORIGINS</span> (default <span className="mono">http://localhost:5173</span> and <span className="mono">http://localhost:5174</span>).</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
        {alt && <a className="btn btn-primary" href={alt + window.location.pathname}>Open {alt}</a>}
        <button type="button" className="btn" onClick={onRetry}>Try again</button>
      </div>
    </div></div>
  );
}
