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

import { getFilings, getGridPrice, getRoute, getTvl, getTx } from "../../lib/api";
import type { FilingsResponse, GridPriceResponse, LiveReceipt, ProbeOutcome, RouteResponse, TvlResponse, TxResponse } from "./types";
import { formatUsd, formatUsdPrecise, isVerified, probe, recentGridInterval } from "./utils";

export type MissionId = "m13" | "m12";
export type DeskVerdict = "APPROVE" | "REJECT" | "HOLD";

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
  /** Derive the verdict from the settled live results. */
  evaluate: (results: DeskCheckResult[]) => DeskEvaluation;
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
          k: "SEC Compliance",
          // (J2 R5 B2) Never interpolate a refusal body: probe()
          // synthesizes {error, message} on refusal, so a bare
          // `filingsBody ?` is truthy on ANY refusal and rendered
          // "undefined filings for undefined". Render the count only
          // on a verified receipt with a typed filing_count (a
          // verified 0 is a real answer) and a typed entity.
          v:
            filings && isVerified(filings.receipt) && typeof filingsBody?.filing_count === "number" && typeof filingsBody?.entity === "string"
              ? `${filingsBody.filing_count} filings for ${filingsBody.entity}`
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
          v: tvl
            ? isVerified(tvl.receipt)
              ? `live TVL ${formatUsd(tvlBody?.tvl_usd ?? null)}`
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
    title: "SEC 10-K Compliance Audit",
    sub: "AAPL official EDGAR submissions + execution cross-check — live",
    inputs: {
      entity: "AAPL",
      ref: "CIK 0000320193",
      scope: "last 12 months · SEC EDGAR",
    },
    buildChecks: (inputs) => {
      // No silent defaults (see m13-defi): a cleared period runs empty.
      const period = splitSegments(inputs.scope)[0] ?? "";
      return [
        {
          label: "SEC filing",
          intent: "REGULATORY_FILING_MONITOR_GENERAL",
          query: `${inputs.entity} · ${period}`,
          requestUrl: direct("/v1/filings", { entity: inputs.entity, period }),
          run: (signal) => probe((s) => getFilings({ entity: inputs.entity, period }, s), signal),
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
    evaluate: (results) => {
      const [filings, route] = results;
      const filingsBody = filings ? bodyOf<FilingsResponse>(filings) : null;
      const filingsOk =
        !!filings && isVerified(filings.receipt) && typeof filingsBody?.filing_count === "number" && filingsBody.filing_count > 0;
      const routeBody = route ? bodyOf<RouteResponse>(route) : null;
      const routeOk = !!route && isVerified(route.receipt) && typeof routeBody?.amount_out === "number" && routeBody.amount_out > 0;
      const why: WhyCard[] = [
        {
          k: "Official EDGAR",
          // (J2 R5 B2) Same refusal-body trap as m13-defi "SEC
          // Compliance": gate on a verified receipt + typed fields.
          v:
            filings && isVerified(filings.receipt) && typeof filingsBody?.filing_count === "number" && typeof filingsBody?.entity === "string"
              ? `${filingsBody.filing_count} filings for ${filingsBody.entity} in period`
              : "no live filings returned",
          ok: filingsOk,
        },
        {
          k: "URL Provenance",
          v:
            filingsBody && Array.isArray(filingsBody.urls) && filingsBody.urls.length > 0
              ? `${filingsBody.urls.length} archive URL(s) on sec.gov`
              : "no archive URLs returned",
          ok: filingsBody !== null && Array.isArray(filingsBody.urls) && filingsBody.urls.length > 0,
        },
        {
          k: "Route Execution",
          v: routeBody && typeof routeBody.amount_out === "number" ? `${(routeBody.amount_out / 1e6).toFixed(2)} USDC / 1 ETH` : "no live route returned",
          ok: routeOk,
        },
      ];
      const passes = [filingsOk, routeOk].filter(Boolean).length;
      return {
        verdict: passes === 2 ? "APPROVE" : "HOLD",
        score: scoreOf(passes, 2),
        headline:
          passes === 2
            ? "Issuer filings current and verified verbatim against data.sec.gov."
            : "Filings or route check did not verify — review the rows before acting.",
        why,
      };
    },
  },
  {
    id: "m12-curtail",
    mission: "m12",
    tag: "M12 · MINING POWER",
    title: "Grid LMP Dispatch Check",
    sub: "Live CAISO wholesale LMP + ETH/USDC execution cross-check",
    inputs: {
      entity: "CAISO OASIS · Mining Fleet",
      ref: "TH_NP15_GEN-APND",
      scope: `${recentGridInterval()} · no curtailment threshold configured`,
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
    evaluate: (results) => {
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
          // finite numeric LMP and a typed zone.
          v:
            grid && isVerified(grid.receipt) && typeof gridBody?.lmp_usd_per_mwh === "number" && Number.isFinite(gridBody.lmp_usd_per_mwh) && typeof gridBody?.node_or_zone === "string"
              ? `${formatUsdPrecise(gridBody.lmp_usd_per_mwh)} / MWh · ${gridBody.market ?? ""} · ${gridBody.node_or_zone}`
              : "no live LMP returned",
          ok: gridOk,
        },
        {
          k: "Curtailment Threshold",
          v: "No threshold configured in this build — the design's $85/MWh ceiling has no source (DESIGN-SPEC §8 A4). LMP is reported live, no curtail decision is derived.",
          // (J2 R5) Not a check: there is no threshold to pass or
          // fail, so neither PASS nor GATE is honest. "na" renders an
          // N/A badge (MissionDesk) and is excluded from the pass
          // count (passes counts gridOk + routeOk only).
          ok: "na",
        },
        {
          k: "ETH Hedge Check",
          v: routeBody && typeof routeBody.amount_out === "number" ? `${(routeBody.amount_out / 1e6).toFixed(2)} USDC / 1 ETH verified` : "no live route returned",
          ok: routeOk,
        },
      ];
      const passes = [gridOk, routeOk].filter(Boolean).length;
      return {
        verdict: passes === 2 ? "APPROVE" : "HOLD",
        score: scoreOf(passes, 2),
        headline:
          passes === 2
            ? `Wholesale LMP ${formatUsdPrecise(gridBody?.lmp_usd_per_mwh ?? null)} / MWh verified live at ${gridBody?.node_or_zone}.`
            : "Grid or route check did not verify — review the rows before acting.",
        why,
      };
    },
  },
  {
    id: "m13-422",
    mission: "m13",
    tag: "M13 · FAIL-CLOSED 422",
    title: "Fail-Closed 422 Refusal Probe",
    sub: "Malformed tx hash 0x1234 refused before any receipt — live",
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
];
