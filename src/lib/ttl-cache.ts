/**
 * A tiny per-instance cache for numbers that are shown on every page (navigation badges, dashboard counters).
 * Entries live a few seconds; every web action clears the cache, so what you just changed is never hidden from you.
 */
const store = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = fn().then((v) => { store.set(key, { at: Date.now(), v }); return v; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export function clearCache() {
  store.clear();
}
