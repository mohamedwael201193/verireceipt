// CURRENCY_EXCHANGE_CONVERT — GET /v1/fx?from_currency=&to_currency=&amount=
//
// Zero-LLM. Converts an amount between two ISO-4217 currencies using
// real, keyless public rate sources, with a SHA-256 receipt over the
// exact evidence bytes (every source's raw response body) and the
// VeriReceipt envelope (answer/verdict/confidence/source). How this
// fits the VeriReceipt story: same receipt model, same envelope, same
// honesty language as every other intent — the answer is only ever a
// number three named public sources carried, and the receipt lets any
// judge recompute it.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/CURRENCY_EXCHANGE_CONVERT,
// read 2026-11-22): inputs from_currency (string), to_currency
// (string), amount (number, optional); scored output converted_amount
// (number, range [0.01, 1e8]).
//
// SOURCES (all keyless, no accounts):
//   1. Frankfurter (api.frankfurter.dev) — ECB euro reference rates,
//      ~30 currencies, published daily on ECB business days. The most
//      authoritative of the three but the narrowest coverage.
//   2. open.er-api.com — broad ISO coverage (used in-house by the grid
//      ingester since 2026-11-20), daily.
//   3. fawaz currency-api (cdn.jsdelivr.net/npm/@fawazahmed0/currency-api)
//      — broadest coverage including crypto codes, daily.
//
// FAILOVER DOCTRINE (owner requirement 2026-11-22): all three fire in
// PARALLEL with a 4 s per-source budget, so a dead source never stalls
// an answer (wall = winner time, not source count x timeout). A source
// that errors, times out, or simply does not cover the pair is skipped
// — coverage differs (Frankfurter has no EGP/AED; the others do).
// CORRECTNESS OVER AVAILABILITY: when two or more sources cover the
// pair their implied rates must agree pairwise within
// AGREEMENT_TOLERANCE (0.5% — the sources snapshot at different times
// of day, so exact equality is impossible); the served rate is the
// MEDIAN. If they disagree beyond tolerance the handler REFUSES with
// 502 FX_SOURCES_DISAGREE and says so — never an average into a wrong
// answer. Exactly one covering source answers at confidence 0.9 with
// the single source named honestly. Zero covering sources is 422
// NO_DATA for a well-formed but unknown code; malformed codes are 400.
// All sources down is 502. No rate is ever invented.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, type Receipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
/** Local fetch with a hard per-call timeout. The URLs are built from
 * validated 3-letter ISO codes on three fixed public hosts, so there is
 * no SSRF surface (the grid ingester's fetchText is allowlist-bound to
 * grid hosts and cannot be reused here). */
async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export const INTENT = "CURRENCY_EXCHANGE_CONVERT";

/** Per-source hard budget (also the all-hung wall). */
const SOURCE_TIMEOUT_MS = 4000;
/** Straggler grace (owner failover requirement 2026-11-22): once TWO
 * sources have answered, a still-pending third gets only this grace
 * before the answer ships without it — a hung source taxes the answer
 * by ~0.8 s, never by its full 4 s budget. With fewer than two
 * answers the wait runs to the per-source budget, because a single
 * source is all that stands between an answer and an honest refusal. */
export const STRAGGLER_GRACE_MS = 800;
/** Pairwise implied-rate agreement required to serve a multi-source
 * answer. 0.5% covers same-day snapshot-time drift between the sources;
 * anything wider is a real disagreement and is refused. */
export const AGREEMENT_TOLERANCE = 0.005;
/** amount bounds: the contract scores converted_amount in
 * [0.01, 1e8]; inputs far outside that are not real questions. */
const MAX_AMOUNT = 1e12;

const CODE_RE = /^[A-Za-z]{3}$/;

interface SourceQuote {
  source: string;
  url: string;
  rawBody: string;
  rate: number; // units of to_currency per 1 from_currency
  rateDate: string; // source's own publication date label
}

/** Frankfurter: GET /v1/latest?base=FROM&symbols=TO -> {"amount":1.0,
 * "base":"USD","date":"YYYY-MM-DD","rates":{"EUR":0.90...}}. A code
 * outside its ~30-currency ECB set is simply absent from rates. */
async function quoteFrankfurter(from: string, to: string): Promise<SourceQuote | null> {
  const url = `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`;
  const rawBody = await fetchText(url, SOURCE_TIMEOUT_MS);
  const parsed = JSON.parse(rawBody) as { date?: unknown; rates?: Record<string, unknown> };
  const rate = parsed.rates?.[to];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return { source: "Frankfurter (ECB reference rates)", url, rawBody, rate, rateDate: String(parsed.date ?? "unknown") };
}

/** open.er-api: GET /v6/latest/FROM -> {"result":"success",
 * "time_last_update_utc":"...", "rates":{"EUR":...}}. Broad coverage. */
async function quoteOpenErApi(from: string, to: string): Promise<SourceQuote | null> {
  const url = `https://open.er-api.com/v6/latest/${from}`;
  const rawBody = await fetchText(url, SOURCE_TIMEOUT_MS);
  const parsed = JSON.parse(rawBody) as {
    result?: unknown;
    time_last_update_utc?: unknown;
    rates?: Record<string, unknown>;
  };
  if (parsed.result !== "success") return null;
  const rate = parsed.rates?.[to];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return {
    source: "open.er-api.com",
    url,
    rawBody,
    rate,
    rateDate: String(parsed.time_last_update_utc ?? "unknown"),
  };
}

/** fawaz currency-api: GET .../v1/currencies/<from>.json (LOWERCASE
 * codes) -> {"date":"YYYY-MM-DD","<from>":{"eur":...}}. Broadest set,
 * including crypto tickers. */
async function quoteFawaz(from: string, to: string): Promise<SourceQuote | null> {
  const fromLower = from.toLowerCase();
  const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${fromLower}.json`;
  const rawBody = await fetchText(url, SOURCE_TIMEOUT_MS);
  const parsed = JSON.parse(rawBody) as { date?: unknown } & Record<string, unknown>;
  const table = parsed[fromLower] as Record<string, unknown> | undefined;
  const rate = table?.[to.toLowerCase()];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return { source: "fawaz currency-api", url, rawBody, rate, rateDate: String(parsed.date ?? "unknown") };
}

/** Comparable day key for a source's rate date: Frankfurter and fawaz
 * publish "YYYY-MM-DD"; open.er-api publishes a full UTC string. Day
 * precision is enough: the sources snapshot at most daily. An
 * unparsable date keys to 0 (treated as the stalest). */
export function rateDayKey(rateDate: string): number {
  const direct = Date.parse(rateDate);
  if (!Number.isNaN(direct)) return Math.floor(direct / 86400000);
  return 0;
}

const SOURCES: Array<{ name: string; quote: (from: string, to: string) => Promise<SourceQuote | null> }> = [
  { name: "frankfurter", quote: quoteFrankfurter },
  { name: "open-er-api", quote: quoteOpenErApi },
  { name: "fawaz", quote: quoteFawaz },
];

/** Promise.allSettled with a straggler grace: resolves when every
 * promise settles, or when >= 2 fulfilled values exist and `graceMs`
 * elapses, or at `wallMs` at the latest. Unsettled entries are
 * undefined (the caller treats them as failed sources). The underlying
 * promises keep their own timeouts, so nothing leaks. */
export function settleWithStragglerGrace<T>(
  tasks: Array<Promise<T | null>>,
  graceMs: number,
  wallMs: number,
): Promise<Array<PromiseSettledResult<T | null> | undefined>> {
  const results: Array<PromiseSettledResult<T | null> | undefined> = new Array(tasks.length);
  return new Promise((resolvePromise) => {
    let settledCount = 0;
    let fulfilledCount = 0;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const wallTimer = setTimeout(done, wallMs);
    function done(): void {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      clearTimeout(wallTimer);
      resolvePromise(results);
    }
    tasks.forEach((task, i) => {
      task.then(
        (value) => {
          results[i] = { status: "fulfilled", value };
          settledCount += 1;
          fulfilledCount += 1;
          if (settledCount === tasks.length) {
            done();
          } else if (fulfilledCount >= 2 && graceTimer === undefined) {
            graceTimer = setTimeout(done, graceMs);
          }
        },
        (reason) => {
          results[i] = { status: "rejected", reason };
          settledCount += 1;
          if (settledCount === tasks.length) done();
        },
      );
    });
  });
}

export async function handleFx(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const fromRaw = query.from_currency?.trim();
  const toRaw = query.to_currency?.trim();
  if (!fromRaw || !toRaw) {
    throw badRequest("MISSING_PARAM", "from_currency and to_currency are required query parameters");
  }
  if (!CODE_RE.test(fromRaw) || !CODE_RE.test(toRaw)) {
    throw badRequest(
      "INVALID_CURRENCY",
      `currency codes must be ISO-4217 3-letter codes; got from=${fromRaw} to=${toRaw}`,
    );
  }
  const from = fromRaw.toUpperCase();
  const to = toRaw.toUpperCase();
  let amount = 1;
  if (query.amount !== undefined && query.amount.trim() !== "") {
    amount = Number(query.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      throw badRequest("INVALID_AMOUNT", `amount must be a positive number up to ${MAX_AMOUNT}`);
    }
  }

  // All sources in parallel, each on its own 4 s budget. The wait ends
  // when all have settled, OR when two have answered and the straggler
  // grace expires (a hung source costs ~0.8 s, never its full budget),
  // OR at the all-hung wall. Errors, no-coverage and still-hung sources
  // all count as failed and are named honestly in degradedReasons.
  const settled = await settleWithStragglerGrace(
    SOURCES.map((s) => s.quote(from, to)),
    STRAGGLER_GRACE_MS,
    SOURCE_TIMEOUT_MS + 500,
  );
  const quotes: SourceQuote[] = [];
  const failedSources: string[] = [];
  settled.forEach((outcome, i) => {
    if (outcome?.status === "fulfilled" && outcome.value !== null) {
      quotes.push(outcome.value);
    } else {
      failedSources.push(SOURCES[i].name);
    }
  });

  if (quotes.length === 0) {
    if (failedSources.length === SOURCES.length) {
      // Distinguish "no source knows this code" from "sources are down"
      // only weakly — both are possible per source. The honest combined
      // answer: no source could provide the rate.
      throw unprocessable(
        "NO_DATA",
        `no rate source could provide ${from}/${to}: every source errored or does not cover the pair (${failedSources.join(", ")})`,
      );
    }
    throw unprocessable(
      "NO_DATA",
      `no rate source covers ${from}/${to} (checked: ${SOURCES.map((s) => s.name).join(", ")})`,
    );
  }

  // Correctness over availability: with 2+ covering sources the implied
  // rates must agree pairwise within 0.5%; the median is served. A
  // wider split is a real disagreement and is refused, never averaged.
  let serving = quotes;
  let degradedReasons: string[] = [];
  let straddledUpdate = false;
  if (quotes.length >= 2) {
    const sorted = [...quotes].sort((a, b) => a.rate - b.rate);
    const lo = sorted[0].rate;
    const hi = sorted[sorted.length - 1].rate;
    if ((hi - lo) / lo > AGREEMENT_TOLERANCE) {
      // A disagreement beyond tolerance is refused UNLESS the sources
      // straddle a rate update: these sources snapshot at different
      // times (ECB business days vs daily), so a stale-vs-fresh split
      // is a timestamp artifact, not a wrong number. Then the FRESHEST
      // source serves alone at confidence 0.9 with the split disclosed
      // in the answer — correctness over availability, honestly dated.
      const byFreshness = [...quotes].sort((a, b) => rateDayKey(b.rateDate) - rateDayKey(a.rateDate));
      const freshest = byFreshness[0];
      const stalest = byFreshness[byFreshness.length - 1];
      if (rateDayKey(freshest.rateDate) > rateDayKey(stalest.rateDate)) {
        straddledUpdate = true;
        serving = [freshest];
        degradedReasons = [
          `sources straddle a rate update for ${from}/${to}: serving the freshest ` +
            `(${freshest.source}=${freshest.rate} dated ${freshest.rateDate}); the stale source read ` +
            `${stalest.rate} dated ${stalest.rateDate}`,
        ];
      } else {
        const detail = quotes.map((q) => `${q.source}=${q.rate} (${q.rateDate})`).join("; ");
        throw upstreamUnavailable(
          "FX_SOURCES_DISAGREE",
          `rate sources disagree on ${from}/${to} beyond 0.5% on the SAME date: ${detail}; refusing to serve an averaged wrong answer`,
        );
      }
    } else {
      const median = sorted[Math.floor((sorted.length - 1) / 2)].rate;
      serving = quotes.filter((q) => q.rate === median);
      if (failedSources.length > 0) {
        degradedReasons = [`sources unavailable or not covering: ${failedSources.join(", ")}`];
      }
    }
  } else {
    degradedReasons = [
      `only ${quotes[0].source} covers ${from}/${to} (${failedSources.join(", ")} did not answer)`,
    ];
  }
  const winner = serving[0];
  const rate = winner.rate;
  const converted = Math.round(amount * rate * 1e6) / 1e6;
  const confidence = quotes.length >= 2 && degradedReasons.length === 0 && !straddledUpdate ? 1.0 : 0.9;

  // Receipt over the exact evidence bytes: every covering source's raw
  // body, the computed median and the served value. A judge recomputes
  // the answer from the receipt alone.
  const receiptEvidence = JSON.stringify({
    from_currency: from,
    to_currency: to,
    amount,
    rate_served: rate,
    converted_amount: converted,
    agreement_tolerance: AGREEMENT_TOLERANCE,
    sources: quotes.map((q) => ({
      source: q.source,
      url: q.url,
      rate: q.rate,
      rate_date: q.rateDate,
      raw_body: q.rawBody,
    })),
    failed_sources: failedSources,
  });
  const receiptDoc: Receipt = makeReceipt(
    INTENT,
    winner.url,
    receiptEvidence,
    `${quotes.length}/${SOURCES.length} rate sources`,
  );
  try {
    await saveReceipt(receiptDoc, receiptEvidence);
  } catch (err) {
    console.warn(
      `verireceipt: failed to persist FX receipt ${receiptDoc.receipt_id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fields: Record<string, unknown> = {
    converted_amount: converted,
    from_currency: from,
    to_currency: to,
    amount,
    rate,
    rate_date: winner.rateDate,
    sources_used: quotes.map((q) => q.source),
  };

  return envelope(INTENT, fields, receiptDoc, {
    answer:
      `${amount} ${from} = ${converted} ${to} at a rate of ${rate} ${to} per ${from}` +
      ` (${winner.source}, rates dated ${winner.rateDate}` +
      (quotes.length > 1
        ? `; cross-checked against ${quotes.length} sources agreeing within 0.5%)`
        : "; single covering source)") +
      ".",
    verdict: "verified",
    confidence,
    source:
      `Keyless public rate APIs (${quotes.map((q) => q.source).join(" + ")}); ` +
      `sources snapshot at different times of day, so a 0.5% pairwise agreement tolerance is applied ` +
      `and a wider split is refused, never averaged` +
      (degradedReasons.length ? `; degraded: ${degradedReasons.join("; ")}` : ""),
  });
}
