import type { ReactNode } from "react";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return <div className="state" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><p>{label}</p></div>;
}

export function ErrorState({ title = "Something went wrong", error, onRetry }: { title?: string; error: Error; onRetry?: () => void }) {
  return (
    <div className="state error" role="alert">
      <h3>{title}</h3>
      <p>{error.message}</p>
      {onRetry && <button type="button" className="btn" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="state"><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading" style={{ display: "grid", gap: 14, padding: 16 }}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 16 }}>
          {Array.from({ length: cols }, (_, c) => <div key={c} className="skeleton" style={{ width: `${55 + ((r * 7 + c * 13) % 40)}%` }} />)}
        </div>
      ))}
    </div>
  );
}
