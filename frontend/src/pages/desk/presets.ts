// Desk workbench presets — scenario definitions only. Every result the
// page shows (verdict, why, per-call cost, receipts) comes from
// POST /api/desk/run at run time; nothing here is a result.
//
// Inputs are the backend's FLAT request fields (routes.ts): M13 takes
// protocol / tx_hash / chain / issuer_entity / period / trade_pair;
// M12 takes node_or_zone / interval_start / breakeven_usd_per_mwh.
// The preset titles name the SCENARIO only — never the expected verdict:
// the server decides APPROVE / HOLD / REJECT (M13) or MINE / CURTAIL /
// HOLD (M12) from the live ranked evidence, and a title that promises an
// outcome before any run is a staged claim.
//
// Live inputs reuse the repo's own verified fixtures (tests/tx.test.ts):
// confirmed tx 0x1b9e2b48… and reverted tx 0x1a146789… (ethereum), and
// the CAISO node TH_NP15_GEN-APND from the Mission Desk presets.
//
// HOLD / REJECT PRESETS ARE DESIGNED TO REACH THE POLICY ON 200s —
// never on a 422. runM13Scenario buys 6 intents sequentially and ANY
// non-2xx aborts the run before the policy runs (503, no verdict), so
// a preset whose inputs 422 can only ever show an error banner:
//   - REJECT preset: the REVERTED counterparty tx (live-verified
//     "reverted" via GET /v1/tx 2026-11-20) with an otherwise clean
//     allocation (aave-v3, issuer AAPL) — the tx_status check rejects,
//     the policy REJECTs.
//   - HOLD preset: a real listed protocol whose live TVL is below the
//     $1M institutional minimum — WingRiders, $674,441 as of
//     2026-11-20T19:58:35Z via GET /v1/tvl (re-checked live
//     2026-11-20T20:29Z; ~33% below the threshold, so ordinary drift
//     does not flip it) — with a confirmed tx and issuer AAPL,
//     so the tvl check holds and the policy HOLDs.
// Both were verified read-only against the live miner before being
// written here; if a live figure drifts across its threshold the
// preset degrades to the server's honest verdict, never to a 503.
//
// SANCTIONS ROUTING DEPENDENCY (honest, do not reword into a claim
// the own miner completes M13 alone): the registered miner (miner
// 774921, miner.yaml supported_intents) serves TX, FILINGS, TVL,
// ROUTE and GRID only. It does NOT serve SANCTIONS_SCREENING_MATCH_
// GENERAL or CRYPTO_PRICE_USD, and there is no sanctions handler in
// the backend — every M13 run, including the approve preset, depends
// on Telegraph's ranked router picking a third-party miner for those
// two intents. If no third-party miner answers one, the run fails
// closed (503, no verdict) through no fault of these inputs.

import { ApiError } from "../../lib/api";
import type { DeskRunRequest } from "../../lib/desk";

export type DeskMission = "M13" | "M12";

/** One editable field on the Desk form. `key` is the flat backend
 *  request field name; `type` drives the input control. */
export interface DeskFieldDef {
  key: string;
  label: string;
  type: "text" | "number";
}

export interface DeskPreset {
  id: string;
  mission: DeskMission;
  tag: string;
  /** Neutral scenario name — no verdict in the label. */
  title: string;
  /** Input description only — what the scenario asks, not what it proves. */
  sub: string;
  fields: DeskFieldDef[];
  /** String form of every field value (number fields parse on submit). */
  inputs: Record<string, string>;
}

const CONFIRMED_TX = "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3";
const REVERTED_TX = "0x1a1467893eaed124a13164b589f1ed7a70ec203257084a7be27eee8f93bd8ba9";

/** A finished settlement interval (2h ago), truncated to the UTC hour,
 *  so the Desk never asks for a future interval — a future interval
 *  must HOLD, never MINE/CURTAIL — and so the interval_start is always
 *  on the CAISO 60-minute settlement boundary. The grid handler rejects
 *  any off-boundary interval with 422 OFF_BOUNDARY_INTERVAL
 *  (startMs % 3,600,000 !== 0); an untruncated now − 2h keeps the
 *  current minutes/seconds and 422s ~3599 seconds out of every hour.
 *  Truncation also keeps the interval finished: it ends a full hour
 *  before now. Exported for tests. */
export function recentIntervalIso(): string {
  const d = new Date(Date.now() - 2 * 60 * 60 * 1000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 19) + "Z";
}

const M13_FIELDS: DeskFieldDef[] = [
  { key: "protocol", label: "Protocol", type: "text" },
  { key: "tx_hash", label: "Counterparty tx hash", type: "text" },
  { key: "chain", label: "Chain", type: "text" },
  { key: "issuer_entity", label: "Issuer / counterparty entity", type: "text" },
  { key: "period", label: "Filing period", type: "text" },
  { key: "trade_pair", label: "Trade pair", type: "text" },
];

const M12_FIELDS: DeskFieldDef[] = [
  { key: "node_or_zone", label: "Pricing node / zone", type: "text" },
  { key: "interval_start", label: "Settlement interval start (ISO-8601 UTC)", type: "text" },
  { key: "breakeven_usd_per_mwh", label: "Break-even ($/MWh)", type: "number" },
];

export const DESK_PRESETS: DeskPreset[] = [
  {
    id: "m13-institutional-defi",
    mission: "M13",
    tag: "M13 · ALLOCATION",
    title: "Institutional DeFi allocation",
    sub: "aave-v3, confirmed counterparty tx, issuer filing cross-check — ranked escrow",
    fields: M13_FIELDS,
    inputs: {
      protocol: "aave-v3",
      tx_hash: CONFIRMED_TX,
      chain: "ethereum",
      issuer_entity: "AAPL",
      period: "last 12 months",
      trade_pair: "ETH/USDC",
    },
  },
  {
    id: "m13-thin-tvl",
    mission: "M13",
    tag: "M13 · ALLOCATION",
    title: "Thin-TVL protocol allocation",
    sub: "WingRiders live TVL $674,441 as of 2026-11-20T19:58:35Z — below the $1M institutional minimum; confirmed tx, issuer AAPL — ranked escrow",
    fields: M13_FIELDS,
    inputs: {
      protocol: "wingriders",
      tx_hash: CONFIRMED_TX,
      chain: "ethereum",
      issuer_entity: "AAPL",
      period: "last 12 months",
      trade_pair: "ETH/USDC",
    },
  },
  {
    id: "m13-reverted-counterparty-tx",
    mission: "M13",
    tag: "M13 · ALLOCATION",
    title: "Counterparty transaction check",
    sub: "Allocation gated on a reverted reference transaction — ranked escrow",
    fields: M13_FIELDS,
    inputs: {
      protocol: "aave-v3",
      tx_hash: REVERTED_TX,
      chain: "ethereum",
      issuer_entity: "AAPL",
      period: "last 12 months",
      trade_pair: "ETH/USDC",
    },
  },
  {
    id: "m12-grid-low-breakeven",
    mission: "M12",
    tag: "M12 · DISPATCH",
    title: "Grid dispatch — low break-even",
    sub: "CAISO NP15 live LMP gated on a $10/MWh break-even — the server decides",
    fields: M12_FIELDS,
    inputs: {
      node_or_zone: "TH_NP15_GEN-APND",
      interval_start: recentIntervalIso(),
      breakeven_usd_per_mwh: "10",
    },
  },
  {
    id: "m12-grid-high-breakeven",
    mission: "M12",
    tag: "M12 · DISPATCH",
    title: "Grid dispatch — high break-even",
    sub: "CAISO NP15 live LMP gated on a $500/MWh break-even — the server decides",
    fields: M12_FIELDS,
    inputs: {
      node_or_zone: "TH_NP15_GEN-APND",
      interval_start: recentIntervalIso(),
      breakeven_usd_per_mwh: "500",
    },
  },
];

/** Build the flat POST /api/desk/run request for a preset + the
 *  user-edited field values. Throws ApiError (INVALID_PARAM) on a
 *  missing/ill-typed field instead of sending a request the backend
 *  would reject. */
export function presetRunRequest(
  preset: DeskPreset,
  inputs: Record<string, string>,
): DeskRunRequest {
  const missing = (key: string) =>
    new ApiError(`Invalid parameter "inputs": ${key} is required`, 400, "INVALID_PARAM");
  const text = (key: string): string => {
    const value = (inputs[key] ?? "").trim();
    if (!value) throw missing(key);
    return value;
  };
  if (preset.mission === "M13") {
    return {
      mission: "M13",
      scenario_id: preset.id,
      protocol: text("protocol"),
      tx_hash: text("tx_hash"),
      chain: text("chain"),
      issuer_entity: text("issuer_entity"),
      period: text("period"),
      trade_pair: text("trade_pair"),
    };
  }
  const breakeven = Number((inputs["breakeven_usd_per_mwh"] ?? "").trim());
  if (!Number.isFinite(breakeven) || breakeven <= 0) {
    throw new ApiError(
      'Invalid parameter "inputs": breakeven_usd_per_mwh must be a positive number',
      400,
      "INVALID_PARAM",
    );
  }
  return {
    mission: "M12",
    scenario_id: preset.id,
    node_or_zone: text("node_or_zone"),
    interval_start: text("interval_start"),
    breakeven_usd_per_mwh: breakeven,
  };
}
