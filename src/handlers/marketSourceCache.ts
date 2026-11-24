// Process-local CoinPaprika observation cache. Raw bytes and acquisition time stay atomic.
const FRESH_MS = 30_000;
const STALE_MS = 5 * 60_000;
const TIMEOUT_MS = 6_000;
const MAX_BYTES = 64 * 1024;
export interface MarketObservation { body: string; fetchedAt: string; staleReason?: string; attemptedAt?: string }
const cache = new Map<string, MarketObservation>();
const inFlight = new Map<string, Promise<MarketObservation>>();
export function resetMarketCacheForTests(): void { cache.clear(); inFlight.clear(); }
export async function cachedMarketBody(id: string, validate: (body: string) => number): Promise<MarketObservation> {
  if (id !== "eth-ethereum" && id !== "sol-solana") throw new Error("unsupported market identity");
  const prior = cache.get(id);
  const age = prior ? Date.now() - Date.parse(prior.fetchedAt) : Infinity;
  if (prior && age >= 0 && age < FRESH_MS) { validate(prior.body); return prior; }
  const pending = inFlight.get(id);
  if (pending) return pending;
  const work = (async () => {
    const attemptedAt = new Date().toISOString();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (reason: string): MarketObservation => {
      if (prior) {
        const fetched = Date.parse(prior.fetchedAt);
        const updated = validate(prior.body);
        const now = Date.now();
        if (now >= fetched && now - fetched <= STALE_MS && now >= updated && now - updated <= STALE_MS) {
          return { ...prior, staleReason: reason, attemptedAt };
        }
      }
      throw new Error("market source unavailable; no eligible cached observation");
    };
    try {
      const request = (async (): Promise<MarketObservation> => {
        let response: Response;
        try {
          response = await fetch(`https://api.coinpaprika.com/v1/tickers/${id}`, {
            signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "VeriReceipt/2.0 financial-data observer (+https://verireceipt.vercel.app)" },
          });
        } catch {
          if (controller.signal.aborted) return fail("CoinPaprika request timeout");
          throw new Error("market transport failure");
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          if (response.status === 429 || response.status >= 500 && response.status <= 599) return fail(`CoinPaprika HTTP ${response.status}`);
          throw new Error("market source returned a non-retryable HTTP status");
        }
        // Keep the deadline active until the complete bounded body is consumed.
        const reader = response.body?.getReader();
        if (!reader) throw new Error("market response body missing");
        const chunks: Uint8Array[] = []; let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_BYTES) throw new Error("market response too large");
            chunks.push(value);
          }
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          throw error;
        } finally { reader.releaseLock(); }
        if (controller.signal.aborted) throw new Error("market request exceeded deadline");
        const body = Buffer.concat(chunks).toString("utf8");
        validate(body); // Invalid successful responses never fall back or poison the cache.
        const observation = { body, fetchedAt: new Date().toISOString() };
        cache.set(id, observation);
        return observation;
      })();
      return await Promise.race([request, new Promise<MarketObservation>((resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); try { resolve(fail("CoinPaprika request timeout")); } catch (e) { reject(e); } }, TIMEOUT_MS);
      })]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  })();
  inFlight.set(id, work);
  try { return await work; } finally { inFlight.delete(id); }
}
