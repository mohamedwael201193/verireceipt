// FINANCIAL_DATA_GENERAL — GET /v1/financial-data?asset=<company|ticker|BTC|ETH|SOL>
//
// Zero-LLM. Market capitalisation and trading volume from named,
// keyless, measured sources, with a SHA-256 receipt over the exact
// upstream bodies. Probed live 2026-11-23.
//
// Intent contract (read 2026-11-23): request asset (string); scored
// market_cap_usd (number, [0, 1e15]); off-chain asset,
// volume_24h_usd, metrics, as_of.
//
// US equities use SEC-reported shares x Yahoo chart price. Company names
// resolve through SEC titles, with Yahoo search as a discovery fallback;
// all resolved tickers must still exist in the SEC index. Ambiguity refuses.
// BTC retains its emission-schedule methodology. ETH and SOL use CoinPaprika
// aggregated market cap and rolling 24h volume, disclosed as a different
// methodology. Equity session volume is NOT rolling 24h volume.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { COINPAPRIKA_APPROVAL } from "./financeWired";
import { cachedEquityQuote, cachedYahooSearch, assertYahooAllowed, noteYahooRateLimit, type EquityObservation } from "./equityQuoteCache";
import { cachedMarketBody } from "./marketSourceCache";

const SOURCE_TIMEOUT_MS = 10000;
const UA = "VeriReceipt/2.0 financial-data observer (+https://verireceipt.vercel.app)";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

export const INTENT = "FINANCIAL_DATA_GENERAL";

async function fetchText(url: string, ua: string = UA): Promise<string> {
  const yahoo = new URL(url).hostname === "query1.finance.yahoo.com";
  if (yahoo) assertYahooAllowed();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": ua, Accept: "application/json" } });
    if (yahoo && res.status === 429) noteYahooRateLimit(res.headers.get("retry-after"));
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), {status:res.status});
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

interface SecEntry { cik_str?: number; ticker?: string; title?: string }
const CRYPTO: Record<string, { id: string; symbol: string; name: string }> = {
  ETH: { id: "eth-ethereum", symbol: "ETH", name: "Ethereum" },
  ETHEREUM: { id: "eth-ethereum", symbol: "ETH", name: "Ethereum" },
  SOL: { id: "sol-solana", symbol: "SOL", name: "Solana" },
  SOLANA: { id: "sol-solana", symbol: "SOL", name: "Solana" },
};
const companyName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  .replace(/(?:\s+(?:inc|incorporated|corp|corporation|co|company|ltd|limited))+$/, "").trim();

export function resolveSec(entries: SecEntry[], asset: string): SecEntry | undefined {
  const ticker = entries.filter((e) => e.ticker?.toUpperCase() === asset.toUpperCase());
  const matches = ticker.length ? ticker : entries.filter((e) => companyName(e.title ?? "") === companyName(asset));
  if (matches.length > 1) throw unprocessable("AMBIGUOUS_ASSET", "multiple SEC entries match; supply the exact ticker");
  return matches[0];
}

async function aggregatedCrypto(asset: string, crypto: { id: string; symbol: string; name: string }): Promise<Record<string, unknown>> {
  const url = `https://api.coinpaprika.com/v1/tickers/${crypto.id}`;
  const validate = (body: string): number => {
    let data: Record<string, unknown>;
    try { data = JSON.parse(body); } catch { throw upstreamUnavailable("BAD_MARKET_DATA", "CoinPaprika returned malformed JSON"); }
    const cap = (data?.quotes as any)?.USD?.market_cap;
    const volume = (data?.quotes as any)?.USD?.volume_24h;
    const updated = typeof data?.last_updated === "string" ? Date.parse(data.last_updated) : NaN;
    if (data?.id !== crypto.id || data?.symbol !== crypto.symbol || typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 || cap > 1e15 ||
        typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 1e15 ||
        typeof updated !== "number" || !Number.isFinite(updated) || updated <= 0 ||
        updated > Date.now() + 60000 || Date.now() - updated > 86400000) {
      throw upstreamUnavailable("BAD_MARKET_DATA", "CoinPaprika cap, volume or update time is missing, stale or outside the contract range");
    }
    return updated;
  };
  let observation: Awaited<ReturnType<typeof cachedMarketBody>>;
  try { observation = await cachedMarketBody(crypto.id, validate); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw upstreamUnavailable("SOURCE_UNREACHABLE", "CoinPaprika market data unavailable");
  }
  const { body, fetchedAt, staleReason, attemptedAt } = observation;
  const data = JSON.parse(body);
  const cap = data.quotes.USD.market_cap as number, volume = data.quotes.USD.volume_24h as number, updated = Date.parse(data.last_updated);
  const asOf = new Date(updated).toISOString();
  const evidence = JSON.stringify({ requested_asset: asset, asset: crypto.symbol, resolved_name: crypto.name,
    methodology: "CoinPaprika aggregated market cap and rolling 24h USD volume; not BTC emission-schedule supply x Coinbase spot",
    market_cap_usd: cap, volume_24h_usd: volume, as_of: asOf, source_url: url,
    terms: COINPAPRIKA_APPROVAL, attribution: "Data by CoinPaprika", raw_bodies: { coinpaprika: body }, fetched_at: fetchedAt, stale: Boolean(staleReason),
    ...(staleReason ? { stale_reason: staleReason, attempted_at: attemptedAt } : {}) });
  const receipt = makeReceipt(INTENT, url, evidence, `CoinPaprika aggregated market data; methodology disclosed${staleReason ? "; STALE DISCLOSED" : ""}`);
  receipt.fetched_at = fetchedAt;
  try { await saveReceipt(receipt, evidence); } catch { throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable"); }
  return envelope(INTENT, { asset: crypto.symbol, asset_type: "crypto", symbol: crypto.symbol, name: crypto.name, resolved_name: crypto.name, market_cap_usd: cap,
    volume_24h_usd: volume, metrics: ["methodology=CoinPaprika aggregated market cap and rolling 24h volume", ...(staleReason ? [`stale=${staleReason}; original acquisition ${fetchedAt}`] : [])], as_of: asOf }, receipt,
    { answer: `${staleReason ? "STALE CACHED OBSERVATION, not current market data. " : ""}${crypto.name} (${crypto.symbol}) market cap: $${cap.toLocaleString("en-US")}; rolling 24h USD volume: $${volume.toLocaleString("en-US")}, source update ${asOf}. Source: CoinPaprika aggregated market data, not the derived BTC emission-schedule methodology.${staleReason ? ` ${staleReason}; last real observation acquired ${fetchedAt}; no values estimated or updated.` : ""}`,
      verdict: staleReason ? "stale" : "verified", confidence: staleReason ? 0.5 : 0.85, source: `${url}; fetched ${fetchedAt}${staleReason ? `; STALE: ${staleReason}; attempted ${attemptedAt}` : ""}` });
}

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
  if (!asset) throw badRequest("MISSING_PARAM", "asset is required: a US-listed company/ticker, BTC, ETH or SOL");
  if (new TextEncoder().encode(asset).length > 256) throw badRequest("BAD_ASSET", "asset must be at most 256 UTF-8 bytes");
  const fetchedAt = new Date().toISOString();
  const upper = asset.toUpperCase();

  if (CRYPTO[upper]) return aggregatedCrypto(asset, CRYPTO[upper]);

  if (upper === "BTC" || upper === "BITCOIN") {
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
      asset: "BTC", asset_type: "crypto", symbol: "BTC", name: "Bitcoin", market_cap_usd: cap, volume_24h_usd: null,
      metrics: [`supply_btc=${supply} at tip ${height}`, `spot_usd=${price}`, "derivation=spot x emission-schedule supply"],
      as_of: asOf,
    }, receipt, { answer, verdict: "verified", confidence: 0.9,
      source: `api.coinbase.com BTC-USD spot + mempool.space tip height; fetched ${fetchedAt}` });
  }

  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw upstreamUnavailable("SEC_USER_AGENT_MISSING", "SEC_USER_AGENT environment variable is required for SEC EDGAR requests");
  let tickersBody: string, sharesBody: string, chartBody: string;
  try {
    tickersBody = await fetchText(TICKERS_URL, ua);
  } catch (err) {
    throw upstreamUnavailable("SEC_UNAVAILABLE", `SEC company_tickers fetch failed: ${err instanceof Error ? err.message : "unknown"}`);
  }
  let entries: SecEntry[];
  try {
    const parsed = JSON.parse(tickersBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid SEC index");
    entries = Object.values(parsed);
    if (!entries.length || entries.some((e) => !e || typeof e !== "object")) throw new Error("invalid SEC rows");
  } catch { throw upstreamUnavailable("SEC_MALFORMED", "SEC company ticker response was malformed; no asset guessed"); }
  let row = resolveSec(entries, asset);
  let searchBody: string | null = null;
  const searchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(asset.trim().toLowerCase().replace(/\s+/g," "))}&quotesCount=10&newsCount=0`;
  let searchObservation: EquityObservation | undefined;
  if (!row) {
    const resolveSearch = (body: string): SecEntry => {
      let quotes: { symbol?: string; quoteType?: string; shortname?: string; longname?: string }[];
      try {
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed.quotes)) throw new Error("invalid quotes");
        quotes = parsed.quotes;
      } catch { throw upstreamUnavailable("ASSET_SEARCH_UNAVAILABLE", "Yahoo search returned an invalid quote list"); }
      const symbols = new Set(quotes.filter((q) => q && q.quoteType === "EQUITY" &&
        [q.symbol, q.shortname, q.longname].some((n) => typeof n === "string" && companyName(n) === companyName(asset)))
        .map((q) => q.symbol?.toUpperCase()));
      const candidates = entries.filter((e) => symbols.has(e.ticker?.toUpperCase()));
      if (candidates.length > 1) throw unprocessable("AMBIGUOUS_ASSET", "Yahoo search resolved multiple SEC-listed equities; supply an exact ticker");
      if (!candidates[0] || typeof candidates[0].cik_str !== "number") throw unprocessable("UNSUPPORTED_ASSET", "Yahoo search had no unambiguous SEC-listed equity");
      return candidates[0];
    };
    try {
      searchObservation = await cachedYahooSearch(asset, () => fetchText(searchUrl), body => { resolveSearch(body); });
      searchBody = searchObservation.body;
      row = resolveSearch(searchBody);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) throw err;
      throw upstreamUnavailable("ASSET_SEARCH_UNAVAILABLE", "SEC title/ticker had no match and Yahoo search is unavailable");
    }
  }
  if (!row || typeof row.cik_str !== "number") {
    throw unprocessable("UNSUPPORTED_ASSET", `No unambiguous SEC-listed equity for "${asset}" after SEC title/ticker and Yahoo search; crypto coverage is BTC, ETH and SOL only`);
  }
  const ticker = String(row.ticker).toUpperCase();
  const cik10 = String(row.cik_str).padStart(10, "0");
  let quote: EquityObservation;
  try {
    [sharesBody, quote] = await Promise.all([
      fetchText(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10}/dei/EntityCommonStockSharesOutstanding.json`, ua),
      cachedEquityQuote(ticker, () => fetchText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`), body => {
        const m = JSON.parse(body)?.chart?.result?.[0]?.meta;
        if (!m || m.symbol !== ticker || m.instrumentType !== "EQUITY" || m.currency !== "USD" || typeof m.regularMarketPrice !== "number" || !Number.isFinite(m.regularMarketPrice) || m.regularMarketPrice <= 0 || typeof m.regularMarketTime !== "number" || !Number.isFinite(m.regularMarketTime) || m.regularMarketTime * 1000 > Date.now()+60_000 || Date.now()-m.regularMarketTime*1000 > 7*86400000) throw new Error("invalid or over7day quote");
      }),
    ]);
  } catch (err) {
    throw upstreamUnavailable("SOURCE_UNREACHABLE", `an equity source could not be reached: ${err instanceof Error ? err.message : "unknown"}`);
  }
  chartBody = quote.body;
  const quoteAgeSeconds = Math.floor((Date.now()-Date.parse(quote.fetchedAt))/1000);
  const quoteStale = Boolean(quote.staleReason);
  const searchStale = Boolean(searchObservation?.staleReason), anyStale = quoteStale || searchStale;
  const staleReason = [quote.staleReason, searchStale ? `name-to-ticker resolution: ${searchObservation!.staleReason}` : undefined].filter(Boolean).join("; ");
  const resolutionEvidence = searchObservation ? { stale:searchStale, fetched_at:searchObservation.fetchedAt,
    age_seconds:Math.floor((Date.now()-Date.parse(searchObservation.fetchedAt))/1000), stale_reason:searchObservation.staleReason } : null;
  let shares: ReturnType<typeof latestShares>;
  let meta: Record<string, unknown> | undefined;
  try { JSON.parse(sharesBody); } catch { throw upstreamUnavailable("SEC_MALFORMED", "SEC shares response was malformed JSON"); }
  shares = latestShares(sharesBody);
  try {
    meta = (JSON.parse(chartBody) as { chart?: { result?: { meta?: Record<string, unknown> }[] | null } }).chart?.result?.[0]?.meta;
  } catch { throw upstreamUnavailable("YAHOO_MALFORMED", "Yahoo chart response was malformed JSON"); }
  if (!meta) throw unprocessable("TICKER_NOT_FOUND", `Yahoo carried no chart for ${ticker}`);
  if (String(meta.symbol ?? "").toUpperCase() !== ticker || meta.instrumentType !== "EQUITY" || meta.currency !== "USD") {
    throw unprocessable("UNSUPPORTED_ASSET", `${ticker} is not a USD US equity on the price source; refusing a mismatched figure`);
  }
  const price = Number(meta.regularMarketPrice);
  const volumeShares = Number(meta.regularMarketVolume);
  if (!Number.isFinite(price) || price <= 0) throw unprocessable("NO_USABLE_PRICE", "the price source carried no usable regular-market price");
  const marketTime = typeof meta.regularMarketTime === "number" ? new Date(meta.regularMarketTime * 1000).toISOString() : "unknown";
  const cap = Math.round(price * shares.val);
  if (cap <= 0 || cap > 1e15) throw unprocessable("OUT_OF_CONTRACT_RANGE", "the computed cap is outside the contract range; refusing to serve it");
  // The contract field is rolling 24h USD volume; Yahoo's keyless chart
  // carries only the latest regular session, so the field is null.
  const volumeUsd: number | null = null;
  const sessionVolumeUsd = Number.isFinite(volumeShares) && volumeShares >= 0 ? Math.round(volumeShares * price) : null;
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ asset: ticker, as_of: quote.fetchedAt, derivation_at: asOf, cik: cik10, stale: anyStale, quote_stale: quoteStale, resolution_observation: resolutionEvidence, stale_reason: staleReason || undefined, quote_fetched_at: quote.fetchedAt, quote_age_seconds: quoteAgeSeconds,
    derivation: "market_cap_usd = Yahoo regularMarketPrice x SEC EDGAR dei:EntityCommonStockSharesOutstanding (latest reported); volume_24h_usd is null: the contract field is rolling 24h USD volume and Yahoo's keyless chart carries only the latest regular session (reported separately in metrics); Yahoo's own market-cap endpoints are crumb-gated, so the cap is derived, not copied",
    price_usd: price, market_time: marketTime, shares_outstanding: shares.val,
    shares_as_of: shares.end, shares_filed: shares.filed, shares_accession: shares.accn,
    volume_shares: Number.isFinite(volumeShares) ? volumeShares : null, market_cap_usd: cap, volume_24h_usd: volumeUsd,
    session_volume_usd: sessionVolumeUsd,
    resolution: { requested_asset: asset, resolved_name: row.title, ticker, yahoo_search_url: searchBody === null ? null : searchUrl, observation: resolutionEvidence },
    raw_bodies: { company_tickers: tickersBody, yahoo_search: searchBody, sec_shares: sharesBody, yahoo_chart: chartBody }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, `${TICKERS_URL} + data.sec.gov + query1.finance.yahoo.com`, evidence, `SEC EDGAR shares outstanding x Yahoo regular-market price; derivation disclosed${anyStale ? "; STALE SOURCE DISCLOSED" : ""}`);
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer = `${quoteStale ? "STALE CACHED QUOTE, not current market data. " : ""}${ticker} market cap: $${cap.toLocaleString("en-US")}, derived as the Yahoo regular-market price ($${price}, exchange time ${marketTime}) x ${shares.val.toLocaleString("en-US")} shares outstanding reported to the SEC as of ${shares.end} (filed ${shares.filed}, accession ${shares.accn}). ` +
    (sessionVolumeUsd !== null ? `Rolling 24h USD volume is not served (the keyless source carries only the latest regular session: $${sessionVolumeUsd.toLocaleString("en-US")} in that session). ` : "Volume is not served: the price source carried none. ") +
    `The cap is derived from two named sources, not copied from a vendor; the quote may be delayed. P/E, revenue, net income and EPS are not served: those figures are not present in the retrieved shares/price records.`;
  return envelope(INTENT, {
    asset: ticker, asset_type: "equity", symbol: ticker, name: row.title, resolved_name: row.title, market_cap_usd: cap, volume_24h_usd: volumeUsd,
    metrics: [`shares_outstanding=${shares.val} as of ${shares.end} (filed ${shares.filed}, ${shares.accn})`, `price_usd=${price} at ${marketTime}`, "derivation=price x shares outstanding",
      `latest_regular_session_volume_usd=${sessionVolumeUsd ?? "none"} (not rolling 24h)`],
    as_of: quote.fetchedAt, stale: anyStale, quote_stale: quoteStale, resolution_observation: resolutionEvidence, quote_fetched_at: quote.fetchedAt, quote_age_seconds: quoteAgeSeconds, ...(anyStale ? {stale_reason:staleReason}:{}),
  }, receipt, { answer: (searchStale ? `STALE CACHED NAME-TO-TICKER RESOLUTION. Original search acquired ${searchObservation!.fetchedAt}, age ${resolutionEvidence!.age_seconds}s; ${searchObservation!.staleReason}; revalidated against the current SEC index, not a fresh search. ` : "") + answer + ` Quote acquired ${quote.fetchedAt}, age ${quoteAgeSeconds}s; exchange time ${marketTime}. ${quoteStale ? quote.staleReason + "; original exact quote retained; SEC shares fetched independently now, mixed-age derivation, no price estimated or updated." : "Quote may be cached up to5minutes."}`, verdict: anyStale ? "stale" : "verified", confidence: anyStale ? 0.5 : 0.85,
    source: `SEC EDGAR (${TICKERS_URL} + companyconcept) + Yahoo chart; fetched ${fetchedAt}` });
}
