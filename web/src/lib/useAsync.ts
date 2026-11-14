import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

export type AsyncState<T> =
  | { status: "loading"; data?: T }
  | { status: "error"; error: Error; data?: T }
  | { status: "ok"; data: T };

/** Run an async loader on mount and when deps change. Keeps the last data while reloading. */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [n, setN] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setState(s => ({ status: "loading", data: s.data }));
    load().then(
      data => { if (my === seq.current) setState({ status: "ok", data }); },
      error => { if (my === seq.current) setState(s => ({ status: "error", error: error instanceof Error ? error : new Error(String(error)), data: s.data })); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const reload = useCallback(() => setN(x => x + 1), []);
  return { ...state, reload };
}
