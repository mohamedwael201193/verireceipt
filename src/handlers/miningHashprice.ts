// MINING_HASHPRICE_VERIFY_GENERAL — GET /v1/mining-hashprice[?block_height=<n>]
//
// Zero-LLM. Current Bitcoin hashprice computed from measured values,
// with a SHA-256 receipt over the exact upstream response bodies.
//
// Intent contract (read 2026-11-22): optional block_height; scored
// hashprice_sats_per_ph_day; off-chain block_height, hashrate_eh_s,
// hashprice_usd_per_ph_day.
//
// SOURCES (all keyless, probed live 2026-11-23): mempool.space
// (1-week hashrate series, 1-week per-block fee series, tip height)
// and the Coinbase public BTC-USD spot for the USD figure. The
// computation is fully disclosed in the receipt:
//   subsidy       = 50 BTC / 2^era, era = floor(tip / 210000)
//   revenue/block = subsidy + mean measured block fees over 1 week
//   sats/PH/day   = revenue * 144 blocks/day * 1e15 / mean 1w hashrate
// It is a spot hashprice from measured inputs, never a forecast.
//
// Historical blocks use their own reward, difficulty and historical USD price.
// This single-block basis is distinct from the unchanged current weekly basis.
import { ApiError, badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 6000;
const UA = "VeriReceipt/2.0 mining-hashprice observer (+https://verireceipt.vercel.app)";
const HASHRATE_URL = "https://mempool.space/api/v1/mining/hashrate/1w";
const FEES_URL = "https://mempool.space/api/v1/mining/blocks/fees/1w";
const TIP_URL = "https://mempool.space/api/blocks/tip/height";
const SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const BLOCKS_PER_DAY = 144;

export interface HashpriceInputs {
  tip: number; meanHashrateHs: number; meanFeesSats: number; subsidySats: number; spotUsd: number;
}

export function parseHashrate(raw: string): number {
  const d = JSON.parse(raw) as { hashrates?: unknown };
  const rows = (Array.isArray(d.hashrates) ? d.hashrates : []) as Record<string, unknown>[];
  const vals = rows.map((r) => Number(r.avgHashrate)).filter((v) => Number.isFinite(v) && v > 0);
  if (!vals.length) throw unprocessable("NO_USABLE_HASHRATE", "the hashrate series carried no usable entries");
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function parseFees(raw: string): number {
  const rows = JSON.parse(raw) as Record<string, unknown>[];
  if (!Array.isArray(rows)) throw unprocessable("NO_USABLE_FEES", "the block-fee series was not a list");
  const vals = rows.map((r) => Number(r.avgFees)).filter((v) => Number.isFinite(v) && v >= 0);
  if (!vals.length) throw unprocessable("NO_USABLE_FEES", "the block-fee series carried no usable entries");
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function parseSpot(raw: string): number {
  const d = JSON.parse(raw) as { data?: { amount?: unknown } };
  const v = Number(d.data?.amount);
  if (!Number.isFinite(v) || v <= 0) throw unprocessable("NO_USABLE_SPOT", "the spot answer carried no usable price");
  return v;
}

export function subsidyAt(tip: number): number {
  const era = Math.floor(tip / 210000);
  return era >= 64 ? 0 : 50 * 1e8 / Math.pow(2, era);
}

export function computeHashprice(i: HashpriceInputs): { sats: number; usd: number } {
  const revenue = i.subsidySats + i.meanFeesSats;
  const sats = (revenue * BLOCKS_PER_DAY * 1e15) / i.meanHashrateHs;
  return { sats, usd: (sats / 1e8) * i.spotUsd };
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) throw new ApiError(503, "UPSTREAM_UNREACHABLE", `mempool/source input unavailable (HTTP ${res.status})`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export const INTENT = "MINING_HASHPRICE_VERIFY_GENERAL";

const historicalCache = new Map<number, { at: number; value: Record<string, unknown> }>();
export function resetHashpriceCacheForTests(): void { historicalCache.clear(); }
async function historicalHashprice(height: number, fetchedAt: string): Promise<Record<string, unknown>> {
  const cached = historicalCache.get(height);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  const hashUrl = `https://mempool.space/api/block-height/${height}`;
  const hashRaw = await fetchText(hashUrl);
  const hash = hashRaw.trim();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw upstreamUnavailable("BAD_BLOCK", "block-height source returned no usable hash");
  const blockUrl = `https://mempool.space/api/v1/block/${hash}`;
  const blockRaw = await fetchText(blockUrl);
  const block = JSON.parse(blockRaw);
  const reward = block.extras?.reward, difficulty = block.difficulty, timestamp = block.timestamp;
  if (block.id !== hash || block.height !== height || !Number.isSafeInteger(reward) || reward <= 0 || !Number.isFinite(difficulty) || difficulty <= 0 || !Number.isSafeInteger(timestamp) || timestamp <= 0) throw upstreamUnavailable("BAD_BLOCK", "historical block identity or measured inputs are invalid");
  const priceUrl = `https://mempool.space/api/v1/historical-price?timestamp=${timestamp}&currency=USD`;
  const priceRaw = await fetchText(priceUrl);
  const price = JSON.parse(priceRaw)?.prices?.[0];
  if (!Number.isFinite(price?.USD) || price.USD <= 0 || !Number.isSafeInteger(price.time) || price.time > timestamp || timestamp - price.time > 86400) throw upstreamUnavailable("BAD_PRICE", "no usable historical USD price near the block timestamp");
  const hashrate = difficulty * 2 ** 32 / 600;
  const sats = reward * 144 * 1e15 / hashrate;
  if (!Number.isFinite(sats) || sats < 1 || sats > 1e9) throw unprocessable("OUT_OF_CONTRACT_RANGE", "single-block hashprice is outside1..1e9 sats/PH/day; not served");
  const evidence = JSON.stringify({ height, hash, reward_sats: reward, difficulty, timestamp, price_timestamp: price.time, historical_usd: price.USD, formula: "hashrate_Hs=difficulty*2^32/600; sats_per_PH_day=reward_sats*144*1e15/hashrate_Hs", basis: "single-block reward over difficulty-implied hashrate, not a weekly average", raw_bodies: { hash: hashRaw, block: blockRaw, price: priceRaw }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, blockUrl, evidence, "mempool.space historical block and historical USD price; disclosed computation"); receipt.fetched_at = fetchedAt;
  try { await saveReceipt(receipt, evidence); } catch { throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable"); }
  const value = envelope(INTENT, { hashprice_sats_per_ph_day: Math.round(sats * 100) / 100, block_height: height, hashrate_eh_s: hashrate / 1e18, hashprice_usd_per_ph_day: Math.round(sats / 1e8 * price.USD * 100) / 100 }, receipt,
    { answer: `Bitcoin block ${height}: ${Math.round(sats * 100) / 100} sats/PH/day. Basis: single-block reward ${reward} sats over difficulty-implied hashrate (${difficulty} *2^32/600), not a weekly average. USD uses the historical price $${price.USD} at ${new Date(price.time * 1000).toISOString()}, near the block timestamp ${new Date(timestamp * 1000).toISOString()}.`, verdict: "verified", confidence: 0.85, source: `${hashUrl} + ${blockUrl} + ${priceUrl}; measured historical inputs, not a forecast` });
  if (historicalCache.size >= 64) historicalCache.delete(historicalCache.keys().next().value!);
  historicalCache.set(height, { at: Date.now(), value }); return value;
}

export async function handleMiningHashprice(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  let requestedHeight: number | null = null;
  if (query.block_height !== undefined && query.block_height.trim() !== "") {
    const h = Number(query.block_height);
    if (!Number.isInteger(h) || h < 1 || h > 1000000000) throw badRequest("BAD_HEIGHT", "block_height must be an integer in [1, 1000000000]");
    requestedHeight = h;
  }
  const fetchedAt = new Date().toISOString();
  if (requestedHeight !== null) {
    const tip = Number((await fetchText(TIP_URL)).trim());
    if (!Number.isSafeInteger(tip) || tip < 1) throw upstreamUnavailable("NO_USABLE_TIP", "tip height is unavailable");
    if (requestedHeight > tip) throw unprocessable("ABOVE_TIP", `height ${requestedHeight} is above observed tip ${tip}; no future block hashprice is asserted`);
    if (requestedHeight < tip) return historicalHashprice(requestedHeight, fetchedAt);
  }
  const urls = [HASHRATE_URL, FEES_URL, TIP_URL, SPOT_URL];
  const settled = await Promise.allSettled(urls.map(fetchText));
  if (settled.some((s) => s.status === "rejected")) {
    throw upstreamUnavailable("UPSTREAM_UNREACHABLE", "one or more measured inputs (mempool.space, Coinbase spot) could not be fetched; hashprice is never computed from partial inputs");
  }
  const [hrRaw, feesRaw, tipRaw, spotRaw] = settled.map((s) => (s as PromiseFulfilledResult<string>).value);
  const tip = Number(tipRaw.trim());
  if (!Number.isInteger(tip) || tip <= 0) throw unprocessable("NO_USABLE_TIP", "the tip-height answer was not an integer");
  if (requestedHeight !== null && requestedHeight !== tip) {
    throw unprocessable("HISTORICAL_NOT_SERVED",
      `only the current tip (${tip}) is served: the measured inputs are current-window series, so historical hashprice at height ${requestedHeight} cannot be verified here`);
  }
  const inputs: HashpriceInputs = {
    tip, meanHashrateHs: parseHashrate(hrRaw), meanFeesSats: parseFees(feesRaw),
    subsidySats: subsidyAt(tip), spotUsd: parseSpot(spotRaw),
  };
  const { sats, usd } = computeHashprice(inputs);
  const satsRounded = Math.round(sats * 100) / 100;
  if (satsRounded < 1 || satsRounded > 1000000000) {
    throw unprocessable("OUT_OF_CONTRACT_RANGE", `computed hashprice ${satsRounded} sats/PH/day is outside the contract range; not served`);
  }
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ requested_block_height: requestedHeight, tip, as_of: asOf, inputs,
    formula: "sats/PH/day = (subsidy_sats + mean_1w_block_fees_sats) * 144 * 1e15 / mean_1w_hashrate_H_per_s; subsidy = 50e8/2^floor(tip/210000)",
    source_policy: "mempool.space measured 1-week series + tip; Coinbase spot for USD; spot hashprice from measured inputs, never a forecast",
    raw_bodies: { hashrate: hrRaw, fees: feesRaw, tip: tipRaw, spot: spotRaw }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, HASHRATE_URL, evidence, "mempool.space measured series + Coinbase spot; disclosed computation from current measured inputs");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const eh = inputs.meanHashrateHs / 1e18;
  const usdRounded = Math.round(usd * 100) / 100;
  const answer =
    `Current Bitcoin hashprice at tip ${tip}: ${satsRounded} sats/PH/day (~$${usdRounded}/PH/day). ` +
    `Computed from measured inputs: mean 1-week network hashrate ${eh.toFixed(1)} EH/s, subsidy ${inputs.subsidySats / 1e8} BTC (era ${Math.floor(tip / 210000)}) ` +
    `plus mean measured block fees ${Math.round(inputs.meanFeesSats).toLocaleString("en-US")} sats over the same week, BTC spot $${inputs.spotUsd}. ` +
    `This is a spot hashprice from current measured values (mempool.space series, Coinbase spot), never a forecast; only the current tip is served.`;
  return envelope(INTENT, {
    hashprice_sats_per_ph_day: satsRounded,
    block_height: tip,
    hashrate_eh_s: Math.round(eh * 100) / 100,
    hashprice_usd_per_ph_day: usdRounded,
  }, receipt, { answer, verdict: "verified", confidence: 0.85,
    source: `${HASHRATE_URL} + ${FEES_URL} + ${TIP_URL} + ${SPOT_URL}; disclosed computation from measured 1-week series; fetched ${fetchedAt}` });
}
