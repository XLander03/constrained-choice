// One place that turns API errors into what the clerk sees. Rule from API.md (milestone 5): only a 502 (or a dropped connection)
// is offered as "Retry"; 4xx answers need the input changed, so retrying them as-is would just fail again.
import { ApiError } from "../api/types.ts";

export interface ShownError { text: string; retryable: boolean }

export function describeError(e: unknown, what = "That request"): ShownError {
  if (!(e instanceof ApiError)) return { text: (e as Error)?.message ?? String(e), retryable: false };
  const t = (text: string) => ({ text, retryable: e.retryable });
  switch (e.code) {
    case "unauthorized": return t("The API needs a token. Enter it in the prompt to continue.");
    case "origin_not_allowed": return t("This UI's address isn't allowed by the server (ALLOWED_ORIGINS). Open it at http://localhost:5173 or :5174, or add this origin on the server.");
    case "host_not_allowed": return t("The server only answers requests addressed to localhost without a token. Use http://localhost or set API_TOKEN on the server.");
    case "too_many_lines": return t(`Over ${num(e.details?.max_lines) ?? 400} lines, split the order${num(e.details?.lines) ? ` (this one has ${num(e.details?.lines)})` : ""}.`);
    case "text_required": return t("Paste an order message first.");
    case "text_too_long": return t("That message is over 20,000 characters. Split it into separate orders.");
    case "body_too_large": return t("The file is over 5 MB. Export a shorter date range.");
    case "bad_order_id": return t(e.message);
    case "no_product_lines": return t("This order has no product lines, so there is nothing to approve.");
    case "token_budget_exceeded": return t("The paid model's token budget for this server run is used up (OPENAI_TOKEN_CAP). Restart the API or switch to the mock adapter.");
    case "decision_provider_error": return t(`The decision model failed or timed out. ${e.message}`);
    case "order_exists": return t(`${e.message} Open it from the list instead.`);
    case "network_error": return t(e.message);
    default: return t(e.message || `${what} failed (${e.status}).`);
  }
}
const num = (v: unknown) => (typeof v === "number" ? v : null);
