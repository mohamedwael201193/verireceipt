// CRYPTO_PRICE_USD — GET /v1/crypto-price?symbol=<SYM>
//
// Zero-LLM. Current USD spot price for a crypto symbol, with a SHA-256
// receipt over the exact upstream response body.
//
// Intent contract (read 2026-11-22): request symbol (string); scored
// price in [0.0001, 10000000].
//
// SOURCE: Coinbase public spot API (api.coinbase.com), keyless, probed
// live 2026-11-23. Single named source, honestly scoped: it is one
// exchange's last spot quote, named as such in every answer — not an
// index, not a VWAP. Symbols the source does not list are an honest
// 422 (the source's 404 is surfaced, never guessed). A price outside
// the contract range is refused. The on-chain /v1/price intent
// (Chainlink anchors) is untouched.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { parseSpot } from "./miningHashprice";

const SOURCE_TIMEOUT_MS = 6000;
const UA = "VeriReceipt/2.0 crypto-price observer (+https://verireceipt.vercel.app)";

export const INTENT = "CRYPTO_PRICE_USD";

export async function handleCryptoPrice(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const symbol = query.symbol?.trim().toUpperCase();
  if (!symbol) throw badRequest("MISSING_PARAM", "symbol is required (e.g. BTC, ETH)");
  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) throw badRequest("BAD_SYMBOL", "symbol must be 2-12 letters or digits");
  const url = `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`;
  const fetchedAt = new Date().toISOString();
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
    try {
      res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw upstreamUnavailable("COINBASE_UNREACHABLE", "the Coinbase spot API could not be reached");
  }
  if (res.status === 404) {
    throw unprocessable("SYMBOL_NOT_LISTED", `the Coinbase spot API does not list ${symbol}-USD; no price is guessed`);
  }
  if (!res.ok) throw upstreamUnavailable("COINBASE_UNREACHABLE", `the Coinbase spot API answered HTTP ${res.status}`);
  const body = await res.text();
  const price = parseSpot(body);
  if (price < 0.0001 || price > 10000000) {
    throw unprocessable("OUT_OF_CONTRACT_RANGE", `the quoted price ${price} is outside the contract range; not served`);
  }
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ symbol, as_of: asOf, price,
    source_policy: "Coinbase public spot API, single named source; one exchange's last spot quote, not an index or VWAP",
    raw_bodies: { spot: body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, url, evidence, "Coinbase public spot, single source honestly named");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer =
    `${symbol}/USD spot ${price} on Coinbase, fetched ${fetchedAt}. ` +
    `This is one named exchange's public spot quote, not an index or VWAP; symbols the source does not list are refused.`;
  return envelope(INTENT, {
    symbol, price, quote_currency: "USD",
  }, receipt, { answer, verdict: "verified", confidence: 0.85,
    source: `${url}; Coinbase public spot single source; fetched ${fetchedAt}` });
}
