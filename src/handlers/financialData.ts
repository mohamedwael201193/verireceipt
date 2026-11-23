// FINANCIAL_DATA_GENERAL — GET /v1/financial-data?asset=<ticker|BTC>
//
// Zero-LLM. Market capitalisation and trading volume from named,
// keyless, measured sources, with a SHA-256 receipt over the exact
// upstream bodies. Probed live 2026-11-23.
//
// Intent contract (read 2026-11-23): request asset (string); scored
// market_cap_usd (number, [0, 1e15]); off-chain asset,
// volume_24h_usd, metrics, as_of.
//
// SCOPE (honest, maintainer ruling: unsupported asset = 422, never an
// interpolated cap):
//   - US-listed equities (1-5 letter ticker): shares outstanding from
//     SEC EDGAR companyconcept (dei EntityCommonStockSharesOutstanding,
//     latest reported, filing accession + date named) x the Yahoo
//     chart regular-market price. The cap is DERIVED (price x shares),
//     and the derivation is disclosed; Yahoo's market-cap endpoints
//     are crumb-gated, which is why no served cap is copied.
//   - BTC: Coinbase spot x the deterministic supply at the mempool.space
//     tip height (emission schedule formula published in the receipt).
//   Everything else is 422 UNSUPPORTED_ASSET.
//
// VOLUME: equity volume_24h_usd = Yahoo regularMarketVolume x price
// (the latest regular session, named as such). BTC has no keyless
// measured 24h USD volume in this slice: the field is null and the
// answer says why. No figure is ever invented.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 10000;
const UA = "VeriReceipt/2.0 financial-data observer (+https://verireceipt.vercel.app)";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

export const INTENT = "FINANCIAL_DATA_GENERAL";

async function fetchText(url: string, ua: string = UA): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": ua, Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const TICKER_RE = /^[A-Za-z]{1,5}([.-][A-Za-z]{1,2})?$/;

export interface EquityData {
  ticker: string; cik10: string; shares: number; sharesAsOf: string; sharesFiled: string; accession: string;
  price: number; marketTime: string; volumeShares: number;
}

/** BTC issued supply at a tip height under the emission schedule (50 BTC, halving every 210,000 blocks). */
export function btcSupplyAtHeight(height: number): number {
  let supply = 0;
  let remaining = height + 1; // blocks mined so far (height is zero-based)
  let reward = 50;
  while (remaining > 0 && reward > 0) {
    const take = Math.min(remaining, 210000);
    supply += take * reward;
    remaining -= take;
    reward /= 2;
  }
  return supply;
}

export function latestShares(raw: string): { val: number; end: string; filed: string; accn: string } {
  const parsed = JSON.parse(raw) as { units?: { shares?: { val?: number; end?: string; filed?: string; accn?: string }[] } };
  const rows = (parsed.units?.shares ?? []).filter((r) => typeof r.val === "number" && typeof r.end === "string");
  if (!rows.length) throw unprocessable("NO_SHARES_DATA", "EDGAR carried no shares-outstanding figure for this filer");
  const best = rows.sort((a, b) => String(b.end).localeCompare(String(a.end)))[0];
  return { val: best.val as number, end: String(best.end), filed: String(best.filed ?? "unknown"), accn: String(best.accn ?? "unknown") };
}

export async function handleFinancialData(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const asset = query.asset?.trim();
  if (!asset) throw badRequest("MISSING_PARAM", "asset is required: a US-listed equity ticker (e.g. AAPL) or BTC");
  if (asset.length > 12) throw badRequest("BAD_ASSET", "asset must be at most 12 characters");
  const fetchedAt = new Date().toISOString();
  const upper = asset.toUpperCase();

  if (upper === "BTC") {
    let spotBody: string, tipBody: string;
    try {
      [spotBody, tipBody] = await Promise.all([
        fetchText("https://api.coinbase.com/v2/prices/BTC-USD/spot"),
        fetchText("https://mempool.space/api/blocks/tip/height"),
      ]);
    } catch (err) {
      throw upstreamUnavailable("SOURCE_UNREACHABLE", `a BTC source could not be reached: ${err instanceof Error ? err.message : "unknown"}`);
    }
    const price = Number((JSON.parse(spotBody) as { data?: { amount?: string } }).data?.amount);
    const height = Number(tipBody.trim());
    if (!Number.isFinite(price) || price <= 0) throw unprocessable("NO_USABLE_PRICE", "Coinbase carried no usable BTC spot");
    if (!Number.isInteger(height) || height < 0) throw unprocessable("NO_USABLE_TIP", "mempool.space carried no usable tip height");
    const supply = btcSupplyAtHeight(height);
    const cap = Math.round(price * supply);
    if (cap > 1e15) throw unprocessable("OUT_OF_CONTRACT_RANGE", "the computed cap exceeds the contract range; refusing to serve it");
    const asOf = new Date().toISOString();
    const evidence = JSON.stringify({ asset: "BTC", as_of: asOf,
      derivation: "market_cap_usd = Coinbase BTC-USD spot x issued supply at the mempool.space tip height under the published emission schedule (50 BTC, halving every 210,000 blocks); volume_24h_usd is null: no keyless measured 24h USD volume source in this slice",
      spot: price, tip_height: height, supply_btc: supply, market_cap_usd: cap,
      raw_bodies: { coinbase: spotBody, mempool_tip: tipBody }, fetched_at: fetchedAt });
    const receipt = makeReceipt(INTENT, "api.coinbase.com + mempool.space", evidence, "Coinbase spot x emission-schedule supply at mempool tip; derivation disclosed");
    receipt.fetched_at = fetchedAt;
    try {
      await saveReceipt(receipt, evidence);
    } catch {
      throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
    }
    const answer = `BTC market cap: $${cap.toLocaleString("en-US")} as of ${asOf}, derived as the Coinbase spot ($${price}) x ${supply.toLocaleString("en-US")} BTC issued at tip height ${height} (emission schedule in the receipt). ` +
      `24h USD volume is not served: this slice has no keyless measured source for it. The cap is derived from two named sources, not copied from a market-data vendor.`;
    return envelope(INTENT, {
      asset: "BTC", market_cap_usd: cap, volume_24h_usd: null,
      metrics: [`supply_btc=${supply} at tip ${height}`, `spot_usd=${price}`, "derivation=spot x emission-schedule supply"],
      as_of: asOf,
    }, receipt, { answer, verdict: "verified", confidence: 0.9,
      source: `api.coinbase.com BTC-USD spot + mempool.space tip height; fetched ${fetchedAt}` });
  }

  if (!TICKER_RE.test(asset)) {
    throw unprocessable("UNSUPPORTED_ASSET", `"${asset}" is not a US-listed equity ticker or BTC; no figure is interpolated for unsupported assets`);
  }
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw upstreamUnavailable("SEC_USER_AGENT_MISSING", "SEC_USER_AGENT environment variable is required for SEC EDGAR requests");
  let tickersBody: string, sharesBody: string, chartBody: string;
  try {
    tickersBody = await fetchText(TICKERS_URL, ua);
  } catch (err) {
    throw upstreamUnavailable("SEC_UNAVAILABLE", `SEC company_tickers fetch failed: ${err instanceof Error ? err.message : "unknown"}`);
  }
  const entries = Object.values(JSON.parse(tickersBody) as Record<string, { cik_str?: number; ticker?: string }>);
  const row = entries.find((e) => String(e.ticker ?? "").toUpperCase() === upper);
  if (!row || typeof row.cik_str !== "number") {
    throw unprocessable("UNSUPPORTED_ASSET", `${upper} is not an SEC-listed ticker; no figure is interpolated for unsupported assets`);
  }
  const cik10 = String(row.cik_str).padStart(10, "0");
  try {
    [sharesBody, chartBody] = await Promise.all([
      fetchText(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10}/dei/EntityCommonStockSharesOutstanding.json`, ua),
      fetchText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(upper)}`),
    ]);
  } catch (err) {
    throw upstreamUnavailable("SOURCE_UNREACHABLE", `an equity source could not be reached: ${err instanceof Error ? err.message : "unknown"}`);
  }
  const shares = latestShares(sharesBody);
  const meta = (JSON.parse(chartBody) as { chart?: { result?: { meta?: Record<string, unknown> }[] | null } }).chart?.result?.[0]?.meta;
  if (!meta) throw unprocessable("TICKER_NOT_FOUND", `Yahoo carried no chart for ${upper}`);
  if (String(meta.symbol ?? "").toUpperCase() !== upper || meta.instrumentType !== "EQUITY" || meta.currency !== "USD") {
    throw unprocessable("UNSUPPORTED_ASSET", `${upper} is not a USD US equity on the price source; refusing a mismatched figure`);
  }
  const price = Number(meta.regularMarketPrice);
  const volumeShares = Number(meta.regularMarketVolume);
  if (!Number.isFinite(price) || price <= 0) throw unprocessable("NO_USABLE_PRICE", "the price source carried no usable regular-market price");
  const marketTime = typeof meta.regularMarketTime === "number" ? new Date(meta.regularMarketTime * 1000).toISOString() : "unknown";
  const cap = Math.round(price * shares.val);
  if (cap <= 0 || cap > 1e15) throw unprocessable("OUT_OF_CONTRACT_RANGE", "the computed cap is outside the contract range; refusing to serve it");
  const volumeUsd = Number.isFinite(volumeShares) && volumeShares >= 0 ? Math.round(volumeShares * price) : null;
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ asset: upper, as_of: asOf, cik: cik10,
    derivation: "market_cap_usd = Yahoo regularMarketPrice x SEC EDGAR dei:EntityCommonStockSharesOutstanding (latest reported); volume_24h_usd = Yahoo regularMarketVolume (latest regular session, named) x price; Yahoo's own market-cap endpoints are crumb-gated, so the cap is derived, not copied",
    price_usd: price, market_time: marketTime, shares_outstanding: shares.val,
    shares_as_of: shares.end, shares_filed: shares.filed, shares_accession: shares.accn,
    volume_shares: Number.isFinite(volumeShares) ? volumeShares : null, market_cap_usd: cap, volume_24h_usd: volumeUsd,
    raw_bodies: { company_tickers: tickersBody, sec_shares: sharesBody, yahoo_chart: chartBody }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, `${TICKERS_URL} + data.sec.gov + query1.finance.yahoo.com`, evidence, "SEC EDGAR shares outstanding x Yahoo regular-market price; derivation disclosed");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer = `${upper} market cap: $${cap.toLocaleString("en-US")}, derived as the Yahoo regular-market price ($${price}, exchange time ${marketTime}) x ${shares.val.toLocaleString("en-US")} shares outstanding reported to the SEC as of ${shares.end} (filed ${shares.filed}, accession ${shares.accn}). ` +
    (volumeUsd !== null ? `Latest regular-session volume: $${volumeUsd.toLocaleString("en-US")} (${volumeShares.toLocaleString("en-US")} shares x the same price). ` : "Volume is not served: the price source carried none. ") +
    `The cap is derived from two named sources, not copied from a vendor; the quote may be delayed.`;
  return envelope(INTENT, {
    asset: upper, market_cap_usd: cap, volume_24h_usd: volumeUsd,
    metrics: [`shares_outstanding=${shares.val} as of ${shares.end} (filed ${shares.filed}, ${shares.accn})`, `price_usd=${price} at ${marketTime}`, "derivation=price x shares outstanding"],
    as_of: asOf,
  }, receipt, { answer, verdict: "verified", confidence: 0.85,
    source: `SEC EDGAR (${TICKERS_URL} + companyconcept) + Yahoo chart; fetched ${fetchedAt}` });
}
