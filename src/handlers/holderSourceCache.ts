// Shared keyless GeckoTerminal pacing. Cached values retain original bytes;
// callers must revalidate provider identity, count and source age on every read.
const TTL_MS = 30_000;
const SPACING_MS = 2_100;
const MAX_ENTRIES = 128;
const MAX_PENDING = 8;
interface Entry { body: string; expires: number; fetchedAt: string }
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<string>>();
let tail: Promise<void> = Promise.resolve();
let nextAllowed = 0;
let pending = 0;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function resetHolderCacheForTests(): void {
  if (pending) throw new Error("cannot reset an active holder queue");
  cache.clear(); inFlight.clear(); tail = Promise.resolve(); nextAllowed = 0;
}

export async function cachedHolderBody(url: string, load: () => Promise<string>, validate: (body: string) => void): Promise<string> {
  const hit = cache.get(url);
  if (hit && Date.now() < hit.expires) {
    try { validate(hit.body); return hit.body; } catch { cache.delete(url); }
  }
  if (hit) cache.delete(url);
  const existing = inFlight.get(url);
  if (existing) return existing;
  if (pending >= MAX_PENDING) throw new Error("holder source queue full; retry later");
  pending++;
  const enqueuedAt = Date.now();
  const work = tail.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const waitForSlot = Math.max(0, nextAllowed - Date.now());
      if (Date.now() + waitForSlot - enqueuedAt > 12_000) throw new Error("holder queue wait exceeds bounded 12s budget");
      if (waitForSlot > 0) await sleep(waitForSlot);
      // Pacing is process-wide across different networks and tokens.
      nextAllowed = Date.now() + SPACING_MS;
      let body: string;
      try { body = await load(); }
      catch (e) {
        const error = e as { status?: number; retryAfterMs?: number };
        if (error.status === 429) {
          // Respect longer server waits by failing closed and retaining the
          // cooldown, rather than shortening Retry-After to fit our retry.
          const wait = Math.max(SPACING_MS, error.retryAfterMs ?? 5_000);
          nextAllowed = Math.max(nextAllowed, Date.now() + wait);
          if (attempt === 0 && wait <= 5_000) continue;
        }
        throw e;
      }
      validate(body); // Never cache malformed/stale/identity-mismatched data.
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(url, { body, expires: Date.now() + TTL_MS, fetchedAt: new Date().toISOString() });
      return body;
    }
    throw new Error("holder source retry exhausted");
  });
  tail = work.then(() => undefined, () => undefined);
  inFlight.set(url, work);
  try { return await work; }
  finally { pending--; inFlight.delete(url); }
}

export function holderBodyFetchedAt(url: string): string | undefined { return cache.get(url)?.fetchedAt; }
