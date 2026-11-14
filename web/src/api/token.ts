// The optional API token (API.md "Access control"). It is typed in by the user at runtime and lives only in memory, plus
// sessionStorage when they tick "remember for this tab". It is never read from import.meta.env, so it can't end up in the bundle.
const KEY = "od.apiToken";
let token: string | null = (() => { try { return sessionStorage.getItem(KEY); } catch { return null; } })();

export const getToken = () => token;
export function setToken(t: string | null, remember = false) {
  token = t && t.trim() ? t.trim() : null;
  try { if (token && remember) sessionStorage.setItem(KEY, token); else sessionStorage.removeItem(KEY); } catch { /* storage blocked: memory only */ }
}
/** Fired by the HTTP client on any 401 so the app can ask for the token again. */
const unauthorizedListeners = new Set<() => void>();
export const subscribeUnauthorized = (f: () => void) => { unauthorizedListeners.add(f); return () => { unauthorizedListeners.delete(f); }; };
export const notifyUnauthorized = () => unauthorizedListeners.forEach(f => f());
