import type { ReviewReason } from "../api/types.ts";
import { REASON_HELP, REASON_LABEL, REASON_SHORT, confidenceBand } from "../lib/domain.ts";

export const Kbd = ({ children }: { children: string }) => <kbd className="kbd">{children}</kbd>;

/** Five-step meter plus the number, and an aria label. Colour is never the only signal. */
/** `accepted` (route === auto) wins over the number: the wire rounds confidence, so 0.8333 can sit a hair under the threshold. */
export function Confidence({ value, threshold, accepted }: { value: number; threshold: number; accepted?: boolean }) {
  const band = accepted ? "high" : confidenceBand(value, threshold);
  const on = Math.max(1, Math.round(value * 5));
  const word = band === "high" ? "high" : band === "medium" ? "medium" : "low";
  return (
    <span className="conf" data-band={band} role="img" aria-label={`Confidence ${Math.round(value * 100)}%, ${word}`} title={`Confidence ${(value * 100).toFixed(1)}% (auto-accept at ${Math.round(threshold * 100)}%)`}>
      <span className="conf-bars" aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <i key={i} className={i < on ? "on" : ""} />)}</span>
      <span className="conf-val" aria-hidden="true">{Math.round(value * 100)}%</span>
    </span>
  );
}

export function ReasonTag({ reason, short = false }: { reason: ReviewReason; short?: boolean }) {
  return <span className={`tag${reason === "none_of_these" || reason === "refused" ? " danger" : ""}`} title={REASON_HELP[reason]}>{short ? REASON_SHORT[reason] : REASON_LABEL[reason]}</span>;
}

export type DeskStatus = "incoming" | "needs_review" | "ready" | "approved" | "empty";
const STATUS: Record<DeskStatus, { cls: string; text: string }> = {
  incoming: { cls: "new", text: "New" },
  needs_review: { cls: "warn", text: "Needs review" },
  ready: { cls: "ok", text: "Ready to approve" },
  approved: { cls: "ok", text: "Approved" },
  empty: { cls: "plain", text: "No product lines" },
};
export const StatusBadge = ({ status, label }: { status: DeskStatus; label?: string }) =>
  <span className={`badge ${STATUS[status].cls}${status === "approved" ? " solid" : ""}`}>{label ?? STATUS[status].text}</span>;

export const ChannelLabel = ({ channel }: { channel: string }) =>
  <span className="chan">{channel === "whatsapp" ? "WhatsApp" : channel === "email" ? "Email" : "Pasted"}</span>;
