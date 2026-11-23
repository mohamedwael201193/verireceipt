// PAYMENT_METHOD_VERIFY_GENERAL — GET /v1/payment-method?bin=<6-8 digits>
//
// Zero-LLM. Verifies a card BIN (bank identification number, the first
// 6-8 digits of a card number) against a public BIN database, with a
// SHA-256 receipt over the exact upstream body.
//
// Intent contract (read 2026-11-23): request bin (integer 100000..
// 99999999 — a PREFIX, never a full card number); scored valid (bool),
// described as "structurally valid (checksum passes)".
//
// HONEST SCOPE: a bare BIN carries NO checksum — Luhn needs the full
// card number, which this intent deliberately never receives. So
// valid=true means exactly "this prefix is allocated and known to the
// BIN database", and valid=false means "no record in the database",
// which is not proof the prefix is unallocated. The answer says so.
//
// SOURCE: binlist.net lookup API, keyless, probed live 2026-11-23.
// The free tier is rate-limited (~10 requests/min/IP), so positive and
// negative lookups are cached in memory for CACHE_TTL_MS and the cache
// freshness is named. FAIL CLOSED (502) on outage, 429, or 5xx — a
// throttled guess is a wrong answer. 400/404 is the database's own
// "no such BIN" and yields valid=false.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // BIN allocations change rarely; named in every answer
const UA = "VeriReceipt/2.0 payment-method observer (+https://verireceipt.vercel.app)";

export const INTENT = "PAYMENT_METHOD_VERIFY_GENERAL";

interface BinlistReply {
  scheme?: string;
  type?: string;
  brand?: string;
  country?: { alpha2?: string; name?: string };
  bank?: { name?: string };
}

interface CacheEntry { at: number; found: boolean; body: string }
const cache = new Map<string, CacheEntry>();
export function resetBinCacheForTests(): void { cache.clear(); }

async function lookupBin(bin: string): Promise<{ found: boolean; body: string; cached: boolean; fetchedAt: string }> {
  const hit = cache.get(bin);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { found: hit.found, body: hit.body, cached: true, fetchedAt: new Date(hit.at).toISOString() };
  }
  const url = `https://lookup.binlist.net/${bin}`;
  const fetchedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, "Accept-Version": "3", Accept: "application/json" } });
  } catch (e) {
    throw upstreamUnavailable("BINLIST_UNREACHABLE", `the BIN database could not be reached: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 400 || res.status === 404) {
    cache.set(bin, { at: Date.now(), found: false, body: "" });
    return { found: false, body: "", cached: false, fetchedAt };
  }
  if (!res.ok) {
    throw upstreamUnavailable("BINLIST_DEGRADED", `the BIN database answered HTTP ${res.status} (rate limit or outage); refusing to guess`);
  }
  const body = await res.text();
  cache.set(bin, { at: Date.now(), found: true, body });
  return { found: true, body, cached: false, fetchedAt };
}

export async function handlePaymentMethod(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const raw = query.bin?.trim();
  if (!raw) throw badRequest("MISSING_PARAM", "bin is required: the first 6 to 8 digits of the card number — never the full number");
  if (!/^\d{6,8}$/.test(raw)) throw badRequest("INVALID_BIN", "bin must be exactly 6 to 8 digits; the full card number is never accepted");
  const { found, body, cached, fetchedAt } = await lookupBin(raw);
  const asOf = new Date().toISOString();
  let info: BinlistReply = {};
  if (found) {
    try {
      info = JSON.parse(body);
    } catch {
      throw upstreamUnavailable("BINLIST_MALFORMED", "the BIN database returned a body that is not JSON; refusing to answer");
    }
  }
  const valid = found;
  const network = info.scheme ?? null;
  const issuingBank = info.bank?.name ?? null;
  const issuingCountry = info.country?.name ?? null;
  const cardType = info.type ?? null;
  const evidence = JSON.stringify({
    bin: raw, valid, network, issuing_bank: issuingBank, issuing_country: issuingCountry, card_type: cardType,
    upstream: { url: `https://lookup.binlist.net/${raw}`, status: found ? 200 : "400/404 (no record)", body: found ? body : null, cached },
    scope: "a BIN has no checksum (Luhn needs the full card number, which is never received); valid means the prefix is allocated and known to the binlist.net database — valid=false is 'no record', not proof the prefix is unallocated",
    fetched_at: fetchedAt, as_of: asOf,
  });
  const receipt = makeReceipt(INTENT, `https://lookup.binlist.net/${raw}`, evidence, "single keyless BIN database lookup (cached up to 24h); exact upstream body embedded in receipted evidence");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer = valid
    ? `Yes, BIN ${raw} is an allocated, known card prefix: ${network ?? "unknown network"}${cardType ? ` ${cardType}` : ""}` +
      (issuingBank ? `, issued by ${issuingBank}` : "") + (issuingCountry ? `, ${issuingCountry}` : "") +
      ` (binlist.net record${cached ? ", served from the 24h cache fetched " + fetchedAt : " fetched " + fetchedAt}). ` +
      `Scope: a BIN alone has no checksum to verify — this confirms the prefix is allocated, not that any card number with it is real, active, or safe to accept.`
    : `No record for BIN ${raw} in the binlist.net database (its own "no such BIN" answer, fetched ${fetchedAt}). ` +
      `That is not proof the prefix is unallocated — the database does not cover every issuer — and a BIN alone carries no checksum to verify.`;
  return envelope(INTENT, {
    bin: raw,
    valid,
    network,
    issuing_bank: issuingBank,
    issuing_country: issuingCountry,
    card_type: cardType,
    summary: valid
      ? `${raw}: known ${network ?? "?"}${cardType ? ` ${cardType}` : ""} prefix${issuingBank ? ` (${issuingBank})` : ""}; allocation-only check.`
      : `${raw}: no record in the BIN database; not proof of non-allocation.`,
  }, receipt, { answer, verdict: "verified", confidence: 0.9,
    source: `binlist.net https://lookup.binlist.net/${raw} (${cached ? "cache, fetched " : "fetched "}${fetchedAt}; exact body in receipt)` });
}
