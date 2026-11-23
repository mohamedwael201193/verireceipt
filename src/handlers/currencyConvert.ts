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
//      ~30 currencies, published daily on ECB business days.
//   2. open.er-api.com — broad ISO coverage (used in-house by the grid
//      ingester since 2026-11-20), recomputed daily.
//   3. fawaz currency-api (cdn.jsdelivr.net/npm/@fawazahmed0/currency-api)
//      — broadest coverage including crypto codes, recomputed daily.
//   4. vatcomply (api.vatcomply.com) — ECB-anchored daily fix, ~30 fiat
//      codes.
//   5. floatrates (www.floatrates.com) — daily fix snapshots with a
//      per-currency date label, fiat codes.
// The three fix-anchored sources and the two recomputed ones snapshot
// at different times; the served rate is the median of whichever subset
// covers the pair (see SOURCES below for why the panel is five).
//
// FAILOVER DOCTRINE (owner requirement 2026-11-22): all five fire in
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
// NO_DATA for a well-formed but uncovered code (at least one source
// answered and carried no such pair); malformed codes are 400. ALL
// sources erroring with none answering at all is 502 FX_SOURCES_DOWN.
// No rate is ever invented.
//
// LIMITATION (named honestly): the straddle rule trusts each source's
// OWN date label. A source that serves a stale rate under a fresh
// date label would look "freshest" and win the straddle path alone at
// 0.9; the same-date disagreement refusal (0.5%) is the guard against
// two same-dated sources disagreeing, and same-day drift inside the
// tolerance is the reason the tolerance exists.
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

/** vatcomply: GET /rates?base=FROM -> {"date":"YYYY-MM-DD","rates":{"EUR":...}}.
 * ECB-anchored daily fix, ~30 fiat codes; absent code = no coverage. */
async function quoteVatcomply(from: string, to: string): Promise<SourceQuote | null> {
  const url = `https://api.vatcomply.com/rates?base=${from}`;
  const rawBody = await fetchText(url, SOURCE_TIMEOUT_MS);
  const parsed = JSON.parse(rawBody) as { date?: unknown; rates?: Record<string, unknown> };
  const rate = parsed.rates?.[to];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return { source: "vatcomply", url, rawBody, rate, rateDate: String(parsed.date ?? "unknown") };
}

/** floatrates: GET /daily/<from-lower>.json -> {"eur":{"rate":"0.90...","date":"..."}}.
 * Rates are decimal STRINGS; each currency carries its own date label. */
async function quoteFloatrates(from: string, to: string): Promise<SourceQuote | null> {
  const url = `https://www.floatrates.com/daily/${from.toLowerCase()}.json`;
  const rawBody = await fetchText(url, SOURCE_TIMEOUT_MS);
  const parsed = JSON.parse(rawBody) as Record<string, { rate?: unknown; date?: unknown } | undefined>;
  const entry = parsed[to.toLowerCase()];
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
 * non-ECB codes the three fix sources do not have. */
const SOURCES: Array<{ name: string; quote: (from: string, to: string) => Promise<SourceQuote | null> }> = [
  { name: "frankfurter", quote: quoteFrankfurter },
  { name: "open-er-api", quote: quoteOpenErApi },
  { name: "fawaz", quote: quoteFawaz },
  { name: "vatcomply", quote: quoteVatcomply },
  { name: "floatrates", quote: quoteFloatrates },
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
  const erroredSources: string[] = [];
  const uncoveredSources: string[] = [];
  settled.forEach((outcome, i) => {
    if (outcome?.status === "fulfilled" && outcome.value !== null) {
      quotes.push(outcome.value);
    } else {
      failedSources.push(SOURCES[i].name);
      if (outcome?.status === "fulfilled") {
        uncoveredSources.push(SOURCES[i].name); // answered, but no rate for this pair
      } else {
        erroredSources.push(SOURCES[i].name); // down, timed out, or bad response
      }
    }
  });

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
  // wider split is a real disagreement and is refused, never averaged.
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
        const detail = quotes.map((q) => `${q.source}=${q.rate} (${q.rateDate})`).join("; ");
        throw upstreamUnavailable(
          "FX_SOURCES_DISAGREE",
          `rate sources disagree on ${from}/${to} beyond 0.5% on the SAME date: ${detail}; refusing to serve an averaged wrong answer`,
        );
      }
    } else {
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
      let anchor: typeof sorted | undefined;
      if (groups.length > 0 && groups[0].length >= 2) {
        if (groups.length === 1 || groups[0].length > groups[1].length) {
          anchor = groups[0];
        } else {
          // Tied cluster sizes (weekend shape: a fix pair and a recomputed
          // pair): the reference is fix-heavy, so the cluster whose newest
          // quote is OLDEST — the fix snapshot — anchors. Identical dates
          // fall back to the full-pool median.
          const tied = groups.filter((g) => g.length === groups[0].length);
          const newestKey = (g: typeof sorted): number =>
            Math.max(...g.map((q) => rateDayKey(q.rateDate)));
          const keys = tied.map(newestKey);
          const oldest = Math.min(...keys);
          anchor = keys.filter((k) => k === oldest).length === 1
            ? tied[keys.indexOf(oldest)]
            : undefined;
        }
      }
      anchor ??= sorted;
      const median = anchor[Math.floor((anchor.length - 1) / 2)].rate;
      serving = quotes.filter((q) => q.rate === median);
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

  return envelope(INTENT, fields, receiptDoc, {
    answer:
      `${amount} ${from} = ${converted} ${to} at a rate of ${rate} ${to} per ${from}` +
      ` (${winner.source}, rates dated ${winner.rateDate}` +
      (straddledUpdate
        ? `; ${straddleDetail} — the freshest is served; they did NOT agree within 0.5%)`
        : quotes.length > 1
          ? `; cross-checked against ${quotes.length} sources agreeing within 0.5%` +
            (clusterDetail ? `; ${clusterDetail}` : "") +
            ")"
          : "; single covering source)") +
      ".",
    verdict: "verified",
    confidence,
    source:
      `Keyless public rate APIs (${quotes.map((q) => q.source).join(" + ")}); ` +
      `sources snapshot at different times of day, so a 0.5% pairwise agreement tolerance is applied ` +
      `and a wider split on the same snapshot date is refused, never averaged` +
      (clusterDetail
        ? `; the served rate is the median of the tightest single-linkage agreeing cluster (5bps), not the full pool`
        : "") +
      (degradedReasons.length ? `; degraded: ${degradedReasons.join("; ")}` : ""),
  });
}
