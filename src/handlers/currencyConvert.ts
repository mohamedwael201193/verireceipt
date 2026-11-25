import {withAnswerClass} from "../core/answerClass";
// CURRENCY_EXCHANGE_CONVERT and FX_NOW: deterministic reference-rate answers.
// USD -> EUR/CAD/SEK and FX_NOW share three parallel keyless observations,
// cached for 55 seconds with original acquisition times and a five-minute
// observation-age ceiling. Source publication dates are disclosed separately;
// a recent fetch is never a market-freshness claim. The largest complete-span
// 0.5% agreeing majority supplies its median (even count: midpoint). No majority
// refuses. One valid observation answers at reduced confidence.
// Other currency conversions retain the five-source legacy selection below,
// including the scoped keyed EGP and uncovered-pair fallback. Every accepted
// raw response is retained in receipt evidence. No rate is invented.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, type Receipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import {observeRatePanel,selectObservedRates,FX_MAX_OBSERVATION_AGE_MS} from './fxObservations';
type FxFailure = { reason: "timeout" | "http_status" | "transport_error"; status?: number };
const fetchFailures = new WeakMap<object, FxFailure>();
const FX_LOG_SOURCES = new Set(["frankfurter", "open-er-api", "fawaz", "vatcomply", "floatrates", "exchangerate-api"]);
function warnFxSource(source: string, from: string, to: string, reason: string, status?: number): void {
  console.warn(JSON.stringify({ event: "fx_source_failure", source: FX_LOG_SOURCES.has(source) ? source : "unknown",
    from: /^[A-Z]{3}$/.test(from) ? from : "-", to: /^[A-Z]{3}$/.test(to) ? to : "-", reason, ...(status === undefined ? {} : { status }) }));
}
async function observeFxSource(source: string, from: string, to: string, read: () => Promise<SourceQuote | null>): Promise<SourceQuote | null> {
  try {
    const quote = await read();
    if (quote === null) warnFxSource(source, from, to, "no_usable_quote");
    return quote;
  } catch (error) {
    const detail = error && typeof error === "object" ? fetchFailures.get(error) : undefined;
    warnFxSource(source, from, to, detail?.reason ?? (error instanceof SyntaxError ? "parse_error" : "source_error"), detail?.status);
    throw error; // Preserve the original rejection and selection behavior. No URL/body/error text logged.
  }
}
/** Local fetch with a hard per-call timeout. The URLs are built from
 * validated 3-letter ISO codes on three fixed public hosts, so there is
 * no SSRF surface (the grid ingester's fetchText is allowlist-bound to
 * grid hosts and cannot be reused here). */
async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status} from ${url}`);
      fetchFailures.set(error, { reason: "http_status", status: res.status });
      throw error;
    }
    return await res.text();
  } catch (error) {
    if (error && typeof error === "object" && !fetchFailures.has(error)) {
      fetchFailures.set(error, { reason: controller.signal.aborted ? "timeout" : "transport_error" });
    }
    throw error;
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
  const parsed = JSON.parse(rawBody) as { amount?: unknown; base?: unknown; date?: unknown; rates?: Record<string, unknown> };
  if (parsed.base !== from) throw new Error("FX base identity mismatch");
  if (parsed.amount !== 1) throw new Error("FX quote amount must be one base unit");
  const rate = parsed.rates?.[to];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  validateFxCalendarLabel(parsed.date);
  return { source: "Frankfurter (ECB reference rates)", url, rawBody, rate, rateDate: String(parsed.date ?? "unknown") };
}

/** open.er-api: GET /v6/latest/FROM -> {"result":"success",
 * "time_last_update_utc":"...", "rates":{"EUR":...}}. Broad coverage. */
async function quoteOpenErApi(from: string, to: string): Promise<SourceQuote | null> {
  const url = `https://open.er-api.com/v6/latest/${from}`;
  const rawBody = await fetchText(url, SOURCE_TIMEOUT_MS);
  const parsed = JSON.parse(rawBody) as {
    result?: unknown;
    base_code?: unknown;
    time_last_update_utc?: unknown;
    rates?: Record<string, unknown>;
  };
  if (parsed.result !== "success") return null;
  if (parsed.base_code !== from) throw new Error("FX base identity mismatch");
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

/** vatcomply: GET /rates?base=FROM -> {"date":"YYYY-MM-DD","rates":{"EUR":...}}.
 * ECB-anchored daily fix, ~30 fiat codes; absent code = no coverage. */
async function quoteVatcomply(from: string, to: string): Promise<SourceQuote | null> {
  const url = `https://api.vatcomply.com/rates?base=${from}`;
  const rawBody = await fetchText(url, SOURCE_TIMEOUT_MS);
  const parsed = JSON.parse(rawBody) as { base?: unknown; date?: unknown; rates?: Record<string, unknown> };
  if (parsed.base !== from) throw new Error("FX base identity mismatch");
  const rate = parsed.rates?.[to];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  validateFxCalendarLabel(parsed.date);
  return { source: "vatcomply", url, rawBody, rate, rateDate: String(parsed.date ?? "unknown") };
}

/** floatrates: GET /daily/<from-lower>.json -> {"eur":{"rate":"0.90...","date":"..."}}.
 * Rates are decimal STRINGS; each currency carries its own date label. */
async function quoteFloatrates(from: string, to: string): Promise<SourceQuote | null> {
  const url = `https://www.floatrates.com/daily/${from.toLowerCase()}.json`;
  const rawBody = await fetchText(url, SOURCE_TIMEOUT_MS);
  const parsed = JSON.parse(rawBody) as Record<string, { code?: unknown; alphaCode?: unknown; rate?: unknown; date?: unknown } | undefined>;
  const entry = parsed[to.toLowerCase()];
  if (entry === undefined) return null;
  if (entry?.code !== to || (entry.alphaCode !== undefined && entry.alphaCode !== to)) throw new Error("FX target identity mismatch");
  const rate = typeof entry?.rate === "string" ? Number(entry.rate) : NaN;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return { source: "floatrates", url, rawBody, rate, rateDate: String(entry?.date ?? "unknown") };
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
  validateFxCalendarLabel(parsed.date);
  return { source: "fawaz currency-api", url, rawBody, rate, rateDate: String(parsed.date ?? "unknown") };
}

/** Reject impossible calendar labels before Date.parse can normalize a rollover.
 * Unknown labels remain day0 under the existing policy; no age/future bound. */
export function validateFxCalendarLabel(label:unknown):void {
 if(typeof label!=='string')return;
 const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(label);if(!m)return;
 const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
 const d=new Date(0);d.setUTCHours(0,0,0,0);d.setUTCFullYear(year,month-1,day);
 if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)throw new Error('impossible FX publication calendar date');
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

/** Five keyless sources: three official-fix snapshots (frankfurter,
 * vatcomply, floatrates — all anchored to the ECB-style daily fix) and
 * two continuously recomputed daily snapshots (open.er-api, fawaz).
 * The served value is still the MEDIAN of whatever subset covers the
 * pair. Why five: the network's own reference for this intent is the
 * median of up to three keyless truth sources drawn per question, and
 * the public source population is fix-heavy; a five-source median is a
 * stabler estimate of that reference than a three-source one, while a
 * stale or recomputed outlier can never move the middle value. Coverage
 * doctrine is unchanged: er-api and fawaz still carry the long tail of
 * non-ECB codes the three fix sources do not have. A KEYED sixth leg
 * (ExchangeRate-API v6, environment-configured testnet source, 2026-11-23)
 * exists outside this list and joins only in two narrow roles: the EGP
 * panel, and the NO_DATA coverage fallback. Major-pair medians and the
 * fix-dated outvote are untouched by it (see quoteExchangeRateApi). */
const SOURCES: Array<{ name: string; quote: (from: string, to: string) => Promise<SourceQuote | null> }> = [
  { name: "frankfurter", quote: quoteFrankfurter },
  { name: "open-er-api", quote: quoteOpenErApi },
  { name: "fawaz", quote: quoteFawaz },
  { name: "vatcomply", quote: quoteVatcomply },
  { name: "floatrates", quote: quoteFloatrates },
];

/** ExchangeRate-API v6 (the KEYED sixth leg, 2026-11-23, environment-configured
 * testnet source): GET /v6/<key>/latest/FROM, the same response shape as
 * its keyless mirror open.er-api. The key exists ONLY in the fetch path
 * (their sole auth mechanism is the URL path segment); the recorded
 * evidence URL redacts it, and leg errors never carry the URL beyond the
 * discarded error object. Participation is deliberately narrow so the
 * five-source fix-weighted median for major pairs is untouched: the leg
 * joins the initial parallel panel ONLY for pairs involving EGP (its
 * named role: the keyless panel serves EGP from two recomputed sources
 * only), and otherwise fires ALONE in the NO_DATA path, where it may
 * cover a long-tail pair the keyless five lack. With no key configured
 * the leg is absent entirely. */
export async function quoteExchangeRateApi(from: string, to: string, key: string): Promise<SourceQuote | null> {
  const url = `https://v6.exchangerate-api.com/v6/${key}/latest/${from}`;
  let rawBody: string;
  try {
    rawBody = await fetchText(url, SOURCE_TIMEOUT_MS);
  } catch (original) {
    // fetchText errors embed the full URL — including the key path
    // segment. The leg's errors must be key-free in every
    // materialization, so the original error is discarded here.
    const safe = new Error("exchangerate-api leg fetch failed");
    if (original && typeof original === "object") {
      const detail = fetchFailures.get(original);
      if (detail) fetchFailures.set(safe, detail);
    }
    throw safe;
  }
  const parsed = JSON.parse(rawBody) as {
    result?: unknown;
    base_code?: unknown;
    time_last_update_utc?: unknown;
    rates?: Record<string, unknown>;
  };
  if (parsed.result !== "success") return null;
  if (parsed.base_code !== from) throw new Error("FX base identity mismatch");
  const rate = parsed.rates?.[to];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return {
    source: "exchangerate-api v6",
    url: `https://v6.exchangerate-api.com/v6/<redacted-key>/latest/${from}`,
    rawBody,
    rate,
    rateDate: String(parsed.time_last_update_utc ?? "unknown"),
  };
}

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
  const results: Array<PromiseSettledResult<T | null> | undefined> = Array.from({ length: tasks.length }, () => undefined);
  return new Promise((resolvePromise) => {
    let finished = false;
    let settledCount = 0;
    let fulfilledCount = 0;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const wallTimer = setTimeout(done, wallMs);
    function done(): void {
      if (finished) return;
      finished = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      clearTimeout(wallTimer);
      resolvePromise(results.slice());
    }
    tasks.forEach((task, i) => {
      task.then(
        (value) => {
          if (finished) return;
          results[i] = { status: "fulfilled", value };
          settledCount += 1;
          if (value !== null) fulfilledCount += 1;
          if (settledCount === tasks.length) {
            done();
          } else if (fulfilledCount >= 2 && graceTimer === undefined) {
            graceTimer = setTimeout(done, graceMs);
          }
        },
        (reason) => {
          if (finished) return;
          results[i] = { status: "rejected", reason };
          settledCount += 1;
          if (settledCount === tasks.length) done();
        },
      );
    });
  });
}

/**
 * One structured, injection-safe log line per /v1/fx request
 * (2026-11-23, epoch-41 postmortem): a scoring pass must be
 * reconstructable from Render logs. Only the currency codes and the
 * amount are echoed, each whitelisted - anything else (including
 * newline-bearing or oversized caller input) logs as "-". No caller
 * identity is logged (no PII). `ms` is the route-level wall time.
 */
export function fxLogLine(
  query: Record<string, string | undefined>,
  outcome: { ok: true } | { ok: false; status: number; code: string },
  startedMs: number,
  endedMs: number,
): string {
  const code = (v: string | undefined): string =>
    v !== undefined && /^[A-Za-z]{2,8}$/.test(v) ? v.toUpperCase() : "-";
  const amount = (v: string | undefined): string =>
    v !== undefined && /^[0-9]{1,15}(\.[0-9]{1,8})?$/.test(v) ? v : "-";
  const result = outcome.ok ? "ok" : `error ${outcome.status} ${outcome.code}`;
  return `verireceipt: fx_request at=${new Date(startedMs).toISOString()} from=${code(query.from_currency)} to=${code(query.to_currency)} amount=${amount(query.amount)} result=${result} ms=${Math.max(0, endedMs - startedMs)}`;
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

  if(from==='USD'&&FX_NOW_CURRENCIES.has(to))return observedFxAnswer(from,to,amount,INTENT);
  // All sources in parallel, each on its own 4 s budget. The wait ends
  // when all have settled, OR when two have answered and the straggler
  // grace expires (a hung source costs ~0.8 s, never its full budget),
  // OR at the all-hung wall. Errors, no-coverage and still-hung sources
  // all count as failed and are named honestly in degradedReasons.
  // The keyed sixth leg joins the panel only in its named EGP role;
  // every other pair sees the exact five-source panel. With no key it
  // is absent entirely (EXCHANGE_RATE_API_KEY, trimmed; blank = absent).
  const exchangeKey = (process.env.EXCHANGE_RATE_API_KEY ?? "").trim();
  const egpPair = from === "EGP" || to === "EGP";
  const legs = [...SOURCES];
  if (exchangeKey && egpPair) {
    legs.push({ name: "exchangerate-api", quote: (f, t) => quoteExchangeRateApi(f, t, exchangeKey) });
  }
  const settled = await settleWithStragglerGrace(
    legs.map((s) => observeFxSource(s.name, from, to, () => s.quote(from, to))),
    STRAGGLER_GRACE_MS,
    SOURCE_TIMEOUT_MS + 500,
  );
  const quotes: SourceQuote[] = [];
  const failedSources: string[] = [];
  const erroredSources: string[] = [];
  const uncoveredSources: string[] = [];
  settled.forEach((outcome, i) => {
    if (outcome === undefined) warnFxSource(legs[i].name, from, to, "pending_at_selection");
    if (outcome?.status === "fulfilled" && outcome.value !== null) {
      quotes.push(outcome.value);
    } else {
      failedSources.push(legs[i].name);
      if (outcome?.status === "fulfilled") {
        uncoveredSources.push(legs[i].name); // answered, but no rate for this pair
      } else {
        erroredSources.push(legs[i].name); // down, timed out, or bad response
      }
    }
  });

  // Coverage fallback: the keyless panel answered without this pair, so
  // the keyed leg gets its one other shot — it may cover a long-tail
  // pair the five lack. Same per-source budget, same honesty labels.
  let fallbackFired = false;
  if (quotes.length === 0 && uncoveredSources.length > 0 && exchangeKey && !egpPair) {
    fallbackFired = true;
    try {
      const q = await observeFxSource("exchangerate-api", from, to, () => quoteExchangeRateApi(from, to, exchangeKey));
      if (q !== null) {
        quotes.push(q);
      } else {
        failedSources.push("exchangerate-api");
        uncoveredSources.push("exchangerate-api");
      }
    } catch {
      failedSources.push("exchangerate-api");
      erroredSources.push("exchangerate-api");
    }
  }

  if (quotes.length === 0) {
    if (uncoveredSources.length === 0) {
      // Every source errored and none answered at all: an upstream
      // failure, not an unknown pair — 502, matching every other
      // intent's all-sources-down shape.
      throw upstreamUnavailable(
        "FX_SOURCES_DOWN",
        `every rate source errored for ${from}/${to} (${erroredSources.join(", ")}); refusing to invent a rate`,
      );
    }
    // At least one source answered and carried no such pair: the
    // well-formed code is simply not covered. 422 NO_DATA, with any
    // errored sources named honestly.
    throw unprocessable(
      "NO_DATA",
      `no rate source covers ${from}/${to} (answered without it: ${uncoveredSources.join(", ")}` +
        (erroredSources.length ? `; errored: ${erroredSources.join(", ")}` : "") + `)`,
    );
  }

  // Correctness over availability: with 2+ covering sources the implied
  // rates must agree pairwise within 0.5%; the median is served. A
  // wider split needs a selected agreeing cluster, never a cross-cluster average.
  let serving = quotes;
  let degradedReasons: string[] = [];
  let straddledUpdate = false;
  let straddleDetail = "";
  // Set when a tight anchor cluster (not the full pool) chose the served
  // rate: names the anchor sources and every excluded quote with its
  // distance. Printed in the answer; never silently pooled.
  let clusterDetail = "";
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
        straddleDetail =
          `sources straddled a rate update: ${freshest.source} read ${freshest.rate} dated ` +
          `${freshest.rateDate}, ${stalest.source} read ${stalest.rate} dated ${stalest.rateDate}`;
        degradedReasons = [
          `sources straddle a rate update for ${from}/${to}: serving the freshest ` +
            `(${freshest.source}=${freshest.rate} dated ${freshest.rateDate}); the stale source read ` +
            `${stalest.rate} dated ${stalest.rateDate}`,
        ];
      } else {
        const selected = selectForPair(sorted, from, to);
        const anchor = selected.anchor;
        // The helper can fall back to the full pool on tied/no clusters.
        // That fallback must never rescue a genuinely disagreeing pool.
        if (anchor.length < 2 || anchor.length === sorted.length ||
            (anchor[anchor.length - 1].rate - anchor[0].rate) / anchor[0].rate > AGREEMENT_TOLERANCE) {
          const detail = quotes.map((q) => `${q.source}=${q.rate} (${q.rateDate})`).join("; ");
          throw upstreamUnavailable("FX_SOURCES_DISAGREE",
            `rate sources disagree on ${from}/${to} beyond 0.5% on the SAME date with no selected agreeing pair: ${detail}`);
        }
        serving = selected.serving;
        clusterDetail = selected.clusterDetail;
        degradedReasons = [
          `same-date pool exceeds 0.5%; ${clusterDetail}; different intraday snapshots may straddle the ECB publication; publication timing is not independently verified`,
          ...(failedSources.length ? [`sources unavailable or not covering: ${failedSources.join(", ")}`] : []),
        ];
      }
    } else {
      const selected = selectForPair(sorted, from, to);
      serving = selected.serving;
      clusterDetail = selected.clusterDetail;
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
  const rate = clusterDetail.startsWith("largest complete-span") ? serving.reduce((sum, q) => sum + q.rate, 0) / serving.length : winner.rate;
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
    ...(clusterDetail.startsWith("largest complete-span") ? { independent_window_selection: clusterDetail, median_inputs: serving.map(q => ({source:q.source, rate:q.rate})) } : {}),
    ...(degradedReasons.some(reason => reason.startsWith("same-date pool")) ? {
      selection_policy: clusterDetail.startsWith("largest complete-span") ? (serving.length === 2 ? "same-date independent-origin complete-span window median, even midpoint" : "same-date independent-origin complete-span window median, odd observed middle") : "same-date wide pool: selected agreeing anchor cluster, lower observed median",
      cluster_detail: clusterDetail,
      degraded_reasons: degradedReasons,
    } : {}),
  });
  const receiptDoc: Receipt = makeReceipt(
    INTENT,
    clusterDetail.startsWith("largest complete-span") ? serving.map(q=>q.url).join(" + ") : winner.url,
    receiptEvidence,
    `${quotes.length}/${legs.length + (fallbackFired ? 1 : 0)} rate sources${degradedReasons.some(reason => reason.startsWith("same-date pool")) ? "; full pool disagreed; selected anchor cluster; exclusions disclosed" : ""}`,
  );
  try {
    await saveReceipt(receiptDoc, receiptEvidence);
  } catch {
    // A source observation is not a receipted answer until its evidence is stored.
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
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

  return withAnswerClass(envelope(INTENT, fields, receiptDoc, {
    answer:
      `${amount} ${from} = ${converted} ${to} at a rate of ${rate} ${to} per ${from}` +
      ` (${clusterDetail.startsWith("largest complete-span") ? serving.map(q => q.source).join(" + ") : winner.source}${clusterDetail.startsWith("largest complete-span") && serving.length > 1 && serving[0].rate !== serving[1].rate ? "; median midpoint, not a single-source quote" : ""}, rates dated ${winner.rateDate}` +
      (straddledUpdate
        ? `; ${straddleDetail} — the freshest is served; they did NOT agree within 0.5%)`
        : quotes.length > 1
          ? (degradedReasons.some(reason => reason.startsWith("same-date pool"))
              ? `; full source pool did NOT agree within 0.5%; serving the selected agreeing cluster`
              : clusterDetail.startsWith("largest complete-span") ? `; selected independent-origin window agrees within 0.5%` : `; cross-checked against ${quotes.length} sources agreeing within 0.5%`) +
            (clusterDetail ? `; ${clusterDetail}` : "") +
            ")"
          : "; single covering source)") +
      ".",
    verdict: "verified",
    confidence,
    source:
      `Keyless public rate APIs (${quotes.map((q) => q.source).join(" + ")}); ` +
      `sources snapshot at different times of day, so a 0.5% pairwise agreement tolerance is applied ` +
      `and a wider same-date split requires a selected agreeing cluster of at least two quotes; otherwise refused, never averaged across clusters` +
      (clusterDetail
        ? clusterDetail.startsWith("largest complete-span") ? `; ${clusterDetail}` : `; the served rate is the median of the tightest single-linkage agreeing cluster (5bps), not the full pool`
        : "") +
      (degradedReasons.length ? `; degraded: ${degradedReasons.join("; ")}` : ""),
  }),INTENT,{currency:to,from_currency:from,source_set:quotes.map(q=>q.source),serving_rule:straddledUpdate||quotes.length===1?"freshest_alone":degradedReasons.some(reason=>reason.startsWith("same-date pool"))?"anchor_cluster":"full_median"});
}

// FX_NOW_{EUR,CAD,SEK} — GET /v1/fx-now?currency=EUR
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/FX_NOW_EUR,
// read 2026-11-22; FX_NOW_CAD and FX_NOW_SEK are the same contract with
// their own question key): request currency (string, e.g. EUR); scored
// response rate = how many {currency} one US dollar buys, range
// [0.0001, 100000]. These are the only three FX_NOW_* contracts in the
// catalogue, so the panel is pinned to exactly those three codes; any
// other well-formed code fails closed with 422 NO_DATA.
//
// Doctrine is identical to handleFx: the same five keyless sources fire
// in parallel, pairwise agreement within 0.5% with the median served —
// the observed median described at the top of this file. Publication-date
// differences never let a lone newest quote bypass the majority guard.
// The keyed adapter is not part of this panel. Direction: USD -> currency.
const FX_NOW_CURRENCIES = new Set(["EUR", "CAD", "SEK"]);
const FX_NOW_RATE_MIN = 0.0001;
const FX_NOW_RATE_MAX = 100000;


/** Legacy anchor-cluster selection for conversions outside USD/EUR,CAD,SEK. Input is the pool sorted by rate;
 * returns the serving quote(s) and, when a tight cluster (not the full
 * pool) chose the rate, a disclosure naming the anchor sources and
 * every excluded quote with its distance in bps. */
export function selectAnchorServing(sorted: SourceQuote[]): { serving: SourceQuote[]; clusterDetail: string; anchor: SourceQuote[] } {
  // Anchor cluster (2026-11-23, measured live): the network's
  // reference median lands on the ECB daily fix — every top-ranked
  // miner serves exactly it. When the pool splits into a tight fix
  // cluster and drifted recomputed quotes (weekend: 15-25bps apart),
  // the full-pool median lands BETWEEN them (~9bps off the fix,
  // measured). Serve the median of the largest tight cluster, where
  // "tight" is SINGLE-LINKAGE: two quotes merge when they differ by
  // at most 5bps, so a cluster's members can span more than 5bps
  // end to end through a chain. When the largest size is tied, the
  // fix-dated cluster anchors — a conscious choice: the reference is
  // documented and measured fix-heavy, so the cluster whose newest
  // quote is OLDEST is the fix snapshot. Identical dates or no tight
  // pair fall back to the full-pool median (previous rule). On
  // weekdays all sources sit within a few bps, so a single cluster
  // forms and the full-pool median serves exactly as before; the
  // rule only bites when the pool has an internal gap over 5bps.
  const TIGHT_REL = 0.0005; // 5bps
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if ((sorted[j].rate - sorted[i].rate) / sorted[i].rate <= TIGHT_REL) {
        parent[find(j)] = find(i);
      }
    }
  }
  const clusters = new Map<number, typeof sorted>();
  for (let i = 0; i < sorted.length; i++) {
    const root = find(i);
    const group = clusters.get(root) ?? [];
    group.push(sorted[i]);
    clusters.set(root, group);
  }
  const groups = [...clusters.values()].sort((a, b) => b.length - a.length);
  // Fix-cluster preference (2026-11-23, epoch-41 postmortem, merged from
  // main): the network's reference is the ECB daily fix and a recomputed
  // cluster can outnumber the fix pair on a weekend, so raw size alone
  // can anchor on the drifted side. Among tight clusters of at least 2,
  // the cluster with the most ECB-fix republications (frankfurter,
  // vatcomply) anchors first, then size, then the oldest-newest
  // tie-break. When NO cluster carries a fix republication (both down
  // or not covering), the rule reduces to the previous largest-cluster
  // rule. Exact source-name strings as set by the source adapters; a
  // renamed adapter must update this set or the preference silently
  // stops applying.
  const FIX_REPUBLISHERS = new Set(["Frankfurter (ECB reference rates)", "vatcomply"]);
  const fixCount = (g: typeof sorted): number =>
    g.filter((q) => FIX_REPUBLISHERS.has(q.source)).length;
  const candidates = groups.filter((g) => g.length >= 2);
  let anchor: typeof sorted | undefined;
  if (candidates.length > 0) {
    const maxFix = Math.max(...candidates.map(fixCount));
    const fixBest = candidates.filter((g) => fixCount(g) === maxFix);
    if (fixBest.length === 1) {
      anchor = fixBest[0];
    } else {
      // Tied fix counts: the larger cluster anchors. Tied sizes
      // (weekend shape: a fix pair and a recomputed pair): the
      // reference is fix-heavy, so the cluster whose newest quote is
      // OLDEST — the fix snapshot — anchors. Identical dates
      // fall back to the full-pool median.
      const maxLen = Math.max(...fixBest.map((g) => g.length));
      const tied = fixBest.filter((g) => g.length === maxLen);
      if (tied.length === 1) {
        anchor = tied[0];
      } else {
        const newestKey = (g: typeof sorted): number =>
          Math.max(...g.map((q) => rateDayKey(q.rateDate)));
        const keys = tied.map(newestKey);
        const oldest = Math.min(...keys);
        anchor = keys.filter((k) => k === oldest).length === 1
          ? tied[keys.indexOf(oldest)]
          : undefined;
      }
    }
  }
  anchor ??= sorted;
  const median = anchor[Math.floor((anchor.length - 1) / 2)].rate;
  // Exact-median ties: when two sources quote the identical median rate,
  // the NAMED winner is whichever sorts first by rate order — the served
  // rate is identical either way (review nuance 2026-11-23).
  const serving = sorted.filter((q) => q.rate === median);
  let clusterDetail = "";
  if (anchor !== sorted) {
    const anchorRates = new Set(anchor.map((q) => q.rate));
    const excluded = sorted
      .filter((q) => !anchorRates.has(q.rate))
      .map((q) => {
        const bps = Math.round(((q.rate - median) / median) * 10000);
        return `${q.source}=${q.rate} (${bps >= 0 ? "+" : ""}${bps}bps)`;
      });
    clusterDetail =
      `anchored on the tightest agreeing cluster ${anchor.map((q) => `${q.source}=${q.rate}`).join(", ")}` +
      (excluded.length ? `; excluded ${excluded.join(", ")}` : "");
  }
  return { serving, clusterDetail, anchor };
}

/** Reviewed USD->EUR/CAD policy: complete-span windows, one vote per known origin.
 * Other pairs retain the existing selection, including SEK and USD identity pairs.
 * Named providers are not proof of wholly independent upstream price discovery.
 */
export function selectIndependentWindow(sorted: SourceQuote[]): { serving: SourceQuote[]; clusterDetail: string; anchor: SourceQuote[] } {
  const origin = (q: SourceQuote): string =>
    ["Frankfurter (ECB reference rates)", "vatcomply"].includes(q.source) ? "ECB" :
    ["open.er-api.com", "exchangerate-api v6"].includes(q.source) ? "ExchangeRate-API" : q.source;
  // Stable representative: Frankfurter before vatcomply, public before keyed mirror.
  const priority = (q: SourceQuote): number => q.source === "Frankfurter (ECB reference rates)" || q.source === "open.er-api.com" ? 0 : 1;
  const representatives = new Map<string, SourceQuote>();
  for (const q of sorted) {
    const old = representatives.get(origin(q));
    if (!old || priority(q) < priority(old)) representatives.set(origin(q), q);
  }
  const independent = [...representatives.values()].sort((a,b) => a.rate-b.rate || a.source.localeCompare(b.source));
  const windows: SourceQuote[][] = [];
  for (let i=0;i<independent.length;i++) {
    for (let j=i+1;j<independent.length;j++) {
      if ((independent[j].rate-independent[i].rate)/independent[i].rate <= AGREEMENT_TOLERANCE) windows.push(independent.slice(i,j+1));
    }
  }
  const span = (g: SourceQuote[]) => (g[g.length-1].rate-g[0].rate)/g[0].rate;
  windows.sort((a,b) => b.length-a.length || span(a)-span(b) || a[0].rate-b[0].rate);
  const anchor = windows[0];
  if (!anchor) throw upstreamUnavailable("FX_SOURCES_DISAGREE", "no agreeing window with at least two independent source origins");
  const n=anchor.length;
  const serving = n%2 ? [anchor[Math.floor(n/2)]] : [anchor[n/2-1],anchor[n/2]];
  const median = serving.reduce((sum,q) => sum+q.rate,0)/serving.length;
  const gap = (q: SourceQuote) => { const bps = (q.rate-median)/median*10000; return `${bps>=0?"+":""}${bps.toFixed(2)}bps`; };
  const all = sorted.map(q => `${q.source}=${q.rate} (${gap(q)})`).join(", ");
  const ecb = sorted.filter(q => origin(q)==="ECB");
  const tied = windows.filter(g => g.length===n).length>1;
  const clusterDetail = `largest complete-span<=0.5% agreeing window of ${n} distinct known source origins: ${anchor.map(q=>`${q.source}=${q.rate}`).join(", ")}; ` +
    `median=${median}${serving.length===2 ? "; even count: arithmetic mean of the two middle observed rates" : "; odd count: middle observed rate"}; ` +
    `known duplicate origins counted once (ECB and ExchangeRate-API); provider upstream independence is not established; ` +
    (tied ? "equal-support windows resolved by smallest full relative span, then lower start; " : "") +
    `all fetched quotes and signed gaps to served median: ${all}; ECB fix reference: ${ecb.length?ecb.map(q=>`${q.source}=${q.rate} (${gap(q)})`).join(", "):"unavailable"}; ` +
    `excluded from window: ${sorted.filter(q=>!anchor.includes(q)).map(q=>`${q.source}=${q.rate}`).join(", ") || "none"}`;
  return { serving, anchor, clusterDetail };
}
function selectForPair(sorted: SourceQuote[], from: string, to: string) {
  if (from === "USD" && (to === "EUR" || to === "CAD") && sorted.every(q=>rateDayKey(q.rateDate)===rateDayKey(sorted[0].rateDate)) && rateDayKey(sorted[0].rateDate)>0) return selectIndependentWindow(sorted);
  return selectAnchorServing(sorted);
}

export async function handleFxNow(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const raw = query.currency?.trim();
  if (!raw) {
    throw badRequest("MISSING_PARAM", "currency is a required query parameter");
  }
  if (!CODE_RE.test(raw)) {
    throw badRequest("INVALID_CURRENCY", `currency must be an ISO-4217 3-letter code; got ${raw}`);
  }
  const currency = raw.toUpperCase();
  if (!FX_NOW_CURRENCIES.has(currency)) {
    throw unprocessable(
      "NO_DATA",
      `FX_NOW serves only the reviewed contract currencies EUR, CAD and SEK; ${currency} has no FX_NOW contract`,
    );
  }
  const intent = `FX_NOW_${currency}`;

  return observedFxAnswer('USD',currency,1,intent);
}

async function observedFxAnswer(from:string,to:string,amount:number,intent:string):Promise<Record<string,unknown>>{
 const sources=SOURCES.slice(0,3).map(s=>({...s,quote:(f:string,t:string)=>observeFxSource(s.name,f,t,()=>s.quote(f,t))}));
 const panel=await observeRatePanel(from,to,sources);
 if(!panel.quotes.length){if(panel.uncovered.length)throw unprocessable('NO_DATA','keyless sources answered without this currency pair');throw upstreamUnavailable('FX_SOURCES_DOWN','no usable keyless rate observation; no rate guessed');}
 if(panel.quotes.some(q=>{const age=Date.now()-Date.parse(q.observedAt);return !Number.isFinite(age)||age<0||age>FX_MAX_OBSERVATION_AGE_MS;}))throw upstreamUnavailable('FX_OBSERVATION_STALE','rate observation exceeds 5 minutes; no stale value served');
 let selected;try{selected=selectObservedRates(panel.quotes);}catch{throw upstreamUnavailable('FX_SOURCES_DISAGREE','keyless rate panel lacks an agreeing majority within 0.5%; no blended rate served');}
 const {rate,serving,excluded}=selected;
 if(!Number.isFinite(rate)||rate<=0||(intent!==INTENT&&(rate<FX_NOW_RATE_MIN||rate>FX_NOW_RATE_MAX)))throw upstreamUnavailable('FX_RATE_OUT_OF_RANGE','observed median outside contract bounds');
 const dates=serving.map(q=>({source:q.source,rate_date:q.rateDate})),converted=Math.round(amount*rate*1e6)/1e6;
 const observedAt=serving.map(q=>q.observedAt).sort()[0];
 const evidence=JSON.stringify({from_currency:from,to_currency:to,amount,rate_served:rate,selection_policy:'median of up to 3 keyless observations; drop outliers only with agreeing majority within 0.5 percent; no majority refuses',observation_cache_ms:55000,max_observation_age_ms:300000,observed_at:observedAt,sources:panel.quotes.map(q=>({source:q.source,url:q.url,raw_body:q.rawBody,rate:q.rate,rate_date:q.rateDate,observed_at:q.observedAt})),serving_sources:serving.map(q=>q.source),excluded_sources:excluded.map(q=>q.source),failed_sources:panel.failed,publication_dates:dates,market_freshness:'source publication dates retained; recently fetched does not imply current market pricing'});
 const receipt=makeReceipt(intent,serving.map(q=>q.url).join(' + '),evidence,'keyless reference-rate median with publication dates');receipt.fetched_at=observedAt;
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 const degraded=serving.length<3||excluded.length>0||panel.failed.length>0;
 const fields:Record<string,unknown>={rate,rate_date:dates.map(d=>d.rate_date).join('; '),rate_dates:dates,observed_at:observedAt,sources_used:serving.map(q=>q.source)};
 if(intent===INTENT)Object.assign(fields,{converted_amount:converted,from_currency:from,to_currency:to,amount});else fields.currency=to;
 return withAnswerClass(envelope(intent,fields,receipt,{answer:`${amount} ${from} = ${converted} ${to}; mid-market reference-rate median ${rate}, from ${serving.length} of 3 keyless observations. Observed ${observedAt}. Upstream rate dates: ${dates.map(d=>d.rate_date).join('; ')}. Sources publish reference snapshots; this is not a five-minute market-freshness claim.`+(excluded.length?` Dropped ${excluded.length} outlier outside the agreeing 0.5 percent majority.`:'')+(panel.failed.length?` ${panel.failed.length} source unavailable or without coverage.`:''),verdict:'verified',confidence:degraded?0.9:1,source:serving.map(q=>q.source+' '+q.url).join(' + ')+(degraded?' (degraded reference panel)':'')}),intent,{currency:to,from_currency:from,source_set:serving.map(q=>q.source),serving_rule:serving.length===1?'freshest_alone':'full_median'});
}
