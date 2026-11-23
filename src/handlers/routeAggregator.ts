// Keyless Velora/ParaSwap quote observation, not a block-hash-pinned RPC call.
// KyberSwap is excluded: live routes probe returned 403 on 2026-11-23.
// No alternate access path or synthetic success fixture is used.
export const VELORA_URL = "https://api.paraswap.io/prices?srcToken=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2&destToken=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&amount=1000000000000000000&srcDecimals=18&destDecimals=6&side=SELL&network=1&version=6.2";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export interface AggregatorObservation {
  source: string; url: string; body: string; fetched_at: string;
  amount_out?: string; block_number?: number; excluded?: string;
}
export function parseVelora(body: string, pin: number): { amount: bigint; block: number } {
  const p = JSON.parse(body)?.priceRoute;
  if (p?.network !== 1 || p?.srcToken?.toLowerCase() !== WETH || p?.destToken?.toLowerCase() !== USDC ||
      p?.srcAmount !== "1000000000000000000" || p?.srcDecimals !== 18 || p?.destDecimals !== 6 ||
      typeof p?.destAmount !== "string" || !/^\d+$/.test(p.destAmount)) throw new Error("quote identity, units or amount mismatch");
  if (!Number.isSafeInteger(p.blockNumber) || p.blockNumber < pin || p.blockNumber > pin + 2) {
    throw new Error("aggregator block outside pinned block..pinned block+2 freshness window");
  }
  const amount = BigInt(p.destAmount);
  if (amount <= 0n || amount >= 10000000000n) throw new Error("amount outside ETH/USDC plausibility bounds");
  return { amount, block: p.blockNumber };
}
export async function observeVelora(pin: number, parent?: AbortSignal): Promise<AggregatorObservation> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) controller.abort();
  const timer = setTimeout(abort, 1200);
  const observation: AggregatorObservation = { source: "Velora/ParaSwap", url: VELORA_URL, body: "", fetched_at: new Date().toISOString() };
  try {
    const response = await fetch(VELORA_URL, { signal: controller.signal, headers: { Accept: "application/json" } });
    observation.body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const quote = parseVelora(observation.body, pin);
    observation.amount_out = quote.amount.toString();
    observation.block_number = quote.block;
  } catch (e) {
    observation.excluded = e instanceof Error ? e.message : "aggregator unavailable";
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
  return observation;
}
/** Median convention: lower middle of surviving source observations, never an interpolated quote. */
export function aggregatorSummary(baseline: bigint, observation: AggregatorObservation): { median: bigint; best: bigint; bestSource: string } {
  if (observation.amount_out && !observation.excluded) {
    const amount = BigInt(observation.amount_out);
    if (amount * 100n < baseline * 95n || amount * 100n > baseline * 105n) {
      observation.excluded = "outside 5% agreement band of independently filtered block-pinned baseline";
    } else {
      return { median: amount < baseline ? amount : baseline, best: amount > baseline ? amount : baseline,
        bestSource: amount > baseline ? "Velora/ParaSwap" : "block-pinned venue baseline" };
    }
  }
  return { median: baseline, best: baseline, bestSource: "block-pinned venue baseline" };
}
