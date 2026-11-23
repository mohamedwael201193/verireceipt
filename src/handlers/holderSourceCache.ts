// Process-local provider pacing; cached bytes and acquisition time are atomic.
const TTL_MS = 30_000;
const SPACING_MS = 2_100;
const MAX_ENTRIES = 128;
const MAX_PENDING = 8;
export interface HolderObservation { body: string; fetchedAt: string }
interface Entry extends HolderObservation { expires: number }
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<HolderObservation>>();
let tail: Promise<void> = Promise.resolve();
let nextAllowed = 0;
let pending = 0;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function resetHolderCacheForTests(): void {
  if (pending) throw new Error("cannot reset an active holder queue");
  cache.clear(); inFlight.clear(); tail = Promise.resolve(); nextAllowed = 0;
}
export async function cachedHolderBody(url: string, load: (remainingMs: number) => Promise<string>, validate: (body: string) => void,
  deadlineAt = Date.now() + 7_500): Promise<HolderObservation> {
  const hit = cache.get(url);
  if (hit && Date.now() < hit.expires) {
    try { validate(hit.body); return { body: hit.body, fetchedAt: hit.fetchedAt }; } catch { cache.delete(url); }
  }
  if (hit) cache.delete(url);
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
    for (let attempt = 0; attempt < 2; attempt++) {
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
          nextAllowed = Math.max(nextAllowed, Date.now() + wait);
          if (attempt === 0 && Date.now() + wait + 100 < deadlineAt) continue;
        }
        throw e;
      }
      if (Date.now() >= deadlineAt) throw new Error("holder observation exceeded request budget");
      validate(body);
      const observation = { body, fetchedAt: new Date().toISOString() };
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(url, { ...observation, expires: Date.now() + TTL_MS });
      return observation;
    }
    throw new Error("holder source retry exhausted");
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
