import {fetchYahooBody} from './yahooTransport';
// STOCK_PRICE_US_EQUITY — GET /v1/stock-price?ticker=AAPL
//
// Zero-LLM. Serves the latest quote for a US-listed equity from the
// Yahoo Finance chart API, with a SHA-256 receipt over the exact
// upstream response body.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/STOCK_PRICE_US_EQUITY,
// read 2026-11-22): request ticker (string, e.g. AAPL); scored response
// price_usd (number, range [0.01, 1e6]).
//
// SOURCE: Yahoo Finance chart API (query1.finance.yahoo.com), keyless
// and unauthenticated, probed live 2026-11-23. Evaluated and rejected:
//   - Stooq CSV (the research plan's pick): now sits behind a JS
//     proof-of-work browser challenge — not served to a server honestly.
//   - CNBC quote webservice: HTTP 403 from this egress.
//   - api.nasdaq.com: vendor error for the quote endpoint.
//   - TradingView scanner: HTTP 405.
// So this is a SINGLE source, named honestly, confidence 0.9 — there is
// no second independent keyless feed to agree with, and no price is
// ever averaged or invented.
//
// DELAY HONESTY (standing rule): the quote is Yahoo's latest
// regularMarketPrice with Yahoo's own regularMarketTime. It is NEVER
// presented as real-time: the answer names the exchange timestamp and
// says the quote may be delayed (Yahoo serves delayed data for many
// listings). Freshness is what the source says it is.
//
// SCOPE GUARD: only instrumentType EQUITY quoted in USD is served —
// ETFs, crypto, indices and non-USD listings are 422 NOT_US_EQUITY,
// because the contract scores a US equity share price and nothing else.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { cachedEquityQuote, assertYahooAllowed, noteYahooRateLimit } from "./equityQuoteCache";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 5000;
const UA = "VeriReceipt/2.0 stock-price observer (+https://verireceipt.vercel.app)";

async function fetchText(url:string):Promise<string>{return fetchYahooBody(url,assertYahooAllowed,noteYahooRateLimit);}

const TICKER_RE = /^[A-Za-z]{1,5}([.-][A-Za-z]{1,2})?$/;

export interface YahooQuote {
  symbol: string; price: number; currency: string; instrumentType: string;
  marketTime: string; exchange: string;
}

export function parseYahooChart(raw: string, wantSymbol: string, nowMs=Date.now()): YahooQuote {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw upstreamUnavailable("YAHOO_BAD_BODY", "Yahoo returned a non-JSON body");
  }
  const chart = (parsed as { chart?: { result?: unknown; error?: { code?: string } | null } }).chart;
  if (!chart) throw upstreamUnavailable("YAHOO_BAD_BODY", "Yahoo body has no chart object");
  if (chart.result === null || chart.error) {
    throw unprocessable("TICKER_NOT_FOUND", `no Yahoo chart for ${wantSymbol}; the symbol may not exist or may be delisted`);
  }
  if(!Array.isArray(chart.result)||chart.result.length!==1)throw upstreamUnavailable('YAHOO_BAD_BODY','Yahoo chart must contain exactly one matching instrument');
  const meta = (chart.result as { meta?: unknown }[])[0]?.meta as Record<string, unknown> | undefined;
  if (!meta) throw upstreamUnavailable("YAHOO_BAD_BODY", "Yahoo result has no meta");
  if (typeof meta.symbol !== "string" || meta.symbol.toUpperCase() !== wantSymbol.toUpperCase()) {
    throw unprocessable("TICKER_NOT_FOUND", `Yahoo answered for ${String(meta.symbol)}, not ${wantSymbol}; refusing a mismatched quote`);
  }
  if (meta.instrumentType !== "EQUITY" || meta.currency !== "USD") {
    throw unprocessable("NOT_US_EQUITY", `${wantSymbol} is ${String(meta.instrumentType)} in ${String(meta.currency)}; only USD US equities are served`);
  }
  const price = meta.regularMarketPrice;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0.01 || price > 1e6) {
    throw unprocessable("NO_USABLE_PRICE", `Yahoo carried no usable regular-market price for ${wantSymbol} (market may be closed with no last price)`);
  }
  const mt = meta.regularMarketTime;
  if (typeof mt !== "number" || !Number.isSafeInteger(mt) || mt<=0 || !Number.isFinite(new Date(mt*1000).getTime()) || mt*1000>nowMs+60000) {
    throw upstreamUnavailable("YAHOO_BAD_BODY", "Yahoo meta has no valid non-future regularMarketTime");
  }
  return { symbol: meta.symbol, price, currency: "USD", instrumentType: "EQUITY",
    marketTime: new Date(mt * 1000).toISOString(),
    exchange: typeof meta.fullExchangeName === "string" ? meta.fullExchangeName : String(meta.exchangeName ?? "unknown") };
}

export const INTENT = "STOCK_PRICE_US_EQUITY";

export async function handleStockPrice(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const rawTicker = query.ticker?.trim();
  if (!rawTicker) throw badRequest("MISSING_PARAM", "ticker is required");
  if (!TICKER_RE.test(rawTicker)) throw badRequest("INVALID_TICKER", "ticker must be 1-5 letters, optional .X class suffix (e.g. AAPL, BRK.B)");
  // Yahoo spells class shares with a dash (BRK-B); accept both, serve Yahoo's spelling.
  const ticker = rawTicker.toUpperCase().replace(".", "-");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const observation = await cachedEquityQuote(ticker, () => fetchText(url), body => { parseYahooChart(body, ticker); },{freshMs:55_000,maxAgeMs:60_000}).catch((err: unknown) => {
    if (err instanceof Error && "code" in err) throw err;
    throw upstreamUnavailable("YAHOO_UNREACHABLE", `Yahoo chart fetch failed: ${err instanceof Error ? err.message : "unknown error"}`);
  });
  const {body: raw, fetchedAt, staleReason} = observation;
  const quote = parseYahooChart(raw, ticker);
  const asOf = fetchedAt;
  const stale = Boolean(staleReason), ageSeconds = Math.floor((Date.now()-Date.parse(fetchedAt))/1000);
  if(!Number.isFinite(ageSeconds)||ageSeconds<0||ageSeconds>=60)throw upstreamUnavailable('QUOTE_OBSERVATION_TOO_OLD','Yahoo acquisition age must be under60seconds');
  const marketAgeSeconds=Math.max(0,Math.floor((Date.now()-Date.parse(quote.marketTime))/1000));
  const evidence = JSON.stringify({ ticker, as_of: asOf, quote, stale, stale_reason: staleReason, quote_age_seconds: ageSeconds, acquisition_age_seconds:ageSeconds, source_market_age_seconds:marketAgeSeconds,
    source_policy: "Yahoo Finance chart API, keyless unauthenticated; single source, honestly named; quote is Yahoo's latest regular-market price, may be delayed, never presented as real-time",
    raw_body: raw, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, url, evidence, "Yahoo chart API single source; the quote is Yahoo's own, with Yahoo's exchange timestamp");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  return envelope(INTENT, { ticker: quote.symbol, price_usd: quote.price, currency: "USD",
    exchange: quote.exchange, market_time: quote.marketTime, as_of: asOf, fetched_at: fetchedAt, stale, quote_age_seconds: ageSeconds, acquisition_age_seconds:ageSeconds, source_market_age_seconds:marketAgeSeconds, ...(stale ? {stale_reason:staleReason} : {}) }, receipt, {
    answer: `${stale ? "STALE CACHED QUOTE, not current market data. " : ""}${quote.symbol}: $${quote.price} USD on ${quote.exchange}, Yahoo Finance quote timestamped ${quote.marketTime}. ` +
      `This is Yahoo's latest regular-market price and may be delayed (Yahoo serves delayed data for many listings); it is NOT a guaranteed real-time quote. Single source: Yahoo Finance chart API. Original quote acquired ${fetchedAt}, age ${ageSeconds}s. ${stale ? staleReason + "; exact original observation retained, no price or timestamp updated." : "Acquisition/cache age under60seconds; source timestamp may be older, including the last market close."}`,
    verdict: stale ? "stale" : "verified",
    confidence: stale ? 0.5 : 0.9,
    source: `${url}; Yahoo Finance chart API single source, quote may be delayed, never presented as real-time; exchange timestamp ${quote.marketTime}; fetched ${fetchedAt}`,
  });
}
