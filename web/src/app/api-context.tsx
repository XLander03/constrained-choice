import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getApi, type OrderDeskApi } from "../api/index.ts";
import { getToken, subscribeUnauthorized } from "../api/token.ts";
import { ApiError, type Health } from "../api/types.ts";
import { ErrorState, LoadingState } from "../components/States.tsx";
import { OriginBlocked, TokenDialog } from "./AccessGate.tsx";

interface Ctx { api: OrderDeskApi; health: Health; version: number; bump: () => void }
const ApiCtx = createContext<Ctx | null>(null);

/** Resolves the API client and /health once; `version` bumps after any mutation so views refetch.
 *  Access problems are handled here, once: 401 → token prompt (startup page, or a dialog over the open screen so drafts survive);
 *  403 origin/host → an explanation instead of a generic error. */
export function ApiProvider({ children }: { children: ReactNode }) {
  const [api, setApi] = useState<OrderDeskApi | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [version, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [needToken, setNeedToken] = useState<false | "first" | "rejected">(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true; setChecking(true);
    getApi().then(async a => { const h = await a.health(); if (alive) { setApi(a); setHealth(h); setNeedToken(false); setError(null); } })
      .catch(e => { if (!alive) return; if (e instanceof ApiError && e.isAuth) setNeedToken(getToken() ? "rejected" : "first"); else setError(e as Error); })
      .finally(() => alive && setChecking(false));
    return () => { alive = false; };
  }, [attempt]);
  // Any later 401 (token revoked, server restarted with a new token) re-opens the prompt over the current screen.
  useEffect(() => subscribeUnauthorized(() => setNeedToken(n => n || (getToken() ? "rejected" : "first"))), []);
  useEffect(() => { if (api && version) api.health().then(setHealth, () => { /* keep last */ }); }, [api, version]);
  const bump = useCallback(() => setVersion(v => v + 1), []);
  const recheck = () => { setError(null); setAttempt(a => a + 1); };
  const tokenDialog = needToken && <TokenDialog rejected={needToken === "rejected"} busy={checking} onSubmit={() => { recheck(); if (api) bump(); }} />;

  if (error instanceof ApiError && error.isOriginBlocked) return <OriginBlocked code={error.code} onRetry={recheck} />;
  if (error) return <div className="page"><ErrorState title="The order desk couldn't start" error={error} onRetry={recheck} /></div>;
  if (!api || !health) return needToken ? <>{tokenDialog}</> : <LoadingState label="Loading catalog and orders…" />;
  return <ApiCtx.Provider value={{ api, health, version, bump }}>{children}{tokenDialog}</ApiCtx.Provider>;
}

export function useApi(): Ctx {
  const c = useContext(ApiCtx);
  if (!c) throw new Error("useApi outside ApiProvider");
  return c;
}
