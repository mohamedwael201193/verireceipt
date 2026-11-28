// WASH_TRADING_DETECTION_GENERAL — GET /v1/wash-trading?subject=
//
// Zero-LLM, deterministic. Reads the latest trades of ONE DEX pool from the keyless
// GeckoTerminal API and reports a disclosed PROXY, not a legal or protocol-defined finding:
// wash_volume_pct = share of the sampled USD volume that is a matched round trip, meaning the
// same transaction sender has a buy and a sell in the window whose USD volumes are within 2%
// of each other (each pair counted once, both legs). The sample is the latest 300 trades only.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/WASH_TRADING_DETECTION_GENERAL,
// read 2026-11-26): input `subject` (string, max 256 bytes); scored output `verdict` enum
// [wash_trading, likely_wash_trading, inconclusive, organic] and `wash_volume_pct` number 0..100,
// 6 decimals; off-chain `subject`, `signals` (list), `summary`.
//
// Subject: a 0x pool address (exact match on /search/pools), or a 0x token address, in which case the
// highest-reserve pool containing that token is selected and disclosed. Names, pair names and wallet
// addresses are refused. An address that matches pools on more than one network is refused.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { publicSourceFailure, readPublicBody, StartBudget } from "../core/publicSource";
import { recordGeckoCall, geckoCallsLast60sBucket } from "../core/geckoCallCounter";
import { recordUpstreamError } from "../core/upstreams";

export const INTENT = "WASH_TRADING_DETECTION_GENERAL";
const GECKO = "https://api.geckoterminal.com/api/v2";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const POOL_ID = /^0x[0-9a-f]{40}([0-9a-f]{24})?$/; // 20-byte pool address, or a 32-byte pool id (v4-style), as the source lists them
export const MIN_TRADES = 100, MIN_SENDERS = 20, WASH_AT = 50, LIKELY_AT = 25, ORGANIC_BELOW = 10, MATCH_TOLERANCE = 0.02;
const CACHE_MS = 5 * 60_000, TOTAL_BUDGET_MS = 7_500;

type Fetch = (url: string, timeoutMs: number) => Promise<string>;
let fetchImpl: Fetch | null = null;
let starts = new StartBudget(20, 60_000);
const cache = new Map<string, { at: number; value: Computed }>();
const inflight = new Map<string, Promise<Computed>>();
export function setWashFetchForTests(impl: Fetch | null): void { fetchImpl = impl; cache.clear(); inflight.clear(); starts = new StartBudget(20, 60_000); }

interface Trade { kind: "buy" | "sell"; sender: string; usd: number; block: number; tx: string; ts: string; anomalous: boolean | null }
export interface WashStats { trades: number; senders: number; total_usd: number; wash_usd: number; wash_volume_pct: number; pairs: number; top3_sender_pct: number; zero_volume: number; anomalous: number | null; oldest: string; newest: string }

/** Pure metric: matched same-sender round trips within a 2% USD tolerance. Deterministic order. */
export function washStats(input: Trade[]): WashStats {
  const trades = [...input].sort((a, b) => a.block - b.block || (a.tx < b.tx ? -1 : a.tx > b.tx ? 1 : 0));
  const by = new Map<string, { buys: number[]; sells: number[]; usd: number }>();
  let total = 0;
  for (const t of trades) {
    total += t.usd;
    const e = by.get(t.sender) ?? { buys: [], sells: [], usd: 0 };
    (t.kind === "buy" ? e.buys : e.sells).push(t.usd); e.usd += t.usd; by.set(t.sender, e);
  }
  let wash = 0, pairs = 0;
  for (const e of by.values()) {
    const sells = [...e.sells];
    for (const b of e.buys) {
      if (!(b > 0)) continue;
      const i = sells.findIndex(s => Math.abs(s - b) / b <= MATCH_TOLERANCE);
      if (i >= 0) { wash += b + sells[i]; pairs++; sells.splice(i, 1); }
    }
  }
  const top3 = [...by.values()].map(e => e.usd).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const stamps = trades.map(t => t.ts).sort();
  const pct = total > 0 ? Math.min(100, (wash / total) * 100) : 0;
  return { trades: trades.length, senders: by.size, total_usd: total, wash_usd: wash, wash_volume_pct: Number(pct.toFixed(6)), pairs, top3_sender_pct: total > 0 ? Number(((top3 / total) * 100).toFixed(2)) : 0, zero_volume: trades.filter(t => t.usd === 0).length, anomalous: trades.some(t => t.anomalous !== null) ? trades.filter(t => t.anomalous === true).length : null, oldest: stamps[0] ?? "", newest: stamps[stamps.length - 1] ?? "" };
}

export function washVerdict(s: WashStats): "wash_trading" | "likely_wash_trading" | "inconclusive" | "organic" {
  if (s.trades < MIN_TRADES || s.senders < MIN_SENDERS) return "inconclusive";
  if (s.wash_volume_pct >= WASH_AT) return "wash_trading";
  if (s.wash_volume_pct >= LIKELY_AT) return "likely_wash_trading";
  if (s.wash_volume_pct < ORGANIC_BELOW) return "organic";
  return "inconclusive";
}

interface Computed { unpriced: number; network: string; pool: string; poolName: string; selection: string; stats: WashStats; rawBody: string; tradesUrl: string; fetchedAt: string }

async function get(url: string, timeoutMs: number): Promise<string> {
  if (fetchImpl) return fetchImpl(url, timeoutMs);
  if (!starts.take()) throw Object.assign(new Error("wash start budget"), { status: 429 });
  recordGeckoCall();
  return (await readPublicBody(url, 600_000, timeoutMs)).raw;
}

function parseJson(raw: string): any { try { return JSON.parse(raw); } catch { throw upstreamUnavailable("INVALID_SOURCE_BODY", "trade source returned a body that is not JSON; no answer is guessed"); } }

async function compute(subject: string, deadlineAt: number): Promise<Computed> {
  const addr = subject.toLowerCase();
  const searchUrl = `${GECKO}/search/pools?query=${addr}`;
  let searchRaw: string;
  try { searchRaw = await get(searchUrl, Math.max(1, Math.min(2500, deadlineAt - Date.now()))); }
  catch (e) { throw sourceFailure(e, "search"); }
  const pools: any[] = parseJson(searchRaw)?.data;
  if (!Array.isArray(pools)) throw upstreamUnavailable("INVALID_SOURCE_BODY", "pool search returned no data array; no answer is guessed");
  const id = (p: any) => (typeof p?.id === "string" ? p.id.toLowerCase() : "");
  const exact = pools.filter(p => typeof p?.attributes?.address === "string" && p.attributes.address.toLowerCase() === addr && id(p).endsWith("_" + addr));
  let chosen: any, selection: string;
  if (exact.length > 0) {
    if (exact.length > 1) throw unprocessable("AMBIGUOUS_SUBJECT", "the address matches pools on more than one network; no pool is guessed");
    chosen = exact[0]; selection = "subject is the exact pool address";
  } else {
    const withToken = pools.filter(p => [p?.relationships?.base_token?.data?.id, p?.relationships?.quote_token?.data?.id].some(t => typeof t === "string" && t.toLowerCase().endsWith("_" + addr)));
    if (withToken.length === 0) throw unprocessable("SUBJECT_NOT_A_POOL_OR_TOKEN", "the address is neither a DEX pool nor a token with a pool in the source; wallet addresses, names and pairs are not supported");
    const networks = new Set(withToken.map(p => id(p).split("_")[0]));
    if (networks.size > 1) throw unprocessable("AMBIGUOUS_SUBJECT", "the token address has pools on more than one network; no network is guessed");
    const reserve = (p: any) => { const n = Number(p?.attributes?.reserve_in_usd); return Number.isFinite(n) ? n : -1; };
    chosen = [...withToken].sort((a, b) => reserve(b) - reserve(a) || (id(a) < id(b) ? -1 : 1))[0];
    selection = "subject is a token address; selected its highest-reserve pool in the source";
  }
  const cid = id(chosen), network = cid.slice(0, cid.indexOf("_")), pool = String(chosen.attributes.address).toLowerCase();
  if (!/^[a-z0-9_-]{2,24}$/.test(network) || !POOL_ID.test(pool)) throw upstreamUnavailable("INVALID_SOURCE_BODY", "pool identity in the search result is malformed; no answer is guessed");
  const tradesUrl = `${GECKO}/networks/${network}/pools/${pool}/trades`;
  let tradesRaw: string;
  try { tradesRaw = await get(tradesUrl, Math.max(1, Math.min(3500, deadlineAt - Date.now()))); }
  catch (e) { throw sourceFailure(e, "trades"); }
  const rows: any[] = parseJson(tradesRaw)?.data;
  if (!Array.isArray(rows)) throw upstreamUnavailable("INVALID_SOURCE_BODY", "trades source returned no data array; no answer is guessed");
  let unpriced = 0;
  const trades: Trade[] = [];
  for (const r of rows.slice(0, 300)) {
    const a = r?.attributes;
    if (!a || (a.kind !== "buy" && a.kind !== "sell") || !ADDR.test(String(a.tx_from_address)) || !Number.isInteger(a.block_number) || typeof a.tx_hash !== "string" || typeof a.block_timestamp !== "string")
      throw upstreamUnavailable("INVALID_SOURCE_BODY", "a trade row is malformed; no answer is guessed");
    const v = a.volume_in_usd;
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) { unpriced++; continue; }
    const usd = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
    if (!Number.isFinite(usd) || usd < 0) throw upstreamUnavailable("INVALID_SOURCE_BODY", "a trade row is malformed; no answer is guessed");
    trades.push({ kind: a.kind, sender: String(a.tx_from_address).toLowerCase(), usd, block: a.block_number, tx: a.tx_hash, ts: a.block_timestamp, anomalous: typeof a.is_anomalous === "boolean" ? a.is_anomalous : null });
  }
  const stats = washStats(trades);
  if (stats.trades === 0 || stats.total_usd <= 0) throw unprocessable("NO_RECENT_TRADES", "the pool has no priced trades in the source's latest window; no verdict is guessed");
  const poolName = typeof chosen.attributes.name === "string" ? chosen.attributes.name.slice(0, 80) : "";
  return { unpriced, network, pool, poolName, selection, stats, rawBody: JSON.stringify({ search_url: searchUrl, search_source_raw_body: searchRaw, trades_url: tradesUrl, trades_source_raw_body: tradesRaw }), tradesUrl, fetchedAt: new Date().toISOString() };
}

const FAILURE_CLASSES = new Set(["http_403", "http_429", "http_4xx", "http_5xx", "transport", "timeout"]);
function sourceFailure(e: unknown, step: "search" | "trades"): Error {
  const budget = (e as any)?.status === 429; // this process's own start budget, not the source
  const label = publicSourceFailure(e);
  const cls = budget ? "budget" : FAILURE_CLASSES.has(label) ? label : "other";
  const limited = budget || cls === "http_429";
  console.info(JSON.stringify({ event: "wash_source_failure", step, class: cls }));
  if (cls === "http_429") console.info(JSON.stringify({ event: "gecko_429", gecko_calls_last_60s_bucket: geckoCallsLast60sBucket() }));
  recordUpstreamError("geckoterminal", limited ? "UPSTREAM_RATE_LIMITED" : "INDEXER_UNREACHABLE");
  return upstreamUnavailable(limited ? "UPSTREAM_RATE_LIMITED" : "TRADE_SOURCE_UNREACHABLE", "GeckoTerminal trade source unavailable; no answer is guessed");
}

export async function handleWashTrading(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const subject = query.subject?.trim();
  if (!subject) throw badRequest("MISSING_PARAM", "subject is required");
  if (Buffer.byteLength(subject) > 256) throw badRequest("SUBJECT_TOO_LONG", "subject must be at most 256 bytes");
  if (!ADDR.test(subject)) throw unprocessable("UNSUPPORTED_SUBJECT", "subject must be a 0x pool or token contract address; names, pairs and wallet addresses are not supported");
  const key = subject.toLowerCase();
  let hit = cache.get(key);
  if (hit && Date.now() - hit.at > CACHE_MS) { cache.delete(key); hit = undefined; }
  let computed = hit?.value;
  if (!computed) {
    let flight = inflight.get(key);
    if (!flight) {
      flight = compute(subject, startedAt + TOTAL_BUDGET_MS - 500).finally(() => { if (inflight.get(key) === flight) inflight.delete(key); });
      inflight.set(key, flight);
    }
    computed = await flight;
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), value: computed });
  }
  const s = computed.stats, verdict = washVerdict(s);
  const signals = [
    `matched_round_trip_volume_pct=${s.wash_volume_pct}`, `matched_round_trip_pairs=${s.pairs}`, `trades_sampled=${s.trades}`, `unpriced_trades_excluded=${computed.unpriced}`, `zero_volume_trades_counted=${s.zero_volume}`, `distinct_senders=${s.senders}`,
    `top3_sender_volume_pct=${s.top3_sender_pct}`, `source_anomalous_flags=${s.anomalous ?? "n/a"}`, `window=${s.oldest}..${s.newest}`, `network=${computed.network}`, `pool=${computed.pool}`,
  ];
  const summary = `${verdict === "inconclusive" ? "Inconclusive" : verdict}: ${s.wash_volume_pct}% of the USD volume in the latest-300-trade window at most (${s.trades} priced trades used${computed.unpriced ? `, ${computed.unpriced} unpriced excluded` : ""}) of ${computed.poolName || computed.pool} on ${computed.network} is a matched round trip (same sender bought and sold within 2% of the same USD value). Proxy over a recent sample only; arbitrage and market-maker bots that round-trip similar sizes count as matched volume; sender is the transaction sender, so multi-wallet wash trading is not visible; not a legal finding.`;
  const receipt = makeReceipt(INTENT, computed.tradesUrl, computed.rawBody, "1/1 keyless trade source (GeckoTerminal); deterministic proxy, no model");
  receipt.fetched_at = computed.fetchedAt;
  if (Date.now() - startedAt >= TOTAL_BUDGET_MS) throw upstreamUnavailable("WASH_DEADLINE", "wash-trading lookup exceeded its budget; no answer served");
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([saveReceipt(receipt, computed.rawBody), new Promise<never>((_r, rej) => { timer = setTimeout(() => rej(new Error("persist deadline")), Math.max(1, startedAt + 8_000 - Date.now())); })]); }
    finally { if (timer) clearTimeout(timer); }
  } catch { throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable"); }
  return envelope(INTENT, { subject, wash_volume_pct: s.wash_volume_pct, signals, summary }, receipt, {
    answer: `${verdict}: wash_volume_pct ${s.wash_volume_pct} (matched round-trip volume share over the latest ${s.trades} trades). ${computed.selection}.`,
    verdict, confidence: verdict === "inconclusive" ? 0.5 : 0.7,
    source: `GeckoTerminal pool trades (${computed.tradesUrl}, keyless, receipted); proxy over the latest ${s.trades} trades, thresholds: >=${WASH_AT} wash_trading, >=${LIKELY_AT} likely, <${ORGANIC_BELOW} organic with >=${MIN_TRADES} trades and >=${MIN_SENDERS} senders, else inconclusive`,
  });
}
