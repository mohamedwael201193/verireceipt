import {equityVolumeFromObservation} from './equityVolume';
import {annualFinancialMetrics} from './annualFinancialMetrics';
import {financialCoin} from './financialCoins';
import {internationalEquity} from './financialInternational';
import {withAnswerClass} from '../core/answerClass';
import {fetchYahooBody} from './yahooTransport';
import {cachedSecFinancial,type SecObservation} from './secFinancialCache';
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
// non-SEC exact equity matches use reported ordinary shares, chart price and FX.
// Ambiguous matches are never selected.
// BTC retains its emission-schedule methodology. Other supported crypto use CoinPaprika
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
  if(yahoo)return fetchYahooBody(url,assertYahooAllowed,noteYahooRateLimit);
  const controller = new AbortController();
  let timer:ReturnType<typeof setTimeout>;
  try {
    const io=(async()=>{const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": ua, Accept: "application/json" } });
    if (yahoo && res.status === 429) noteYahooRateLimit(res.headers.get("retry-after"));
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), {status:res.status});
    return await res.text();})();
    return await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error("financial source deadline"));},SOURCE_TIMEOUT_MS);})]);
  } finally {
    clearTimeout(timer!);
  }
}

interface SecEntry { cik_str?: number; ticker?: string; title?: string }
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
    volume_24h_usd: volume, metrics: ["methodology=CoinPaprika aggregated market cap and rolling 24h volume", ...(staleReason ? [`stale=${staleReason}; original acquisition ${fetchedAt}`] : [])].join("; "), as_of: asOf }, receipt,
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

async function financialData(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const supplied=[query.asset,query.ticker,query.symbol,query.company,query.query].filter(v=>v?.trim()).map(v=>v!.trim());
  if(supplied.length>1&&supplied.some(v=>v.toLowerCase()!==supplied[0].toLowerCase()))throw badRequest('CONFLICTING_ASSET','asset aliases disagree');
  const asset = supplied[0];
  if (!asset) throw badRequest("MISSING_PARAM", "asset is required: a US-listed company/ticker, BTC, ETH or SOL");
  if (new TextEncoder().encode(asset).length > 256) throw badRequest("BAD_ASSET", "asset must be at most 256 UTF-8 bytes");
  const fetchedAt = new Date().toISOString();
  const upper = asset.toUpperCase();

  const crypto=financialCoin(asset);if(crypto)return aggregatedCrypto(asset,crypto);

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
      metrics: [`supply_btc=${supply} at tip ${height}`, `spot_usd=${price}`, "derivation=spot x emission-schedule supply"].join("; "),
      as_of: asOf,
    }, receipt, { answer, verdict: "verified", confidence: 0.9,
      source: `api.coinbase.com BTC-USD spot + mempool.space tip height; fetched ${fetchedAt}` });
  }

  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw upstreamUnavailable("SEC_USER_AGENT_MISSING", "SEC_USER_AGENT environment variable is required for SEC EDGAR requests");
  let tickersBody: string, sharesBody: string, chartBody: string;
  let indexObservation:SecObservation,sharesObservation:SecObservation;
  const validateIndex=(body:string)=>{let d;try{d=JSON.parse(body);}catch{throw upstreamUnavailable('SEC_MALFORMED','invalid SEC JSON');}if(!d||typeof d!=='object'||Array.isArray(d)||!Object.keys(d).length||Object.values(d).some((e:any)=>!e||typeof e!=='object'||!Number.isInteger(e.cik_str)||e.cik_str<=0||typeof e.ticker!=='string'||!e.ticker||typeof e.title!=='string'))throw upstreamUnavailable('SEC_MALFORMED','invalid SEC index');};
  try {
    indexObservation=await cachedSecFinancial('index','company_tickers',()=>fetchText(TICKERS_URL,ua),validateIndex);tickersBody=indexObservation.body;
  } catch (err) {
    if((err as any)?.code)throw err;
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
    const resolveSearch = (body: string): SecEntry | undefined => {
      let quotes: { symbol?: string; quoteType?: string; shortname?: string; longname?: string }[];
      try {
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed.quotes)) throw new Error("invalid quotes");
        quotes = parsed.quotes;
      } catch { throw upstreamUnavailable("ASSET_SEARCH_UNAVAILABLE", "Yahoo search returned an invalid quote list"); }
      const candidates=quotes.filter(q=>q&&q.quoteType==='EQUITY'&&typeof q.symbol==='string'&&/^[A-Za-z0-9^][A-Za-z0-9.^=-]{0,29}$/.test(q.symbol)&&[q.symbol,q.shortname,q.longname].some(n=>typeof n==='string'&&companyName(n)===companyName(asset)));
      const unique=[...new Map(candidates.map(q=>[q.symbol!.toUpperCase(),q])).values()];
      if(unique.length>1)throw unprocessable('AMBIGUOUS_ASSET','multiple exact equity search matches; supply an exact ticker');
      if(!unique[0])return undefined;
      const quote=unique[0],sec=entries.find(e=>e.ticker?.toUpperCase()===quote.symbol!.toUpperCase());
      return sec??{ticker:quote.symbol!.toUpperCase(),title:quote.longname??quote.shortname??quote.symbol};
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
  if(!row){
    const evidence=JSON.stringify({requested_asset:asset,reason_code:'unsupported_asset',search_acquired_at:searchObservation?.fetchedAt,search_stale:Boolean(searchObservation?.staleReason),raw_bodies:{company_tickers:tickersBody,search:searchBody},source_url:searchUrl,fetched_at:fetchedAt});
    const receipt=makeReceipt(INTENT,searchUrl,evidence,'no exact supported asset match; no market data invented');
    try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
    return envelope(INTENT,{asset,market_cap_usd:null,volume_24h_usd:null,reason_code:'unsupported_asset',as_of:fetchedAt},receipt,{answer:`${searchObservation?.staleReason?'STALE cached search evidence, not a fresh asset search. ':''}No exact supported asset match in company index or equity search. Market cap and rolling 24h USD volume are unavailable, not zero. No asset was guessed. Search acquired ${searchObservation?.fetchedAt}.`,verdict:'no_data',confidence:0,source:searchUrl});
  }
  if(typeof row.cik_str!=='number')return internationalEquity(asset,String(row.ticker),String(row.title),searchObservation!,tickersBody,fetchText);
  const ticker = String(row.ticker).toUpperCase();
  const cik10 = String(row.cik_str).padStart(10, "0");
  let quote: EquityObservation;
  try {
    [sharesObservation, quote] = await Promise.all([
      cachedSecFinancial('shares',cik10,()=>fetchText(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10}/dei/EntityCommonStockSharesOutstanding.json`,ua),body=>{const d=JSON.parse(body);if(d.cik!==Number(cik10)||d.taxonomy!=='dei'||d.tag!=='EntityCommonStockSharesOutstanding')throw Error('wrong SEC shares identity');const r=latestShares(body);if(!Number.isFinite(r.val)||r.val<=0||!Number.isFinite(Date.parse(r.end))||!Number.isFinite(Date.parse(r.filed)))throw Error('invalid SEC shares');}),
      cachedEquityQuote(ticker, () => fetchText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`), body => {
        const m = JSON.parse(body)?.chart?.result?.[0]?.meta;
        if (!m || m.symbol !== ticker || m.instrumentType !== "EQUITY" || m.currency !== "USD" || typeof m.regularMarketPrice !== "number" || !Number.isFinite(m.regularMarketPrice) || m.regularMarketPrice <= 0 || typeof m.regularMarketTime !== "number" || !Number.isFinite(m.regularMarketTime) || m.regularMarketTime * 1000 > Date.now()+60_000 || Date.now()-m.regularMarketTime*1000 > 7*86400000) throw new Error("invalid or over7day quote");
      }),
    ]);
  } catch (err) {
    throw upstreamUnavailable("SOURCE_UNREACHABLE", `an equity source could not be reached: ${err instanceof Error ? err.message : "unknown"}`);
  }
  sharesBody=sharesObservation.body;
  const secObservations={company_index_fetched_at:indexObservation.fetchedAt,shares_fetched_at:sharesObservation.fetchedAt,company_index_cache_max_age_seconds:3600,shares_cache_max_age_seconds:900};
  chartBody = quote.body;
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
  // Volume is derived only from the canonical quote observation, never extra I/O.
  const volumeObservation=equityVolumeFromObservation(ticker,quote.body,quote.fetchedAt,`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`);
  const volumeUsd: number | null = volumeObservation.value_usd;
  const {raw_body:volumeRaw,...volumePublic}=volumeObservation;
  const sessionVolumeUsd = Number.isFinite(volumeShares) && volumeShares >= 0 ? Math.round(volumeShares * price) : null;
  const annual=await annualFinancialMetrics(cik10,ua,fetchText);
  const quoteAgeSeconds = Math.floor((Date.now()-Date.parse(quote.fetchedAt))/1000);
  const quoteStale = Boolean(quote.staleReason)||quoteAgeSeconds>=300;
  const searchAgeSeconds=searchObservation?Math.floor((Date.now()-Date.parse(searchObservation.fetchedAt))/1000):null;
  const searchStale = Boolean(searchObservation?.staleReason)||(searchAgeSeconds!==null&&searchAgeSeconds>=300), anyStale = quoteStale || searchStale;
  if(quoteAgeSeconds<0||quoteAgeSeconds>=900||searchAgeSeconds!==null&&(searchAgeSeconds<0||searchAgeSeconds>=900)||Date.now()-Number(meta.regularMarketTime)*1000>7*86400000)throw upstreamUnavailable('SOURCE_EXPIRED','source observation expired during optional enrichment');
  const quoteStaleReason=quote.staleReason??(quoteStale?'quote crossed5minute freshness boundary during optional enrichment':undefined);
  const searchStaleReason=searchObservation?.staleReason??(searchStale?'resolution crossed5minute freshness boundary during optional enrichment':undefined);
  const staleReason = [quoteStaleReason, searchStale ? `name-to-ticker resolution: ${searchStaleReason}` : undefined].filter(Boolean).join("; ");
  const resolutionEvidence = searchObservation ? { stale:searchStale, fetched_at:searchObservation.fetchedAt,
    age_seconds:Math.floor((Date.now()-Date.parse(searchObservation.fetchedAt))/1000), stale_reason:searchStaleReason } : null;
  const annualPublic=Object.fromEntries(Object.entries(annual).map(([k,v])=>{const {raw_body,candidate_observations,...fields}=v as Record<string,unknown>;return[k,{...fields,...(Array.isArray(candidate_observations)?{candidate_observations:candidate_observations.map(({raw_body,...row}:any)=>row)}:{})}];}));
  const structuredMetrics={shares_outstanding:{value:shares.val,period_end:shares.end,filed:shares.filed,accession:shares.accn},price:{value_usd:price,market_time:marketTime},market_cap_method:'regularMarketPrice times latest SEC shares outstanding; mixed-age estimate',trailing_24h_volume:volumePublic,latest_regular_session:{volume_shares:Number.isFinite(volumeShares)&&volumeShares>=0?volumeShares:null,volume_usd_estimate:sessionVolumeUsd,method:'regularMarketPrice times latest regular-session share volume, NOT actual traded-dollar turnover or rolling24hours',market_time:marketTime,exchange_timezone:typeof meta.exchangeTimezoneName==='string'?meta.exchangeTimezoneName:null},...annualPublic};
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ asset: ticker, as_of: quote.fetchedAt, derivation_at: asOf, cik: cik10, stale: anyStale, quote_stale: quoteStale, resolution_observation: resolutionEvidence, stale_reason: staleReason || undefined, quote_fetched_at: quote.fetchedAt, quote_age_seconds: quoteAgeSeconds,
    sec_observations:secObservations,annual_financial_metrics:annual,structured_metrics:structuredMetrics,
    derivation: "market_cap_usd = Yahoo regularMarketPrice x SEC EDGAR dei:EntityCommonStockSharesOutstanding (latest reported); volume_24h_usd is estimated from complete5minute regular-session close-times-share-volume buckets within trailing24hours, excludes extended hours, not exact dollar turnover; unavailable evidence stays null; Yahoo's own market-cap endpoints are crumb-gated, so the cap is derived, not copied",
    price_usd: price, market_time: marketTime, shares_outstanding: shares.val,
    shares_as_of: shares.end, shares_filed: shares.filed, shares_accession: shares.accn,
    volume_shares: Number.isFinite(volumeShares) ? volumeShares : null, market_cap_usd: cap, volume_24h_usd: volumeUsd,
    session_volume_usd: sessionVolumeUsd,volume_observation:volumeObservation,volume_basis:volumeObservation.basis,
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
    (volumeUsd!==null?`Trailing24h regular-session USD volume estimate: $${volumeUsd.toLocaleString("en-US")}, sum of complete5minute bucket close times share volume, excludes pre/post-market and is not exact dollar turnover; window ${volumePublic.window_start} to ${volumePublic.window_end}, source acquired ${volumeObservation.fetched_at}. `: "Trailing24h bucket estimate unavailable. ") +
    (sessionVolumeUsd !== null ? `Latest regular session proxy (separate from trailing24h bucket estimate): $${sessionVolumeUsd.toLocaleString("en-US")}, current price times session shares, not actual dollar turnover. ` : "Volume is not served: the price source carried none. ") +
    `The cap is derived from two named sources, not copied from a vendor; the quote may be delayed. Annual SEC revenue, net income and total assets are separately reported in structured metrics when available, each with its own period and filing date. ${Object.values(annualPublic).some((m:any)=>String(m.period_alignment).startsWith('mixed'))?'WARNING: annual metrics have mixed period ends, not one fiscal year. ':''}P/E and EPS are not asserted.`;
  return envelope(INTENT, {
    asset: ticker, asset_type: "equity", symbol: ticker, name: row.title, resolved_name: row.title, market_cap_usd: cap, volume_24h_usd: volumeUsd,volume_basis:volumeObservation.basis,volume_observation:volumePublic,
    metrics:[`shares_outstanding=${shares.val} as of ${shares.end} (filed ${shares.filed})`,`price_usd=${price} at ${marketTime}`,'market_cap=price x shares outstanding (mixed-age estimate)',`latest_regular_session.volume_usd_estimate=${sessionVolumeUsd??'unavailable'}; method=current price x regular-session shares, not actual dollar turnover or rolling24h`,...Object.entries(annualPublic).map(([key,value])=>{const v=value as any,f=v.fact;return f?`${key}=${f.value_usd} USD; period=${f.period_start??'instant'} to ${f.period_end}; filed=${f.filed}; concept=${f.concept}`:`${key}=${v.status}`;})].join('; '),
    structured_metrics:structuredMetrics,
    sec_observations:secObservations,
    as_of: quote.fetchedAt, stale: anyStale, quote_stale: quoteStale, resolution_observation: resolutionEvidence, quote_fetched_at: quote.fetchedAt, quote_age_seconds: quoteAgeSeconds, ...(anyStale ? {stale_reason:staleReason}:{}),
  }, receipt, { answer: (searchStale ? `STALE CACHED NAME-TO-TICKER RESOLUTION. Original search acquired ${searchObservation!.fetchedAt}, age ${resolutionEvidence!.age_seconds}s; ${searchStaleReason}; revalidated against the bounded-cache SEC index, not a fresh search. ` : "") + answer + ` SEC company index acquired ${indexObservation.fetchedAt} (cached up to1hour); shares acquired ${sharesObservation.fetchedAt} (cached up to15minutes). Mixed-age derivation, no source timestamp advanced by cache reuse. Quote acquired ${quote.fetchedAt}, age ${quoteAgeSeconds}s; exchange time ${marketTime}. ${quoteStale ? quoteStaleReason + "; original exact quote retained; SEC shares acquired independently at their disclosed timestamp, mixed-age derivation, no price estimated or updated." : "Quote may be cached up to5minutes."}`, verdict: anyStale ? "stale" : "verified", confidence: anyStale ? 0.5 : 0.85,
    source: `SEC EDGAR (${TICKERS_URL} + companyconcept) + Yahoo chart; fetched ${fetchedAt}` });
}

export async function handleFinancialData(query:Record<string,string|undefined>):Promise<Record<string,unknown>>{
 try{const out=await financialData(query);return withAnswerClass(out,INTENT,{asset_resolution:out.reason_code==='unsupported_asset'?'unsupported_asset':'resolved'});}
 catch(err){if(err&&typeof err==='object'&&(err as any).code==='AMBIGUOUS_ASSET')throw withAnswerClass(err,INTENT,{asset_resolution:'ambiguous_asset'});throw err;}
}
