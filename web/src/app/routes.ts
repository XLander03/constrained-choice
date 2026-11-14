import { useParams } from "react-router";

/** Every route in the app, with typed path builders. Use these instead of string literals. */
export const paths = {
  inbox: () => "/inbox",
  review: (orderId: string) => `/orders/${encodeURIComponent(orderId)}/review`,
  approved: (highlight?: string) => (highlight ? `/approved?order=${encodeURIComponent(highlight)}` : "/approved"),
  catalog: () => "/catalog",
  stats: () => "/stats",
} as const;

export const patterns = {
  inbox: "inbox",
  review: "orders/:orderId/review",
  approved: "approved",
  catalog: "catalog",
  stats: "stats",
} as const;

type ParamsOf<P extends string> = P extends `${string}:${infer Name}/${infer Rest}` ? { [K in Name]: string } & ParamsOf<Rest>
  : P extends `${string}:${infer Name}` ? { [K in Name]: string } : Record<never, never>;

/** Typed params for a route pattern, e.g. useRouteParams("review").orderId. */
export function useRouteParams<K extends keyof typeof patterns>(_route: K): ParamsOf<(typeof patterns)[K]> {
  return useParams() as ParamsOf<(typeof patterns)[K]>;
}
