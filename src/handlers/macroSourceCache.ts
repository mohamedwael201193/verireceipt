// The exact URL binds country, series and explicit-year/latest selector.
const FRESH_TTL_MS = 15 * 60_000;
const MAX_STALE_MS = 24 * 60 * 60_000;
const ATTEMPT_MS = 18_000;
interface Observation { body: string; fetchedAt: string; stale?: boolean }
const cache = new Map<string, Observation>();
// Ownership includes body reads, even when I/O ignores cancellation.
const active = new Map<string, Promise<string>>();
export function resetMacroSourceCacheForTests(): void { cache.clear(); }

export async function readMacroText(url: string, deadline: number): Promise<string> {
  if (Date.now() >= deadline) throw Error('macro source deadline');
  let io = active.get(url);
  const controller = new AbortController();
  if (!io) {
    if (active.size >= 8) throw Error('macro source capacity');
    io = (async () => {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        // Preserve HTTP classification even if cancellation itself rejects.
        const failure = Object.assign(Error('macro source HTTP failure'), { retryable: res.status >= 500 });
        // Keep ownership until cancellation settles, even for error bodies.
        try { await res.body?.cancel(); } catch { /* HTTP status owns retry policy. */ }
        throw failure;
      }
      return await res.text();
    })();
    active.set(url, io);
    const owned = io;
    const release = () => { if (active.get(url) === owned) active.delete(url); };
    void io.then(release, release);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      io,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Error('macro source deadline'));
        }, Math.max(0, Math.min(ATTEMPT_MS, deadline - Date.now())));
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function macroObservation(
  url: string, deadline: number, validate: (body: string) => boolean,
): Promise<Observation> {
  const prior = cache.get(url);
  const age = prior ? Date.now() - Date.parse(prior.fetchedAt) : Infinity;
  if (prior && age >= 0 && age < FRESH_TTL_MS) return { ...prior };
  let failure: unknown;
  for (let n = 0; n < 2; n++) {
    if (Date.now() >= deadline) break;
    let body: string;
    try {
      body = await readMacroText(url, deadline);
    } catch (error) {
      failure = error;
      if ((error as { retryable?: boolean })?.retryable === false) break;
      // An abort-ignoring request still owns its URL. Never start another.
      if (n === 0 && !active.has(url) && deadline - Date.now() > 250) {
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      break;
    }
    // Invalid data may use a prior good observation, never become one.
    let good: boolean;
    try { good = validate(body); } catch (error) { failure = error; break; }
    const row = { body, fetchedAt: new Date().toISOString() };
    if (good) {
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      cache.set(url, row);
    }
    return row;
  }
  if (prior && age >= 0 && Date.now() - Date.parse(prior.fetchedAt) < MAX_STALE_MS) {
    return { ...prior, stale: true };
  }
  throw failure ?? Error('macro source budget exceeded; no prior observation');
}
