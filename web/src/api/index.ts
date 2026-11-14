import type { OrderDeskApi } from "./client.ts";
import { HttpClient } from "./http.ts";

export type { OrderDeskApi } from "./client.ts";

const base = import.meta.env.VITE_API_BASE as string | undefined;

let instance: Promise<OrderDeskApi> | null = null;

/** VITE_API_BASE set → real HTTP client. Unset → in-browser mock (lazy-loaded so the real build doesn't ship the data). */
export function getApi(): Promise<OrderDeskApi> {
  instance ??= base
    ? Promise.resolve(new HttpClient(base))
    : import("./mock/mockClient.ts").then(m => m.createMockClient());
  return instance;
}
export const apiMode: "mock" | "http" = base ? "http" : "mock";
export const apiBase = base ?? null;
