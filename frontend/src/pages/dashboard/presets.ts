// Mission Desk presets — scenario definitions only. Every number the desk
// shows (verdict, score, latency, TVL, LMP, filing count, amount_out) is
// derived from LIVE calls at run time; nothing here is a result.
//
// Replaces DESK_PRESETS (DESIGN-SPEC §6 D-03/D-04). What was removed and why:
// - canned verdicts/scores (98/18/96/72/0), ROIs ("450× cheaper", "$18.00
//   manual check"), the $1.00B TVL policy floor and the $85/MWh ceiling:
//   no source in the repo or the live API (DESIGN-SPEC §8 A4/A15).
// - canned latencies/costs/amounts (TVL $18.42B, LMP $148.40, filing_count 4,
//   amount_out 3142881420): live /v1/* responses replace them (A5/A6/A7).
// - miner names (verireceipt-core, ranked-provider-02, ...): direct probes
//   always route to this miner (slug `verireceipt`, id 774921); there is no
//   ranked routing or related/indep tagging in the direct-probe flow (A20).
// - the staged "402 -> signing X-PAYMENT" stream: no signing happens in the
//   browser; the stream shows real GET /v1/* calls as they settle (D-16).
//
// Live inputs verified against the real miner before writing:
// - confirmed tx 0x1b9e2b48… (ethereum) and reverted tx 0x1a146789… (ethereum)
//   are the repo's own test fixtures (tests/tx.test.ts).
// - grid zone TH_NP15_GEN-APND + a 2h-ago interval returns live CAISO LMP.

import { getCorporateRegistry, getFilings, getGridPrice, getOnchainMetric, getPoolLiquidity, getReserveAttestation, getRoute, getSanctionsScreen, getStockPrice, getTokenHolders, getTokenSupply, getTvl, getTx } from "../../lib/api";
import type { CorporateRegistryResponse, FilingsResponse, GridPriceResponse, LiveReceipt, OnchainMetricResponse, PoolLiquidityResponse, ProbeOutcome, ReserveAttestationResponse, RouteResponse, SanctionsScreenResponse, StockPriceResponse, TokenHoldersResponse, TokenSupplyResponse, TvlResponse, TxResponse } from "./types";
import { formatUsd, formatUsdPrecise, isVerified, probe, recentGridInterval } from "./utils";

export type MissionId = "m13" | "m12" | "m03" | "m04" | "m01" | "m02" | "m14";
/**
 * APPROVE / REJECT / HOLD: a decision against a rule the scenario states.
 * VERIFIED: the data was retrieved and receipted, but no decision rule
 * applies (QA-02/QA-03: a historical lookup, or a power price with no
 * threshold, must never read as an operational approval).
 * RUN / CURTAIL: the power scenario's outcome against a user-set
 * $/MWh threshold.
 */
export type DeskVerdict = "APPROVE" | "REJECT" | "HOLD" | "VERIFIED" | "RUN" | "CURTAIL";

export interface DeskInputs {
  entity: string;
  ref: string;
  scope: string;
}

export interface DeskCheckDef {
  /** Short label shown in the stream log. */
  label: string;
  intent: string;
  /** Human-readable query shown in the ledger + receipt table. */
  query: string;
  /** Direct Render URL (Copy curl). */
  requestUrl: string;
  run: (signal?: AbortSignal) => Promise<ProbeOutcome>;
}

export interface DeskPreset {
  id: string;
  mission: MissionId;
  tag: string;
  title: string;
  sub: string;
  inputs: DeskInputs;
  /** Build the live checks from the (possibly user-edited) inputs. */
  buildChecks: (inputs: DeskInputs) => DeskCheckDef[];
  /** Derive the verdict from the settled live results (and, for rules
   *  the user sets — the m12 $/MWh threshold — the inputs of that run). */
  evaluate: (results: DeskCheckResult[], inputs?: DeskInputs) => DeskEvaluation;
}

export interface DeskCheckResult {
  check: DeskCheckDef;
  receipt: LiveReceipt;
}

export interface WhyCard {
  k: string;
  v: string;
  /**
   * Whether the check passed. `true` renders PASS, `false` renders
   * GATE, `"na"` renders N/A (not a check — no pass/fail applies).
   * A non-check must never wear PASS (J2 R5: the m12 Curtailment
   * Threshold card is disclosure, not a check).
   */
  ok: boolean | "na";
}

export interface DeskEvaluation {
  verdict: DeskVerdict;
  score: number;
  headline: string;
  why: WhyCard[];
}

const CONFIRMED_TX = "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3";
const REVERTED_TX = "0x1a1467893eaed124a13164b589f1ed7a70ec203257084a7be27eee8f93bd8ba9";

function splitSegments(s: string): string[] {
  return s
    .split("·")
    .map((x) => x.trim())
    .filter(Boolean);
}

function bodyOf<T>(r: DeskCheckResult): T | null {
  return (r.receipt.body ?? null) as T | null;
}

function txStatusOf(r: DeskCheckResult): string | null {
  const b = bodyOf<TxResponse>(r);
  return b && typeof b.status === "string" ? b.status : null;
}

/** Period of the filings question actually asked, parsed from the call's
 *  request URL (the envelope carries no period, and evaluate() does not
 *  close over buildChecks()' locals). "" when unknown — the why-card
 *  then omits the window rather than printing a placeholder. */
function filingsPeriodOf(result: DeskCheckResult | undefined): string {
  const url = result?.receipt?.requestUrl;
  if (typeof url !== "string" || !url) return "";
  try {
    return new URL(url).searchParams.get("period") ?? "";
  } catch {
    return "";
  }
}

/**
 * QA-03: the user's curtailment threshold in $/MWh, typed into the
 * interval field as "threshold 60" (or "threshold $60.5"). null when
 * absent or not a sane number — then no run/curtail decision is made.
 */
export function parseThreshold(scope: string): number | null {
  const m = /\bthreshold\s*\$?\s*(\d{1,6}(?:\.\d{1,4})?)(?![\d.])/i.exec(scope);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** form_type actually sent, parsed from the request URL ("" if none). */
function filingsFormOf(result: DeskCheckResult | undefined): string {
  const url = result?.receipt?.requestUrl;
  if (typeof url !== "string" || !url) return "";
  try {
    return new URL(url).searchParams.get("form_type") ?? "";
  } catch {
    return "";
  }
}

// NOTE (J2 R4 B1): there is deliberately NO bare `status === 200`
// helper in this file anymore. Every "ok" check below keys on the
// shared isVerified() predicate (200 AND a receipt, utils.ts) — a
// 200-refusal (lib: INVALID_RESPONSE, status 200, no receipt) must
// never render success text in a why-card.

function scoreOf(passes: number, total: number): number {
  return total === 0 ? 0 : Math.round((passes / total) * 100);
}

function direct(path: string, params: Record<string, string>): string {
  return `https://verireceipt.onrender.com${path}?${new URLSearchParams(params).toString()}`;
}

export const DESK_PRESETS: DeskPreset[] = [
  {
    id: "m13-defi",
    mission: "m13",
    tag: "M13 · ALLOCATION",
    title: "Institutional DeFi Allocation",
    sub: "aave-v3 TVL + verified tx + ETH/USDC route + SEC filing — all live",
    inputs: {
      entity: "aave-v3 · AAPL",
      ref: CONFIRMED_TX,
      scope: "ethereum · last 12 months · ETH/USDC",
    },
    buildChecks: (inputs) => {
      // No silent defaults: a cleared field stays empty and the lib
      // refuses it (400) — the run reports on what the user entered.
      const segs = splitSegments(inputs.scope);
      const chain = segs[0] ?? "";
      const period = segs[1] ?? "";
      const pair = segs[2] ?? "";
      const [protocol, entity] = splitSegments(inputs.entity);
      const protocolValue = protocol ?? "";
      const entityValue = entity ?? "";
      return [
        {
          label: "TX lookup",
          intent: "ONCHAIN_TX_LOOKUP_GENERAL",
          query: `${inputs.ref.slice(0, 8)}…${inputs.ref.slice(-4)} (${chain})`,
          requestUrl: direct("/v1/tx", { tx_hash: inputs.ref, chain }),
          run: (signal) => probe((s) => getTx({ tx_hash: inputs.ref, chain }, s), signal),
        },
        {
          label: "TVL lookup",
          intent: "TVL_LOOKUP_GENERAL",
          query: `protocol=${protocolValue}`,
          requestUrl: direct("/v1/tvl", { protocol: protocolValue }),
          run: (signal) => probe((s) => getTvl({ protocol: protocolValue }, s), signal),
        },
        {
          label: "SEC filing",
          intent: "REGULATORY_FILING_MONITOR_GENERAL",
          query: `${entityValue} · ${period}`,
          requestUrl: direct("/v1/filings", { entity: entityValue, period }),
          run: (signal) => probe((s) => getFilings({ entity: entityValue, period }, s), signal),
        },
        {
          label: "ETH/USDC route",
          intent: "OPTIMAL_EXECUTION_ROUTE_GENERAL",
          query: `pair=${pair}`,
          requestUrl: direct("/v1/route", { pair }),
          run: (signal) => probe((s) => getRoute({ pair }, s), signal),
        },
      ];
    },
    evaluate: (results) => {
      const [tx, tvl, filings, route] = results;
      const txOk = !!tx && isVerified(tx.receipt) && txStatusOf(tx) === "confirmed";
      const tvlBody = tvl ? bodyOf<TvlResponse>(tvl) : null;
      const tvlOk = !!tvl && isVerified(tvl.receipt) && typeof tvlBody?.tvl_usd === "number" && tvlBody.tvl_usd > 0;
      const filingsBody = filings ? bodyOf<FilingsResponse>(filings) : null;
      const filingsOk =
        !!filings && isVerified(filings.receipt) && typeof filingsBody?.filing_count === "number" && filingsBody.filing_count > 0;
      const filingsPeriod = filingsPeriodOf(filings);
      const routeBody = route ? bodyOf<RouteResponse>(route) : null;
      const routeOk = !!route && isVerified(route.receipt) && typeof routeBody?.amount_out === "number" && routeBody.amount_out > 0;
      const passes = [txOk, tvlOk, filingsOk, routeOk].filter(Boolean).length;
      const verdict: DeskVerdict =
        passes === 4 ? "APPROVE" : tx && isVerified(tx.receipt) && txStatusOf(tx) === "reverted" ? "REJECT" : "HOLD";
      const why: WhyCard[] = [
        {
          k: "Archive Quorum",
          v: tx ? (isVerified(tx.receipt) ? `status ${txStatusOf(tx) ?? "?"} · block ${bodyOf<TxResponse>(tx)?.block_number ?? "?"}` : `call failed: HTTP ${tx.receipt.status}`) : "not run",
          ok: txOk,
        },
        {
          k: "TVL (live)",
          v: tvlBody && typeof tvlBody.tvl_usd === "number" ? `${formatUsd(tvlBody.tvl_usd)} total TVL` : "no live TVL returned",
          ok: tvlOk,
        },
        {
          // QA-02: an all-forms filing count is a retrieval, not a
          // compliance check — the card is labelled as what it is.
          k: "SEC Filings (live)",
          // (J2 R5 B2) Never interpolate a refusal body: probe()
          // synthesizes {error, message} on refusal, so a bare
          // `filingsBody ?` is truthy on ANY refusal and rendered
          // "undefined filings for undefined". Render the count only
          // on a verified receipt with a typed filing_count (a
          // verified 0 is a real answer) and a typed entity. The count
          // carries its window (J2 R3 B3): "95 filings" is the
          // last-12-months answer, "52" the last-6-months one.
          v:
            filings && isVerified(filings.receipt) && typeof filingsBody?.filing_count === "number" && typeof filingsBody?.entity === "string"
              ? `${filingsBody.filing_count} filings for ${filingsBody.entity}${filingsPeriod ? ` in ${filingsPeriod}` : ""}`
              : "no live filings returned",
          ok: filingsOk,
        },
        {
          k: "Route Execution",
          v:
            routeBody && typeof routeBody.amount_out === "number"
              ? `${(routeBody.amount_out / 1e6).toFixed(2)} USDC / 1 ETH${routeBody.block_number ? ` · block ${routeBody.block_number}` : ""}`
              : "no live route returned",
          ok: routeOk,
        },
      ];
      return {
        verdict,
        score: scoreOf(passes, 4),
        headline:
          verdict === "APPROVE"
            ? "All 4 deterministic checks passed with cryptographic receipts."
            : verdict === "REJECT"
              ? "Reference transaction reverted on-chain — allocation blocked."
              : "Not all checks verified — review the failed rows before acting.",
        why,
      };
    },
  },
  {
    id: "m13-reverted",
    mission: "m13",
    tag: "M13 · COUNTERPARTY TRAP",
    title: "Reverted Counterparty Trap",
    sub: "Reverted on-chain tx hash triggers fail-closed REJECT — live",
    inputs: {
      entity: "micro-vault-v1",
      ref: REVERTED_TX,
      scope: "ethereum",
    },
    buildChecks: (inputs) => {
      // No silent defaults (see m13-defi): a cleared chain runs empty.
      const chain = splitSegments(inputs.scope)[0] ?? "";
      return [
        {
          label: "TX lookup",
          intent: "ONCHAIN_TX_LOOKUP_GENERAL",
          query: `${inputs.ref.slice(0, 8)}…${inputs.ref.slice(-4)} (${chain})`,
          requestUrl: direct("/v1/tx", { tx_hash: inputs.ref, chain }),
          run: (signal) => probe((s) => getTx({ tx_hash: inputs.ref, chain }, s), signal),
        },
        {
          label: "TVL lookup",
          intent: "TVL_LOOKUP_GENERAL",
          query: `protocol=${inputs.entity}`,
          requestUrl: direct("/v1/tvl", { protocol: inputs.entity }),
          run: (signal) => probe((s) => getTvl({ protocol: inputs.entity }, s), signal),
        },
      ];
    },
    evaluate: (results) => {
      const [tx, tvl] = results;
      const txReverted = !!tx && isVerified(tx.receipt) && txStatusOf(tx) === "reverted";
      const tvlBody = tvl ? bodyOf<TvlResponse>(tvl) : null;
      const tvlAnswered =
        !!tvl &&
        (isVerified(tvl.receipt)
          ? typeof tvlBody?.tvl_usd === "number"
          : tvl.receipt.status === 400 || tvl.receipt.status === 422);
      const passes = (txReverted ? 1 : 0) + (tvlAnswered ? 1 : 0);
      const why: WhyCard[] = [
        {
          k: "Receipt Status",
          v: tx ? (isVerified(tx.receipt) ? `archive quorum confirms status: ${txStatusOf(tx) ?? "?"}` : `call failed: HTTP ${tx.receipt.status}`) : "not run",
          ok: txReverted,
        },
        {
          k: "Signing Policy",
          v: txReverted ? "Fail-closed rule: reverted tx → REJECT" : "No reverted tx observed — no REJECT triggered",
          ok: txReverted,
        },
        {
          k: "TVL Guard",
          // (J2 R6 M3) Mirror the m13-defi "TVL (live)" guard: a
          // verified receipt without a numeric tvl_usd renders the
          // honest fallback, never "live TVL —" on a GATE card.
          // (tvlAnswered already requires the numeric field, so `ok`
          // was correct — only the text lied.)
          v: tvl
            ? isVerified(tvl.receipt)
              ? typeof tvlBody?.tvl_usd === "number"
                ? `live TVL ${formatUsd(tvlBody.tvl_usd)}`
                : "no live TVL returned"
              : `clean refusal HTTP ${tvl.receipt.status} — no fabricated TVL`
            : "not run",
          ok: tvlAnswered,
        },
      ];
      return {
        verdict: txReverted ? "REJECT" : "HOLD",
        score: scoreOf(passes, 2),
        headline: txReverted
          ? "Counterparty reference transaction reverted on-chain — signing blocked."
          : "Trap did not trigger on live data — review the rows before acting.",
        why,
      };
    },
  },
  {
    id: "m13-sec",
    mission: "m13",
    tag: "M13 · COMPLIANCE",
    title: "SEC 10-K Annual Report Check",
    sub: "Is a Form 10-K on official EDGAR within the last 12 months? — live",
    inputs: {
      entity: "AAPL",
      ref: "10-K",
      scope: "last 12 months · SEC EDGAR",
    },
    buildChecks: (inputs) => {
      // No silent defaults (see m13-defi): a cleared period or form runs
      // empty and the lib refuses it. QA-02: the form field IS the
      // request's form_type — it is sent, never decorative.
      const period = splitSegments(inputs.scope)[0] ?? "";
      const form = inputs.ref.trim();
      return [
        {
          label: "SEC filing",
          intent: "REGULATORY_FILING_MONITOR_GENERAL",
          query: `${inputs.entity} · ${form} · ${period}`,
          requestUrl: direct("/v1/filings", { entity: inputs.entity, period, form_type: form }),
          run: (signal) => probe((s) => getFilings({ entity: inputs.entity, period, form_type: form }, s), signal),
        },
      ];
    },
    evaluate: (results) => {
      const [filings] = results;
      const evaluatedOn = new Date().toISOString().slice(0, 10);
      const filingsBody = filings ? bodyOf<FilingsResponse>(filings) : null;
      const verified = !!filings && isVerified(filings.receipt) && typeof filingsBody?.filing_count === "number";
      const asked = filingsFormOf(filings);
      const period = filingsPeriodOf(filings);
      const detail = Array.isArray(filingsBody?.filings_detail) ? filingsBody.filings_detail : [];
      // The miner echoes the filter it applied; every returned filing
      // must be that form. Anything else is a mismatch, not a pass.
      const formMatches =
        verified &&
        asked !== "" &&
        filingsBody?.form_type === asked &&
        detail.length === filingsBody.filing_count &&
        detail.every((f) => f && f.form === asked);
      const dates = detail
        .map((f) => (typeof f?.filing_date === "string" ? f.filing_date : ""))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
      const latest = dates.length > 0 ? dates[dates.length - 1] : null;
      // The ONE currentness rule this scenario implements: an annual
      // report (Form 10-K) filed within the last 12 months. Any other
      // window or form is a historical / data retrieval — VERIFIED, never
      // a present-day compliance verdict.
      const rollingWindow = /^last 12 months$/i.test(period.trim());
      const ruleApplies = asked === "10-K" && rollingWindow;
      const count = verified ? filingsBody!.filing_count : null;
      const why: WhyCard[] = [
        {
          k: "Official EDGAR",
          v: verified && typeof filingsBody?.entity === "string"
            ? `${count} Form ${asked || "?"} filing(s) for ${filingsBody.entity}${period ? ` in ${period}` : ""}${latest ? ` · latest filed ${latest}` : ""}`
            : "no live filings returned",
          ok: verified,
        },
        {
          k: "Form Filter",
          v: !verified
            ? "not verified"
            : formMatches
              ? `request and answer both form_type=${asked}`
              : `answer does not match the requested form_type=${asked || "(empty)"}`,
          ok: verified && formMatches,
        },
        {
          k: "URL Provenance",
          // (J2 R6 M4) Same isVerified gate as Official EDGAR.
          v:
            verified && Array.isArray(filingsBody?.urls) && filingsBody.urls.length > 0
              ? `${filingsBody.urls.length} archive URL(s) on sec.gov`
              : "no archive URLs returned",
          ok: verified && Array.isArray(filingsBody?.urls) && filingsBody.urls.length > 0,
        },
        {
          k: "Currentness Rule",
          v: ruleApplies
            ? `at least one Form 10-K filed in the last 12 months (evaluated ${evaluatedOn} UTC). Filing-deadline lateness is not checked.`
            : `not applied — the rule covers form 10-K over "last 12 months" only; this run is a data retrieval for ${period || "the given period"}.`,
          ok: ruleApplies ? verified && formMatches && (count ?? 0) > 0 : "na",
        },
      ];
      if (!verified || !formMatches) {
        return {
          verdict: "HOLD",
          score: scoreOf(verified ? 1 : 0, 2),
          headline: "Filing data did not verify for the requested form — review the rows before acting.",
          why,
        };
      }
      if (!ruleApplies) {
        return {
          verdict: "VERIFIED",
          score: 100,
          headline: `Data verified: ${count} Form ${asked} filing(s) in ${period}. No current-compliance verdict is derived for this window.`,
          why,
        };
      }
      return (count ?? 0) > 0
        ? {
            verdict: "APPROVE",
            score: 100,
            headline: `Form 10-K on file: latest filed ${latest ?? "?"}, within the last 12 months (evaluated ${evaluatedOn} UTC).`,
            why,
          }
        : {
            verdict: "HOLD",
            score: scoreOf(2, 3),
            headline: `NEEDS REVIEW: no Form 10-K filed in the last 12 months (evaluated ${evaluatedOn} UTC).`,
            why,
          };
    },
  },
  {
    id: "m03-mark",
    mission: "m03",
    tag: "M03 · INSTITUTIONAL",
    title: "Defensible Mark Evidence Check",
    sub: "Is a 10-Q on EDGAR within 12 months, with a live verified share price? — live",
    inputs: {
      entity: "ARCC",
      ref: "10-Q",
      scope: "last 12 months · SEC EDGAR + Yahoo Finance",
    },
    buildChecks: (inputs) => {
      // No silent defaults (see m13-defi / m13-sec): the form field IS
      // the request's form_type; a cleared period or form runs empty.
      const period = splitSegments(inputs.scope)[0] ?? "";
      const form = inputs.ref.trim();
      return [
        {
          label: "SEC filing",
          intent: "REGULATORY_FILING_MONITOR_GENERAL",
          query: `${inputs.entity} · ${form} · ${period}`,
          requestUrl: direct("/v1/filings", { entity: inputs.entity, period, form_type: form }),
          run: (signal) => probe((s) => getFilings({ entity: inputs.entity, period, form_type: form }, s), signal),
        },
        {
          label: "Share price",
          intent: "STOCK_PRICE_US_EQUITY",
          query: `ticker=${inputs.entity}`,
          requestUrl: direct("/v1/stock-price", { ticker: inputs.entity }),
          run: (signal) => probe((s) => getStockPrice({ ticker: inputs.entity }, s), signal),
        },
      ];
    },
    evaluate: (results) => {
      const [filings, price] = results;
      const evaluatedOn = new Date().toISOString().slice(0, 10);
      const filingsBody = filings ? bodyOf<FilingsResponse>(filings) : null;
      const verified = !!filings && isVerified(filings.receipt) && typeof filingsBody?.filing_count === "number";
      const asked = filingsFormOf(filings);
      const period = filingsPeriodOf(filings);
      const detail = Array.isArray(filingsBody?.filings_detail) ? filingsBody.filings_detail : [];
      const formMatches =
        verified &&
        asked !== "" &&
        filingsBody?.form_type === asked &&
        detail.length === filingsBody.filing_count &&
        detail.every((f) => f && f.form === asked);
      const dates = detail
        .map((f) => (typeof f?.filing_date === "string" ? f.filing_date : ""))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
      const latest = dates.length > 0 ? dates[dates.length - 1] : null;
      const priceBody = price ? bodyOf<StockPriceResponse>(price) : null;
      const priceOk =
        !!price &&
        isVerified(price.receipt) &&
        typeof priceBody?.price_usd === "number" &&
        Number.isFinite(priceBody.price_usd) &&
        priceBody.price_usd > 0;
      // The ONE evidence rule this scenario implements: a quarterly
      // report (Form 10-Q) within the last 12 months plus a live
      // verified share price. Any other window or form is a data
      // retrieval — VERIFIED, never an evidence-complete verdict.
      const rollingWindow = /^last 12 months$/i.test(period.trim());
      const ruleApplies = asked === "10-Q" && rollingWindow;
      const count = verified ? filingsBody!.filing_count : null;
      const why: WhyCard[] = [
        {
          k: "Official EDGAR",
          v: verified && typeof filingsBody?.entity === "string"
            ? `${count} Form ${asked || "?"} filing(s) for ${filingsBody.entity}${period ? ` in ${period}` : ""}${latest ? ` · latest filed ${latest}` : ""}`
            : "no live filings returned",
          ok: verified,
        },
        {
          k: "Form Filter",
          v: !verified
            ? "not verified"
            : formMatches
              ? `request and answer both form_type=${asked}`
              : `answer does not match the requested form_type=${asked || "(empty)"}`,
          ok: verified && formMatches,
        },
        {
          k: "Share Price (live)",
          v:
            priceOk && typeof priceBody?.exchange === "string" && priceBody.exchange !== ""
              ? `${formatUsdPrecise(priceBody.price_usd)} · ${priceBody.exchange}${typeof priceBody.market_time === "string" && priceBody.market_time !== "" ? ` · as of ${priceBody.market_time}` : ""}`
              : "no live verified price returned",
          ok: priceOk,
        },
        {
          k: "Evidence Rule",
          v: ruleApplies
            ? `at least one Form 10-Q filed in the last 12 months plus a live verified share price (evaluated ${evaluatedOn} UTC).`
            : `not applied — the rule covers form 10-Q over "last 12 months" plus a verified price; this run is a data retrieval for ${period || "the given period"}.`,
          ok: ruleApplies ? verified && formMatches && priceOk && (count ?? 0) > 0 : "na",
        },
      ];
      if (!verified || !formMatches || !priceOk) {
        return {
          verdict: "HOLD",
          score: scoreOf((verified && formMatches ? 1 : 0) + (priceOk ? 1 : 0), 2),
          headline: "Evidence did not verify — review the rows before relying on this mark.",
          why,
        };
      }
      if (!ruleApplies) {
        return {
          verdict: "VERIFIED",
          score: 100,
          headline: `Data verified: ${count} Form ${asked} filing(s) in ${period} plus a live share price. No evidence-complete verdict is derived for this window.`,
          why,
        };
      }
      return (count ?? 0) > 0
        ? {
            verdict: "APPROVE",
            score: 100,
            headline: `Evidence complete: latest Form 10-Q filed ${latest ?? "?"}, within the last 12 months, plus a live verified share price (evaluated ${evaluatedOn} UTC).`,
            why,
          }
        : {
            verdict: "HOLD",
            // Two live checks, both verified; the HOLD is the rule
            // outcome (no 10-Q in the window), not a failed check.
            score: scoreOf(2, 2),
            headline: `NEEDS REVIEW: no Form 10-Q filed in the last 12 months (evaluated ${evaluatedOn} UTC).`,
            why,
          };
    },
  },
  {
    id: "m04-diligence",
    mission: "m04",
    tag: "M04 · LEGAL",
    title: "Overnight Counterparty Diligence",
    sub: "Sanctions screen + active registry record + current 10-Q, receipted — live",
    inputs: {
      entity: "Ares Capital Corporation",
      ref: "10-Q",
      scope: "last 12 months · ARCC · US-MD",
    },
    buildChecks: (inputs) => {
      // entity = legal name screened and looked up; scope segments are
      // period · filings ticker · registry jurisdiction. No silent
      // defaults: a cleared segment runs empty and the lib refuses it.
      const segs = splitSegments(inputs.scope);
      const period = segs[0] ?? "";
      const ticker = segs[1] ?? "";
      const jurisdiction = segs[2] ?? "";
      const form = inputs.ref.trim();
      return [
        {
          label: "Sanctions screen",
          intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
          query: `name=${inputs.entity}`,
          requestUrl: direct("/v1/sanctions-screen", { name: inputs.entity }),
          run: (signal) => probe((s) => getSanctionsScreen({ name: inputs.entity }, s), signal),
        },
        {
          label: "Corporate registry",
          intent: "CORPORATE_REGISTRY_LOOKUP_GENERAL",
          query: `company=${inputs.entity} · ${jurisdiction}`,
          requestUrl: direct("/v1/corporate-registry", { company: inputs.entity, jurisdiction }),
          run: (signal) => probe((s) => getCorporateRegistry({ company: inputs.entity, jurisdiction }, s), signal),
        },
        {
          label: "SEC filing",
          intent: "REGULATORY_FILING_MONITOR_GENERAL",
          query: `${ticker} · ${form} · ${period}`,
          requestUrl: direct("/v1/filings", { entity: ticker, period, form_type: form }),
          run: (signal) => probe((s) => getFilings({ entity: ticker, period, form_type: form }, s), signal),
        },
      ];
    },
    evaluate: (results) => {
      const [sanctions, registry, filings] = results;
      const evaluatedOn = new Date().toISOString().slice(0, 10);
      const sBody = sanctions ? bodyOf<SanctionsScreenResponse>(sanctions) : null;
      const sanctionsOk = !!sanctions && isVerified(sanctions.receipt) && typeof sBody?.matched === "boolean";
      const matched = sanctionsOk ? sBody!.matched === true : null;
      const rBody = registry ? bodyOf<CorporateRegistryResponse>(registry) : null;
      const registryOk =
        !!registry &&
        isVerified(registry.receipt) &&
        rBody?.lookup_status === "found" &&
        typeof rBody?.active === "boolean";
      const active = registryOk ? rBody!.active === true : null;
      const fBody = filings ? bodyOf<FilingsResponse>(filings) : null;
      const verified = !!filings && isVerified(filings.receipt) && typeof fBody?.filing_count === "number";
      const asked = filingsFormOf(filings);
      const period = filingsPeriodOf(filings);
      const detail = Array.isArray(fBody?.filings_detail) ? fBody.filings_detail : [];
      const formMatches =
        verified &&
        asked !== "" &&
        fBody?.form_type === asked &&
        detail.length === fBody.filing_count &&
        detail.every((f) => f && f.form === asked);
      const rollingWindow = /^last 12 months$/i.test(period.trim());
      const ruleApplies = asked === "10-Q" && rollingWindow;
      const count = verified ? fBody!.filing_count : null;
      const why: WhyCard[] = [
        {
          k: "Sanctions Screen",
          v: !sanctionsOk
            ? "not verified"
            : matched
              ? `MATCH above threshold${typeof sBody?.match_score === "number" ? ` (best ${sBody.match_score})` : ""} — a fuzzy name match is not identity confirmation, but it blocks an overnight pass`
              : `no match above threshold${typeof sBody?.match_score === "number" ? ` (best ${sBody.match_score})` : ""} — a non-match is not legal clearance`,
          ok: sanctionsOk && matched === false,
        },
        {
          k: "Registry Record",
          v: !registryOk
            ? "not verified"
            : active
              ? `${rBody?.legal_name ?? "entity"} GLEIF entity status ACTIVE · ${rBody?.jurisdiction ?? "?"}${rBody?.registration_id ? ` · reg ${rBody.registration_id}` : ""}`
              : `${rBody?.legal_name ?? "entity"} GLEIF entity status not active · ${rBody?.jurisdiction ?? "?"}`,
          ok: registryOk && active === true,
        },
        {
          k: "Official EDGAR",
          v:
            verified && formMatches
              ? `${count} Form ${asked} filing(s) in ${period}`
              : verified
                ? `answer does not match the requested form_type=${asked || "(empty)"}`
                : "no live filings returned",
          ok: verified && formMatches,
        },
        {
          k: "Diligence Rule",
          v: ruleApplies
            ? `pass = no sanctions match + active registry + at least one Form 10-Q in the last 12 months (evaluated ${evaluatedOn} UTC). An overnight screen, not a legal opinion.`
            : `not applied — the rule covers form 10-Q over "last 12 months"; this run is a data retrieval for ${period || "the given period"}.`,
          ok: ruleApplies ? sanctionsOk && matched === false && registryOk && active === true && verified && formMatches && (count ?? 0) > 0 : "na",
        },
      ];
      if (matched === true) {
        // Never a public finding against a named company: a fuzzy name
        // match is a review trigger, so the outcome is HOLD, not REJECT.
        return {
          verdict: "HOLD",
          score: scoreOf(2, 3),
          headline: "Sanctions match above threshold — overnight diligence blocked pending review. A fuzzy match is not identity confirmation.",
          why,
        };
      }
      if (!sanctionsOk || !registryOk || !verified || !formMatches) {
        return {
          verdict: "HOLD",
          score: scoreOf((sanctionsOk ? 1 : 0) + (registryOk ? 1 : 0) + (verified && formMatches ? 1 : 0), 3),
          headline: "Evidence did not verify — review the rows before acting.",
          why,
        };
      }
      if (!ruleApplies) {
        return {
          verdict: "VERIFIED",
          score: 100,
          headline: `Data verified: no sanctions match, registry ${active ? "active" : "inactive"}, ${count} Form ${asked} filing(s) in ${period}. No diligence verdict is derived for this window.`,
          why,
        };
      }
      if (active !== true) {
        return {
          verdict: "HOLD",
          score: scoreOf(2, 3),
          headline: `NEEDS REVIEW: registry record is not active (evaluated ${evaluatedOn} UTC).`,
          why,
        };
      }
      return (count ?? 0) > 0
        ? {
            verdict: "APPROVE",
            score: 100,
            headline: `Overnight diligence pass: no sanctions match, registry active, ${count} Form 10-Q in the last 12 months (evaluated ${evaluatedOn} UTC). Not a legal opinion.`,
            why,
          }
        : {
            verdict: "HOLD",
            score: scoreOf(2, 3),
            headline: `NEEDS REVIEW: no Form 10-Q filed in the last 12 months (evaluated ${evaluatedOn} UTC).`,
            why,
          };
    },
  },
  {
    id: "m12-curtail",
    mission: "m12",
    tag: "M12 · MINING POWER",
    title: "Grid LMP Dispatch Check",
    sub: "Live CAISO wholesale LMP; set a $/MWh threshold for a run/curtail outcome",
    inputs: {
      entity: "CAISO OASIS · Mining Fleet",
      ref: "TH_NP15_GEN-APND",
      // QA-03: no threshold by default — the outcome is DATA VERIFIED,
      // never an operational approval. Type e.g. "threshold 60" here to
      // evaluate a run/curtail rule against the live LMP.
      scope: `${recentGridInterval()} · no threshold`,
    },
    buildChecks: (inputs) => {
      // No silent defaults (see m13-defi): an unparseable/missing
      // interval runs empty instead of quietly substituting "2h ago".
      const segs = splitSegments(inputs.scope);
      const parsed = segs[0] && !Number.isNaN(Date.parse(segs[0])) ? segs[0] : "";
      return [
        {
          label: "Grid LMP",
          intent: "GRID_POWER_PRICE_GENERAL",
          query: `zone=${inputs.ref} · ${parsed}`,
          requestUrl: direct("/v1/grid-price", { node_or_zone: inputs.ref, interval_start: parsed }),
          run: (signal) => probe((s) => getGridPrice({ node_or_zone: inputs.ref, interval_start: parsed }, s), signal),
        },
        {
          label: "ETH/USDC route",
          intent: "OPTIMAL_EXECUTION_ROUTE_GENERAL",
          query: "pair=ETH/USDC",
          requestUrl: direct("/v1/route", { pair: "ETH/USDC" }),
          run: (signal) => probe((s) => getRoute({ pair: "ETH/USDC" }, s), signal),
        },
      ];
    },
    evaluate: (results, inputs) => {
      const threshold = parseThreshold(inputs?.scope ?? "");
      const [grid, route] = results;
      const gridBody = grid ? bodyOf<GridPriceResponse>(grid) : null;
      const gridOk = !!grid && isVerified(grid.receipt) && typeof gridBody?.lmp_usd_per_mwh === "number" && Number.isFinite(gridBody.lmp_usd_per_mwh);
      const routeBody = route ? bodyOf<RouteResponse>(route) : null;
      const routeOk = !!route && isVerified(route.receipt) && typeof routeBody?.amount_out === "number" && routeBody.amount_out > 0;
      const why: WhyCard[] = [
        {
          k: "LMP (live)",
          // (J2 R5 B2) Same refusal-body trap as the filings cards: a
          // truthy {error, message} body rendered "— / MWh ·  ·
          // undefined". Render only on a verified receipt with a
          // finite numeric LMP.
          // (J2 R6 M2) `market` is unvalidated at runtime despite the
          // lib type: `market: {}` rendered "[object Object]". Render
          // the market segment only for a non-empty string, else omit
          // it cleanly — the LMP and zone still read.
          // (J2 R7 M1b) The zone is a display label, not the price:
          // requiring it in the `v` gate rendered "no live LMP
          // returned" beside a true `ok` when a verified LMP had no
          // zone, and `zone: ""` left a trailing "· ". Render the
          // zone segment only for a non-empty string, same pattern
          // as the market segment — the fallback fires only when the
          // price itself is unverified/absent.
          v:
            grid && isVerified(grid.receipt) && typeof gridBody?.lmp_usd_per_mwh === "number" && Number.isFinite(gridBody.lmp_usd_per_mwh)
              ? `${formatUsdPrecise(gridBody.lmp_usd_per_mwh)} / MWh${typeof gridBody.market === "string" && gridBody.market ? ` · ${gridBody.market}` : ""}${typeof gridBody.node_or_zone === "string" && gridBody.node_or_zone ? ` · ${gridBody.node_or_zone}` : ""}`
              : "no live LMP returned",
          ok: gridOk,
        },
        {
          k: "Curtailment Threshold",
          // QA-03: the threshold is the user's own input (scope field,
          // e.g. "threshold 60"); none is shipped as a default — the
          // design's $85/MWh ceiling has no source (DESIGN-SPEC §8 A4).
          v:
            threshold === null
              ? "No threshold set — LMP is reported live; no run/curtail decision is derived. Add e.g. \"threshold 60\" ($/MWh) to the interval field."
              : `Your threshold ${formatUsdPrecise(threshold)} / MWh: curtail when the live LMP is above it, run when at or below it.`,
          // (J2 R5) Not a check without a threshold: "na" renders N/A.
          ok: "na",
        },
        {
          k: "ETH Hedge Check",
          v: routeBody && typeof routeBody.amount_out === "number" ? `${(routeBody.amount_out / 1e6).toFixed(2)} USDC / 1 ETH verified` : "no live route returned",
          ok: routeOk,
        },
      ];
      const passes = [gridOk, routeOk].filter(Boolean).length;
      // (J2 R6 M1) gridOk gates score/verdict, not the zone label: a
      // verified receipt with a finite numeric LMP is a genuinely
      // verified price even if the body omits node_or_zone, so
      // requiring the zone in gridOk would demote a verified check
      // to HOLD over a display label. Omit the "at …" clause from
      // the headline instead — never "verified live at undefined".
      const zoneSuffix =
        typeof gridBody?.node_or_zone === "string" && gridBody.node_or_zone ? ` at ${gridBody.node_or_zone}` : "";
      // QA-03: the verdict depends on the grid price and the user's
      // threshold only. The ETH/USDC quote is a cross-check row; it can
      // never turn a price lookup into a power-dispatch approval.
      if (!gridOk) {
        return {
          verdict: "HOLD",
          score: scoreOf(passes, 2),
          headline: "Grid price did not verify — review the rows before acting.",
          why,
        };
      }
      const lmp = gridBody!.lmp_usd_per_mwh;
      const priceText = `${formatUsdPrecise(lmp)} / MWh`;
      if (threshold === null) {
        return {
          verdict: "VERIFIED",
          score: scoreOf(passes, 2),
          headline: `Data verified: wholesale LMP ${priceText}${zoneSuffix}. No threshold set — no run/curtail decision.`,
          why,
        };
      }
      return lmp > threshold
        ? {
            verdict: "CURTAIL",
            score: scoreOf(passes, 2),
            headline: `CURTAIL: live LMP ${priceText}${zoneSuffix} is above your ${formatUsdPrecise(threshold)} / MWh threshold.`,
            why,
          }
        : {
            verdict: "RUN",
            score: scoreOf(passes, 2),
            headline: `RUN: live LMP ${priceText}${zoneSuffix} is at or below your ${formatUsdPrecise(threshold)} / MWh threshold.`,
            why,
          };
    },
  },
  {
    id: "m13-422",
    mission: "m13",
    tag: "M13 · FAIL-CLOSED 400",
    title: "Fail-Closed Validation Refusal Probe (HTTP 400)",
    sub: "Malformed tx hash 0x1234 refused with HTTP 400 before any receipt — live",
    inputs: {
      entity: "invalid-input-probe",
      ref: "0x1234",
      scope: "ethereum · schema validation",
    },
    buildChecks: (inputs) => {
      // No silent defaults (see m13-defi): a cleared chain runs empty.
      const chain = splitSegments(inputs.scope)[0] ?? "";
      return [
        {
          label: "TX lookup",
          intent: "ONCHAIN_TX_LOOKUP_GENERAL",
          query: `tx=${inputs.ref} · ${chain}`,
          requestUrl: direct("/v1/tx", { tx_hash: inputs.ref, chain }),
          run: (signal) => probe((s) => getTx({ tx_hash: inputs.ref, chain }, s), signal),
        },
      ];
    },
    evaluate: (results) => {
      const [tx] = results;
      const refused = !!tx && (tx.receipt.status === 400 || tx.receipt.status === 422);
      // A 200 with no receipt is a refusal, not an answer (J1 R3 M-a /
      // J2 R4 B1): the lib fails it as INVALID_RESPONSE, status 200.
      // Only a verified 200 (receipt minted) counts as "answered".
      const answered200 = !!tx && isVerified(tx.receipt);
      const why: WhyCard[] = [
        {
          k: "Schema Gate",
          // (J2 R5 B3) The else-branch is reached by ANY non-4xx
          // non-verified outcome — 200-no-receipt, 5xx, timeout
          // (status 0) — so it must not hardcode "HTTP 200". The
          // status is parameterized; status 0 means no HTTP response
          // arrived at all (timeout/network), never a status code.
          v: tx
            ? refused
              ? `refused HTTP ${tx.receipt.status} · ${tx.receipt.errorCode ?? "invalid input"}`
              : answered200
                ? `answered HTTP ${tx.receipt.status} — guard did not refuse`
                : tx.receipt.status === 200
                  ? `refused: HTTP 200 with an unparseable body — no receipt issued`
                  : tx.receipt.status === 0
                    ? `no HTTP response (timeout/network) — no receipt issued`
                    : `HTTP ${tx.receipt.status} — no receipt issued`
            : "not run",
          ok: refused,
        },
        {
          k: "Billing Guard",
          v: !tx
            ? "not run"
            : refused
              ? "HTTP 4xx returned pre-receipt ($0.00 — direct probes are unbilled)"
              : answered200
                ? "unexpected 200 for a malformed hash"
                : tx.receipt.status === 200
                  ? "HTTP 200 with an unparseable body — no receipt, $0.00 billed"
                  : tx.receipt.status === 0
                    ? "no HTTP response (timeout/network) — no receipt, $0.00 billed"
                    : `HTTP ${tx.receipt.status} — no receipt, $0.00 billed`,
          ok: refused,
        },
      ];
      return {
        verdict: refused ? "HOLD" : answered200 ? "REJECT" : "HOLD",
        score: refused ? 100 : 0,
        headline: refused
          ? "Malformed parameter refused cleanly with HTTP 4xx — $0.00 billed."
          : "Malformed hash was answered instead of refused — investigate.",
        why,
      };
    },
  },
  {
    id: "m01-listing",
    mission: "m01",
    tag: "M01 · EXCHANGE",
    title: "Token Listing-Risk Screen",
    sub: "Holder breadth + pool liquidity + supply context, receipted — live",
    // Declared analyst floors, identical to the desk's template E
    // assumptions. Screen thresholds, never market forecasts or advice.
    inputs: {
      entity: "UNI",
      ref: "0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801",
      scope: "ethereum",
    },
    buildChecks: (inputs) => {
      // entity = token symbol; ref = DEX pool address; scope = chain.
      // No silent defaults: a cleared input runs empty and the lib refuses it.
      const symbol = inputs.entity.trim();
      const pool = inputs.ref.trim();
      const chain = inputs.scope.trim();
      return [
        {
          label: "Token holders",
          intent: "TOKEN_HOLDER_COUNT_GENERAL",
          query: `token=${symbol} · chain=${chain}`,
          requestUrl: direct("/v1/token-holders", { token: symbol, chain }),
          run: (signal) => probe((s) => getTokenHolders({ token: symbol, chain }, s), signal),
        },
        {
          label: "Pool liquidity",
          intent: "LIQUIDITY_DEPTH_VERIFY_GENERAL",
          query: `pool=${pool} · chain=${chain}`,
          requestUrl: direct("/v1/liquidity", { pool, chain }),
          run: (signal) => probe((s) => getPoolLiquidity({ pool, chain }, s), signal),
        },
        {
          label: "Token supply",
          intent: "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL",
          query: `token=${symbol} on ${chain}`,
          requestUrl: direct("/v1/token-supply", { token: `${symbol} on ${chain}` }),
          run: (signal) => probe((s) => getTokenSupply({ token: `${symbol} on ${chain}` }, s), signal),
        },
      ];
    },
    evaluate: (results) => {
      const [holders, liquidity, supply] = results;
      const HOLDERS_FLOOR = 100_000;
      const LIQUIDITY_FLOOR_USD = 5_000_000;
      const hBody = holders ? bodyOf<TokenHoldersResponse>(holders) : null;
      const holdersOk = !!holders && isVerified(holders.receipt) && typeof hBody?.holders_count === "number" && hBody.stale !== true;
      const hCount = holdersOk ? hBody!.holders_count! : null;
      const lBody = liquidity ? bodyOf<PoolLiquidityResponse>(liquidity) : null;
      const liquidityOk = !!liquidity && isVerified(liquidity.receipt) && typeof lBody?.liquidity_usd === "number";
      const lUsd = liquidityOk ? lBody!.liquidity_usd! : null;
      const spBody = supply ? bodyOf<TokenSupplyResponse>(supply) : null;
      const supplyOk = !!supply && isVerified(supply.receipt) && typeof spBody?.total_supply === "number";
      const spTotal = supplyOk ? spBody!.total_supply! : null;
      const holdersPass = holdersOk && hCount! >= HOLDERS_FLOOR;
      const liquidityPass = liquidityOk && lUsd! >= LIQUIDITY_FLOOR_USD;
      const why: WhyCard[] = [
        {
          k: "Token Holders",
          v: !holdersOk
            ? "not verified"
            : `${hCount!.toLocaleString("en-US")} distinct holder addresses${hBody?.token_symbol ? ` · ${hBody.token_symbol}` : ""}${hBody?.as_of ? ` · as of ${hBody.as_of}` : ""} — declared floor ${HOLDERS_FLOOR.toLocaleString("en-US")}`,
          ok: holdersPass,
        },
        {
          k: "Pool Liquidity",
          v: !liquidityOk
            ? "not verified"
            : `${formatUsdPrecise(lUsd)} total pool reserves · ${lBody?.pool ?? "pool"} · ${lBody?.chain ?? "?"} — declared floor ${formatUsdPrecise(LIQUIDITY_FLOOR_USD)}`,
          ok: liquidityPass,
        },
        {
          // Context, never a gate: supply breadth informs the screen but
          // no floor applies to it.
          k: "Total Supply (context)",
          v: !supplyOk
            ? "not verified"
            : `${spTotal!.toLocaleString("en-US")}${spBody?.token_symbol ? ` ${spBody.token_symbol}` : ""}${spBody?.chain ? ` · ${spBody.chain}` : ""} — context only, no floor applies`,
          ok: supplyOk ? "na" : false,
        },
      ];
      if (!holdersOk || !liquidityOk || !supplyOk) {
        return {
          verdict: "HOLD",
          score: scoreOf((holdersOk ? 1 : 0) + (liquidityOk ? 1 : 0) + (supplyOk ? 1 : 0), 3),
          headline: "Evidence did not verify — review the rows before relying on this mark.",
          why,
        };
      }
      if (holdersPass && liquidityPass) {
        return {
          verdict: "APPROVE",
          score: 100,
          headline: `Listing-risk screen passed: ${hCount!.toLocaleString("en-US")} holders and ${formatUsdPrecise(lUsd)} pool reserves both clear the declared floors. A screen pass is not an endorsement or investment advice.`,
          why,
        };
      }
      return {
        verdict: "HOLD",
        // All three checks verified; the HOLD is the rule outcome (a
        // declared floor failed), not a failed check.
        score: scoreOf(2, 2),
        headline: `NEEDS REVIEW: ${[!holdersPass ? `holders ${hCount!.toLocaleString("en-US")} below declared floor ${HOLDERS_FLOOR.toLocaleString("en-US")}` : "", !liquidityPass ? `pool reserves ${formatUsdPrecise(lUsd)} below declared floor ${formatUsdPrecise(LIQUIDITY_FLOOR_USD)}` : ""].filter(Boolean).join("; ")}. A screen outcome is not an endorsement or investment advice.`,
        why,
      };
    },
  },
  {
    id: "m14-preflight",
    mission: "m14",
    tag: "M14 · WEB3",
    title: "Token-Risk Preflight",
    // Disclosure: the finalized block is pinned by a direct browser read
    // of a public Ethereum RPC (outside the receipted miner calls). No
    // miner endpoint exposes a bare finalized block; the paid balance
    // probe itself is receipted and pinned to that block.
    sub: "Holders + liquidity floors + contract native-balance probe, receipted — simulated trade · block pinned via a direct public RPC read (outside the receipts)",
    // Declared analyst floors, identical to the desk's template G
    // assumptions. Screen thresholds, never market forecasts or advice.
    inputs: {
      entity: "UNI",
      ref: "0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801",
      scope: "ethereum",
    },
    buildChecks: (inputs) => {
      // entity = token symbol; ref = DEX pool contract; scope = chain.
      // No silent defaults: a cleared input runs empty and the lib refuses it.
      const symbol = inputs.entity.trim();
      const pool = inputs.ref.trim();
      const chain = inputs.scope.trim();
      return [
        {
          label: "Token holders",
          intent: "TOKEN_HOLDER_COUNT_GENERAL",
          query: `token=${symbol} · chain=${chain}`,
          requestUrl: direct("/v1/token-holders", { token: symbol, chain }),
          run: (signal) => probe((s) => getTokenHolders({ token: symbol, chain }, s), signal),
        },
        {
          label: "Pool liquidity",
          intent: "LIQUIDITY_DEPTH_VERIFY_GENERAL",
          query: `pool=${pool} · chain=${chain}`,
          requestUrl: direct("/v1/liquidity", { pool, chain }),
          run: (signal) => probe((s) => getPoolLiquidity({ pool, chain }, s), signal),
        },
        {
          label: "Token supply",
          intent: "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL",
          query: `token=${symbol} on ${chain}`,
          requestUrl: direct("/v1/token-supply", { token: `${symbol} on ${chain}` }),
          run: (signal) => probe((s) => getTokenSupply({ token: `${symbol} on ${chain}` }, s), signal),
        },
        {
          // The block is pinned at run time: the run resolves the current
          // finalized block from a public RPC, then asks the miner for the
          // pool contract's native-coin balance at exactly that block. The
          // static URL omits the block for that reason; the executed URL
          // with the pinned block is shown from the receipt after a run.
          label: "Contract balance",
          intent: "ONCHAIN_METRIC_VERIFY_GENERAL",
          query: `address=${pool} · chain=${chain} · block=<finalized at run>`,
          requestUrl: direct("/v1/onchain-metric", { address: pool, chain }),
          // Everything inside probe(): a failed block resolution (RPC down,
          // CORS, rate limit) or a non-ethereum chain becomes a failed
          // check and a HOLD, never an aborted run.
          run: (signal) =>
            probe(async (s) => {
              if (chain.toLowerCase() !== "ethereum") throw new Error(`unsupported chain ${chain}: the preflight pins its finalized block and contract reads on ethereum`);
              const res = await fetch("https://eth-mainnet.public.blastapi.io", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["finalized", false] }),
                signal: s,
              });
              const j = (await res.json()) as { result?: { number?: string } };
              const n = j?.result?.number;
              if (typeof n !== "string" || !/^0x[0-9a-fA-F]+$/.test(n)) throw new Error("finalized block unavailable");
              const block = BigInt(n).toString(10);
              return getOnchainMetric({ address: pool, block, chain }, s);
            }, signal),
        },
      ];
    },
    evaluate: (results, inputs) => {
      const [holders, liquidity, supply, balance] = results;
      const HOLDERS_FLOOR = 100_000;
      const LIQUIDITY_FLOOR_USD = 5_000_000;
      // The pinned block is resolved from an Ethereum RPC, so the screen
      // only supports ethereum; any other chain input is a clear HOLD.
      const scopeChain = (inputs?.scope ?? "ethereum").trim().toLowerCase();
      if (scopeChain !== "ethereum") {
        return {
          verdict: "HOLD",
          score: 0,
          headline: `NEEDS REVIEW: unsupported chain "${scopeChain}" — this preflight pins its finalized block and contract reads on ethereum; no cross-chain screen is claimed. The simulated purchase is not cleared.`,
          why: [],
        };
      }
      const hBody = holders ? bodyOf<TokenHoldersResponse>(holders) : null;
      const holdersOk = !!holders && isVerified(holders.receipt) && typeof hBody?.holders_count === "number" && hBody.stale !== true;
      const hCount = holdersOk ? hBody!.holders_count! : null;
      const lBody = liquidity ? bodyOf<PoolLiquidityResponse>(liquidity) : null;
      const liquidityOk = !!liquidity && isVerified(liquidity.receipt) && typeof lBody?.liquidity_usd === "number";
      const lUsd = liquidityOk ? lBody!.liquidity_usd! : null;
      const spBody = supply ? bodyOf<TokenSupplyResponse>(supply) : null;
      const supplyOk = !!supply && isVerified(supply.receipt) && typeof spBody?.total_supply === "number";
      const spTotal = supplyOk ? spBody!.total_supply! : null;
      const bBody = balance ? bodyOf<OnchainMetricResponse>(balance) : null;
      // Gate on the exact wei string, never a rounded float: without it
      // the balance is unverified.
      const weiText = typeof bBody?.balance_wei === "string" && /^\d+$/.test(bBody.balance_wei) ? bBody.balance_wei : null;
      const balanceOk = !!balance && isVerified(balance.receipt) && weiText !== null;
      const weiToGwei = (w: string): string => {
        const v = BigInt(w);
        const whole = v / 1_000_000_000n;
        const frac = (v % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
        return frac ? `${whole}.${frac}` : `${whole}`;
      };
      const bGwei = weiText !== null ? weiToGwei(weiText) : null;
      const holdersPass = holdersOk && hCount! >= HOLDERS_FLOOR;
      const liquidityPass = liquidityOk && lUsd! >= LIQUIDITY_FLOOR_USD;
      const balanceExpected = balanceOk && weiText === "0";
      const why: WhyCard[] = [
        {
          k: "Token Holders",
          v: !holdersOk
            ? "not verified"
            : `${hCount!.toLocaleString("en-US")} distinct holder addresses${hBody?.token_symbol ? ` · ${hBody.token_symbol}` : ""}${hBody?.as_of ? ` · as of ${hBody.as_of}` : ""} — declared floor ${HOLDERS_FLOOR.toLocaleString("en-US")}`,
          ok: holdersPass,
        },
        {
          k: "Pool Liquidity",
          v: !liquidityOk
            ? "not verified"
            : `${formatUsdPrecise(lUsd)} total pool reserves · ${lBody?.pool ?? "pool"} · ${lBody?.chain ?? "?"} — declared floor ${formatUsdPrecise(LIQUIDITY_FLOOR_USD)}`,
          ok: liquidityPass,
        },
        {
          k: "Contract Balance",
          v: !balanceOk
            ? "not verified"
            : `${bGwei} gwei (${weiText} wei) native coin held by the pool contract${bBody?.block ? ` · pinned block ${bBody.block}` : ""}${bBody?.checked_at ? ` · as of ${bBody.checked_at}` : ""} — declared expectation 0 gwei; trapped or sent coin is a review trigger, not proof of malice`,
          ok: balanceExpected,
        },
        {
          // Context, never a gate: supply breadth informs the screen but
          // no floor applies to it.
          k: "Total Supply (context)",
          v: !supplyOk
            ? "not verified"
            : `${spTotal!.toLocaleString("en-US")}${spBody?.token_symbol ? ` ${spBody.token_symbol}` : ""}${spBody?.chain ? ` · ${spBody.chain}` : ""} — context only, no floor applies`,
          ok: supplyOk ? "na" : false,
        },
      ];
      const verifiedCount = [holdersOk, liquidityOk, supplyOk, balanceOk].filter(Boolean).length;
      if (!holdersOk || !liquidityOk || !supplyOk || !balanceOk) {
        return {
          verdict: "HOLD",
          score: scoreOf(verifiedCount, 4),
          headline: "Evidence did not verify — the simulated purchase is not cleared. Review the rows before relying on this preflight.",
          why,
        };
      }
      if (!balanceExpected) {
        // A WETH-pool contract holding native coin is unusual: review, not
        // an automatic block. Never a public claim against the token.
        return {
          verdict: "HOLD",
          score: scoreOf(3, 4),
          headline: `NEEDS REVIEW: the pool contract holds ${bGwei} gwei of native coin at the pinned block against a declared expectation of 0. Trapped or sent coin is a review trigger, not proof of malice; the simulated purchase is not cleared.`,
          why,
        };
      }
      if (holdersPass && liquidityPass) {
        return {
          verdict: "APPROVE",
          score: 100,
          headline: `Simulated purchase cleared: ${hCount!.toLocaleString("en-US")} holders and ${formatUsdPrecise(lUsd)} pool reserves clear the declared floors, and the pool contract holds no native coin at the pinned block. Simulated trade only — no wallet, signing or purchase occurs; a screen pass is not an endorsement or investment advice.`,
          why,
        };
      }
      return {
        verdict: "HOLD",
        // All four checks verified and only a declared floor failed: the
        // HOLD is the rule outcome, not a failed check. A screen threshold
        // is never published as a finding about the token.
        score: scoreOf(2, 4),
        headline: `NEEDS REVIEW: ${[!holdersPass ? `holders ${hCount!.toLocaleString("en-US")} below declared floor ${HOLDERS_FLOOR.toLocaleString("en-US")}` : "", !liquidityPass ? `pool reserves ${formatUsdPrecise(lUsd)} below declared floor ${formatUsdPrecise(LIQUIDITY_FLOOR_USD)}` : ""].filter(Boolean).join("; ")}. A screen threshold, not a finding about the token; the simulated purchase is not cleared and no trade occurs.`,
        why,
      };
    },
  },
  {
    id: "m02-settlement",
    mission: "m02",
    tag: "M02 · STABLECOIN",
    title: "Pre-Settlement Compliance Screen",
    sub: "Sanctions screen + attested reserve floor before a simulated transfer, receipted — live",
    // Declared analyst thresholds, identical to the desk's template F
    // assumptions. Screen thresholds, never legal clearance or advice.
    inputs: {
      entity: "Ares Capital Corporation",
      ref: "TUSD",
      scope: "simulated testnet settlement · no funds move",
    },
    buildChecks: (inputs) => {
      // entity = payee name screened; ref = reserve asset symbol. The scope
      // line is display-only: the settlement itself is always simulated and
      // no wallet, signing or transfer exists in this page.
      const payee = inputs.entity.trim();
      const asset = inputs.ref.trim();
      return [
        {
          label: "Sanctions screen",
          intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
          query: `name=${payee}`,
          requestUrl: direct("/v1/sanctions-screen", { name: payee }),
          run: (signal) => probe((s) => getSanctionsScreen({ name: payee }, s), signal),
        },
        {
          label: "Reserve attestation",
          intent: "ASSET_RESERVE_ATTESTATION_GENERAL",
          query: `asset=${asset}`,
          requestUrl: direct("/v1/reserve-attestation", { asset }),
          run: (signal) => probe((s) => getReserveAttestation({ asset }, s), signal),
        },
      ];
    },
    evaluate: (results) => {
      const [sanctions, reserve] = results;
      const SANCTIONS_THRESHOLD = 0.85;
      const RESERVE_FLOOR_MICRO = 100_000_000_000_000; // 100,000,000 whole units
      const sBody = sanctions ? bodyOf<SanctionsScreenResponse>(sanctions) : null;
      const sanctionsOk = !!sanctions && isVerified(sanctions.receipt) && typeof sBody?.match_score === "number";
      const sScore = sanctionsOk ? sBody!.match_score! : null;
      const rBody = reserve ? bodyOf<ReserveAttestationResponse>(reserve) : null;
      // Freshness metadata is part of verification: without feed age and
      // heartbeat the screen cannot prove the attestation is fresh, so the
      // reserve check is unverified and the outcome is HOLD.
      const reserveOk =
        !!reserve &&
        isVerified(reserve.receipt) &&
        typeof rBody?.attested_reserve === "number" &&
        typeof rBody?.feed_age_seconds === "number" &&
        typeof rBody?.heartbeat_seconds === "number";
      const rMicro = reserveOk ? rBody!.attested_reserve! : null;
      const sanctionsHit = sanctionsOk && sScore! >= SANCTIONS_THRESHOLD;
      const stale = reserveOk && rBody!.feed_age_seconds! > rBody!.heartbeat_seconds!;
      const sanctionsPass = sanctionsOk && !sanctionsHit;
      const reservePass = reserveOk && !stale && rMicro! >= RESERVE_FLOOR_MICRO;
      const why: WhyCard[] = [
        {
          k: "Sanctions Screen",
          v: !sanctionsOk
            ? "not verified"
            : sanctionsHit
              ? `MATCH at or above threshold (best ${sScore})${sBody?.checked_at ? ` · as of ${sBody.checked_at}` : ""} — a fuzzy match is not identity confirmation, but it blocks an automatic pass`
              : `best match score ${sScore} · ${sBody?.lists?.length ? `${sBody.lists.length} lists` : "OFAC + UN lists"}${sBody?.checked_at ? ` · as of ${sBody.checked_at}` : ""} — declared threshold ${SANCTIONS_THRESHOLD}; a non-match is not legal clearance`,
          ok: sanctionsPass,
        },
        {
          k: "Attested Reserve",
          v: !reserveOk
            ? "not verified"
            : `${Math.floor(rMicro! / 1e6).toLocaleString("en-US")} whole ${rBody?.asset ?? "units"} attested${rBody?.updated_at ? ` · feed attested ${rBody.updated_at}` : ""} — declared floor ${(RESERVE_FLOOR_MICRO / 1e6).toLocaleString("en-US")} whole units; attested, not audited${stale ? ` · feed age ${rBody!.feed_age_seconds}s exceeds the ${rBody!.heartbeat_seconds}s heartbeat` : ""}`,
          ok: reservePass,
        },
      ];
      if (!sanctionsOk || !reserveOk) {
        return {
          verdict: "HOLD",
          score: scoreOf((sanctionsOk ? 1 : 0) + (reserveOk ? 1 : 0), 2),
          headline: "Evidence did not verify — the simulated settlement is not authorized. Review the rows before relying on this screen.",
          why,
        };
      }
      if (sanctionsHit) {
        // A fuzzy name match is never a REJECT against a named payee: it is
        // a review trigger, so the outcome is HOLD whether or not the
        // reserve floor also failed.
        return {
          verdict: "HOLD",
          score: scoreOf(1, 2),
          headline: `NEEDS REVIEW: payee sanctions score ${sScore} meets the declared ${SANCTIONS_THRESHOLD} threshold — a fuzzy match is not identity confirmation. The simulated settlement is blocked pending review; no funds move.`,
          why,
        };
      }
      if (stale) {
        // A feed older than its heartbeat cannot gate a settlement screen.
        return {
          verdict: "HOLD",
          score: scoreOf(1, 2),
          headline: `NEEDS REVIEW: the reserve attestation is older than its heartbeat (feed age ${rBody!.feed_age_seconds}s > ${rBody!.heartbeat_seconds}s). The figure is attested, not audited; the simulated settlement is not authorized on a stale feed.`,
          why,
        };
      }
      if (sanctionsPass && reservePass) {
        return {
          verdict: "APPROVE",
          score: 100,
          headline: `Simulated settlement authorized: payee screens below the declared ${SANCTIONS_THRESHOLD} sanctions threshold and the reserve clears the declared floor (attested, not audited). No funds move; a screen pass is not legal clearance or investment advice.`,
          why,
        };
      }
      return {
        verdict: "REJECT",
        // Both checks verified and only the declared reserve floor failed:
        // the REJECT is the rule outcome, not a failed check. Fail closed.
        score: scoreOf(2, 2),
        headline: `Simulated settlement blocked: attested reserve ${Math.floor(rMicro! / 1e6).toLocaleString("en-US")} whole units below the declared floor ${(RESERVE_FLOOR_MICRO / 1e6).toLocaleString("en-US")}. This is the declared rule outcome — a floor screen, not a solvency opinion; no funds move.`,
        why,
      };
    },
  },
];
