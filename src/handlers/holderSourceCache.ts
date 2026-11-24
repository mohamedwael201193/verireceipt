import {markFailure} from '../core/upstreamFailureDiagnostics';
// Process-local provider pacing; cached bytes and acquisition time are atomic.
const TTL_MS = 5 * 60_000;
const MAX_STALE_AGE_MS = 10 * 60_000;
const SPACING_MS = 2_100;
const MAX_ENTRIES = 128;
const MAX_PENDING = 8;
export interface HolderObservation { body: string; fetchedAt: string; staleReason?: string }
interface Entry extends HolderObservation { expires: number }
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<HolderObservation>>();
let tail: Promise<void> = Promise.resolve();
let nextAllowed = 0;
let pending = 0;
let rateLimitedUntil = 0;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function resetHolderCacheForTests(): void {
  if (pending) throw new Error("cannot reset an active holder queue");
  cache.clear(); inFlight.clear(); tail = Promise.resolve(); nextAllowed = 0; rateLimitedUntil = 0;
}
export async function cachedHolderBody(url: string, load: (remainingMs: number) => Promise<string>, validate: (body: string) => void,
  deadlineAt = Date.now() + 7_500): Promise<HolderObservation> {
  const hit = cache.get(url);
  if (hit && Date.now() < hit.expires) {
    try { validate(hit.body); return { body: hit.body, fetchedAt: hit.fetchedAt }; } catch { cache.delete(url); }
  }
  const staleFallback = (reason: string): HolderObservation | null => {
    const prior = cache.get(url);
    if (!prior || Date.now() - Date.parse(prior.fetchedAt) >= MAX_STALE_AGE_MS) return null;
    try { validate(prior.body); } catch { cache.delete(url); return null; }
    return { body: prior.body, fetchedAt: prior.fetchedAt, staleReason: `${reason}; last real cached observation, not a current count` };
  };
  if (Date.now() < rateLimitedUntil) {
    const prior = staleFallback("GeckoTerminal HTTP 429");
    if (prior) return prior;
    const error=Object.assign(new Error("GeckoTerminal HTTP 429 cooldown; no eligible cached observation"), { status: 429 });markFailure(error,'rate_limited');throw error;
  }
  const existing = inFlight.get(url);
  if (existing) return existing;
  if (pending >= MAX_PENDING) throw new Error("holder source queue full; retry later");
  pending++;
  const enqueuedAt = Date.now();
  let expired = false;
  let started = false;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  const queueDeadline = Math.min(deadlineAt, enqueuedAt + 3_000);
  const operation = tail.then(async () => {
    if (expired) throw new Error("holder queue deadline exceeded");
    { // One provider attempt per check, including HTTP 429.
      const waitForSlot = Math.max(0, nextAllowed - Date.now());
      if ((!started && Date.now() + waitForSlot > queueDeadline) || Date.now() + waitForSlot + 100 >= deadlineAt) {
        throw new Error("holder source wait exceeds remaining request budget");
      }
      if (waitForSlot > 0) await sleep(waitForSlot);
      if (expired) throw new Error("holder queue deadline exceeded");
      started = true;
      if (queueTimer) clearTimeout(queueTimer);
      nextAllowed = Date.now() + SPACING_MS;
      let body: string;
      try { body = await load(Math.max(1, Math.min(4_000, deadlineAt - Date.now() - 100))); }
      catch (e) {
        const error = e as { status?: number; retryAfterMs?: number };
        if (error.status === 429) {
          const wait = Math.max(SPACING_MS, error.retryAfterMs ?? 5_000);
          rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + Math.max(wait, 60_000));
          nextAllowed = Math.max(nextAllowed, Date.now() + wait);
        }
        const prior = staleFallback(error.status === 429 ? "GeckoTerminal HTTP 429" : "GeckoTerminal request failed");
        if (prior) return prior;
        throw e;
      }
      if (Date.now() >= deadlineAt) throw new Error("holder observation exceeded request budget");
      try { validate(body); } catch (e) {
        const prior = staleFallback("GeckoTerminal invalid response");
        if (prior) return prior;
        throw e;
      }
      const observation = { body, fetchedAt: new Date().toISOString() };
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(url, { ...observation, expires: Date.now() + TTL_MS });
      return observation;
    }
  });
  // The timer rejects queued callers promptly even while a prior fetch is hung.
  const work = Promise.race([operation, new Promise<never>((_resolve, reject) => {
    queueTimer = setTimeout(() => { expired = true; reject(new Error("holder queue exceeded 3s wait budget")); }, Math.max(0, queueDeadline - Date.now()));
  })]);
  tail = operation.then(() => undefined, () => undefined);
  inFlight.set(url, work);
  try { return await work; }
  finally { if (queueTimer) clearTimeout(queueTimer); pending--; inFlight.delete(url); }
}
