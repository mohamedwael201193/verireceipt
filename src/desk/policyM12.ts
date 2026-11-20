// VeriReceipt Desk — Mission 12 Mining Power Dispatch gate (policyM12.ts).
//
// Pure deterministic policy: NO network, NO LLM, NO invented values.
// Inputs are the facility's pricing node, settlement interval, and
// hashprice break-even threshold, plus evidence bought live from Telegraph
// ranked intents (GRID_POWER_PRICE_GENERAL + MINING_HASHPRICE_VERIFY_GENERAL).
// The policy only reads the evidence it is handed; it never fetches,
// estimates, or backfills.
//
// Verdicts: MINE / CURTAIL / HOLD. Fail-closed by construction:
//   - unfinished or future settlement interval -> HOLD (no price exists yet)
//   - location mismatch between the requested node and the evidence -> HOLD
//   - missing/unusable grid price or hashprice evidence -> HOLD
//   - price within the 5% deadband around break-even -> HOLD (too close to call)
//   - MINE / CURTAIL only when every check passes and the price clears the
//     deadband on one side.
//
// FAIL-CLOSED MAP (omitted required field -> HOLD, never a pass):
//   grid.interval_start missing          -> hold (no interval to bind)
//   grid.interval_start != requested     -> hold (price belongs to another interval)
//   hashprice.block_height missing       -> hold (no block to bind)
//   hashprice.block_height != tip height used for the ask -> hold
//   expected block height not supplied by the caller -> unverifiable (HOLD:
//     the binding cannot be checked, so the verdict cannot clear)
//   grid.node_or_zone missing            -> unverifiable (HOLD)
//   grid.node != requested node          -> hold (HOLD)
//   lmp missing / currency missing / currency != USD -> unverifiable / hold / hold (HOLD:
//     a price with no known denomination cannot be compared with a USD/MWh break-even)
//   hashprice figure missing             -> unverifiable (HOLD)
// Every check always emits a non-empty reason (the UI contract).
// The caller MUST pass the Bitcoin tip height the hashprice ask was
// bought with (opts.expectedBlockHeight); without it the block check
// cannot run and the verdict is HOLD by construction.
//
// Thresholds (documented here — change them here, not in a caller):
//   - Settlement interval length: 60 minutes. An interval is finished only
//     when now >= interval_start + 60 min.
//   - Dispatch deadband: 5% of break-even. LMP <= 0.95 * break-even -> MINE;
//     LMP >= 1.05 * break-even -> CURTAIL; inside -> HOLD.

import { ApiError, badRequest } from "../core/errors";

export type M12Verdict = "MINE" | "CURTAIL" | "HOLD";

export type M12CheckStatus = "pass" | "hold" | "unverifiable";

export interface M12Check {
  id: string;
  name: string;
  status: M12CheckStatus;
  reason: string;
  detail?: string;
}

export interface M12Input {
  node_or_zone: string;
  interval_start: string;
  breakeven_usd_per_mwh: number;
}

export interface M12GridEvidence {
  lmp_usd_per_mwh?: number;
  node_or_zone?: string;
  market?: string;
  interval_start?: string;
  currency?: string;
}

export interface M12HashpriceEvidence {
  hashprice_sats_per_ph_day?: number;
  hashprice_usd_per_ph_day?: number;
  block_height?: number;
}

export interface M12Evidence {
  grid?: M12GridEvidence | null;
  hashprice?: M12HashpriceEvidence | null;
}

export interface M12Result {
  verdict: M12Verdict;
  checks: M12Check[];
  /** Explainability Why box: one plain line per check, in check order. */
  why: string[];
  input: M12Input;
}

/** Settlement interval length in milliseconds (hourly intervals). */
export const M12_INTERVAL_MS = 60 * 60 * 1000;
/** Deadband around break-even, as a fraction (5%). */
export const M12_DEADBAND = 0.05;

const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Validate the scenario inputs. Throws ApiError 400 — never a verdict. */
export function validateM12Input(input: M12Input): M12Input {
  const node = (input.node_or_zone ?? "").trim();
  const interval = (input.interval_start ?? "").trim();
  const breakeven = input.breakeven_usd_per_mwh;

  if (!node) throw badRequest("INVALID_NODE", "node_or_zone must be a non-empty string");
  if (node.length > 128) {
    throw badRequest("INVALID_NODE", "node_or_zone must be at most 128 characters");
  }
  if (!ISO_RE.test(interval) || Number.isNaN(Date.parse(interval))) {
    throw badRequest(
      "INVALID_INTERVAL",
      "interval_start must be a valid ISO-8601 UTC datetime (e.g. 2026-11-19T00:00:00Z)",
    );
  }
  if (typeof breakeven !== "number" || !Number.isFinite(breakeven) || breakeven <= 0) {
    throw badRequest(
      "INVALID_BREAKEVEN",
      "breakeven_usd_per_mwh must be a positive finite number ($/MWh)",
    );
  }
  return { node_or_zone: node, interval_start: interval, breakeven_usd_per_mwh: breakeven };
}

function checkIntervalFinished(input: M12Input, nowMs: number): M12Check {
  const base = { id: "interval_finished", name: "Settlement interval finished" };
  const startMs = Date.parse(input.interval_start);
  if (startMs > nowMs) {
    return {
      ...base,
      status: "hold",
      reason: `Settlement interval ${input.interval_start} starts in the future — no settlement price exists yet.`,
    };
  }
  if (nowMs < startMs + M12_INTERVAL_MS) {
    return {
      ...base,
      status: "hold",
      reason: `Settlement interval starting ${input.interval_start} is not finished yet (ends ${new Date(startMs + M12_INTERVAL_MS).toISOString()}).`,
    };
  }
  return {
    ...base,
    status: "pass",
    reason: `Settlement interval starting ${input.interval_start} is finished.`,
  };
}

function checkIntervalMatch(input: M12Input, ev: M12Evidence): M12Check {
  const base = { id: "interval_match", name: "Evidence interval matches requested interval" };
  const grid = ev.grid ?? null;
  if (!grid || typeof grid.interval_start !== "string" || !grid.interval_start) {
    return {
      ...base,
      status: "hold",
      reason: "Grid evidence names no settlement interval, so the price cannot be bound to the requested interval.",
    };
  }
  const evMs = Date.parse(grid.interval_start);
  const reqMs = Date.parse(input.interval_start);
  if (Number.isNaN(evMs)) {
    return {
      ...base,
      status: "hold",
      reason: `Grid evidence interval "${grid.interval_start}" is not a parseable datetime, so it cannot be bound to the requested interval.`,
    };
  }
  if (evMs !== reqMs) {
    return {
      ...base,
      status: "hold",
      reason: `Grid evidence is for interval ${grid.interval_start}, not the requested ${input.interval_start} — the price belongs to another settlement interval.`,
    };
  }
  return {
    ...base,
    status: "pass",
    reason: `Grid evidence is for the requested settlement interval ${input.interval_start}.`,
  };
}

function checkLocation(input: M12Input, ev: M12Evidence): M12Check {
  const base = { id: "location", name: "Evidence location matches requested node" };
  const grid = ev.grid ?? null;
  if (!grid || typeof grid.node_or_zone !== "string" || !grid.node_or_zone) {
    return {
      ...base,
      status: "unverifiable",
      reason: "Grid evidence names no pricing node, so the location cannot be checked.",
    };
  }
  if (grid.node_or_zone.trim().toLowerCase() !== input.node_or_zone.toLowerCase()) {
    return {
      ...base,
      status: "hold",
      reason: `Grid evidence is for node "${grid.node_or_zone}", not the requested "${input.node_or_zone}" — the price belongs to another location.`,
    };
  }
  return {
    ...base,
    status: "pass",
    reason: `Grid evidence is for the requested node "${input.node_or_zone}".`,
  };
}

function checkGridPrice(input: M12Input, ev: M12Evidence): M12Check {
  const base = { id: "grid_price", name: "Grid price available" };
  const grid = ev.grid ?? null;
  const lmp = grid?.lmp_usd_per_mwh;
  if (typeof lmp !== "number" || !Number.isFinite(lmp)) {
    return {
      ...base,
      status: "unverifiable",
      reason: "Grid evidence carries no usable locational marginal price (USD/MWh).",
    };
  }
  // A price with no stated currency is neither USD nor verifiably
  // anything else: its denomination is unknown, so it cannot be
  // compared with a USD/MWh break-even. Fail closed (hold), exactly
  // as for a non-USD currency.
  if (typeof grid?.currency !== "string" || !grid.currency.trim()) {
    return {
      ...base,
      status: "hold",
      reason: "Grid price names no currency, so it cannot be compared with a USD/MWh break-even.",
    };
  }
  if (grid.currency.toUpperCase() !== "USD") {
    return {
      ...base,
      status: "hold",
      reason: `Grid price is quoted in ${grid.currency}, not USD — it cannot be compared with a USD/MWh break-even.`,
    };
  }
  return {
    ...base,
    status: "pass",
    reason: `Locational marginal price is $${lmp.toLocaleString("en-US", { maximumFractionDigits: 2 })} / MWh${grid?.market ? ` (${grid.market})` : ""}.`,
  };
}

function checkHashprice(input: M12Input, ev: M12Evidence): M12Check {
  const base = { id: "hashprice", name: "Hashprice evidence available" };
  const h = ev.hashprice ?? null;
  if (!h) {
    return {
      ...base,
      status: "unverifiable",
      reason: "No hashprice evidence was returned, so mining economics cannot be corroborated.",
    };
  }
  const usd = h.hashprice_usd_per_ph_day;
  const sats = h.hashprice_sats_per_ph_day;
  const hasUsd = typeof usd === "number" && Number.isFinite(usd) && usd > 0;
  const hasSats = typeof sats === "number" && Number.isFinite(sats) && sats > 0;
  if (!hasUsd && !hasSats) {
    return {
      ...base,
      status: "unverifiable",
      reason: "Hashprice evidence carries no usable hashprice figure (USD or sats per PH/s per day).",
    };
  }
  // hasUsd / hasSats guard the non-null assertions below.
  let reason: string;
  if (hasUsd && hasSats) {
    reason = `Hashprice $${usd!.toLocaleString("en-US", { maximumFractionDigits: 2 })} / PH/s / day (${sats!.toLocaleString("en-US")} sats).`;
  } else if (hasUsd) {
    reason = `Hashprice $${usd!.toLocaleString("en-US", { maximumFractionDigits: 2 })} / PH/s / day.`;
  } else {
    reason = `Hashprice ${sats!.toLocaleString("en-US")} sats / PH/s / day.`;
  }
  return {
    ...base,
    status: "pass",
    reason,
    detail: h.block_height !== undefined ? `block ${h.block_height}` : undefined,
  };
}

function checkHashpriceBlock(
  input: M12Input,
  ev: M12Evidence,
  expectedBlockHeight: number | undefined,
): M12Check {
  const base = { id: "hashprice_block", name: "Hashprice evidence block matches tip height" };
  if (expectedBlockHeight === undefined) {
    return {
      ...base,
      status: "unverifiable",
      reason: "No expected Bitcoin tip height was supplied with this evaluation, so the hashprice block cannot be bound to the ask.",
    };
  }
  const h = ev.hashprice ?? null;
  if (!h || typeof h.block_height !== "number" || !Number.isFinite(h.block_height)) {
    return {
      ...base,
      status: "hold",
      reason: "Hashprice evidence names no block height, so it cannot be bound to the tip height the ask was bought with.",
    };
  }
  if (h.block_height !== expectedBlockHeight) {
    return {
      ...base,
      status: "hold",
      reason: `Hashprice evidence is for block ${h.block_height}, not the tip height ${expectedBlockHeight} the ask was bought with — the figure belongs to another block.`,
    };
  }
  return {
    ...base,
    status: "pass",
    reason: `Hashprice evidence is for the tip height ${expectedBlockHeight} the ask was bought with.`,
    detail: `block ${h.block_height}`,
  };
}

function checkDispatch(input: M12Input, ev: M12Evidence): M12Check & { side?: "MINE" | "CURTAIL" } {
  const base = { id: "dispatch", name: "Dispatch economics vs break-even" };
  const lmp = ev.grid?.lmp_usd_per_mwh;
  const be = input.breakeven_usd_per_mwh;
  if (typeof lmp !== "number" || !Number.isFinite(lmp)) {
    return {
      ...base,
      status: "unverifiable",
      reason: "No grid price to compare with the break-even threshold.",
    };
  }
  const low = be * (1 - M12_DEADBAND);
  const high = be * (1 + M12_DEADBAND);
  if (lmp <= low) {
    return {
      ...base,
      status: "pass",
      side: "MINE",
      reason: `Price $${lmp.toLocaleString("en-US", { maximumFractionDigits: 2 })} / MWh is at or below $${low.toLocaleString("en-US", { maximumFractionDigits: 2 })} (break-even $${be} minus ${(M12_DEADBAND * 100).toFixed(0)}% deadband) — mining clears its power cost.`,
    };
  }
  if (lmp >= high) {
    return {
      ...base,
      status: "pass",
      side: "CURTAIL",
      reason: `Price $${lmp.toLocaleString("en-US", { maximumFractionDigits: 2 })} / MWh is at or above $${high.toLocaleString("en-US", { maximumFractionDigits: 2 })} (break-even $${be} plus ${(M12_DEADBAND * 100).toFixed(0)}% deadband) — power costs more than mining earns.`,
    };
  }
  return {
    ...base,
    status: "hold",
    reason: `Price $${lmp.toLocaleString("en-US", { maximumFractionDigits: 2 })} / MWh is within ${(M12_DEADBAND * 100).toFixed(0)}% of break-even $${be} / MWh ($${low.toLocaleString("en-US", { maximumFractionDigits: 2 })}–$${high.toLocaleString("en-US", { maximumFractionDigits: 2 })}) — too close to call.`,
  };
}

export interface M12EvaluateOpts {
  /** Injectable "now" for tests (defaults to Date.now()). */
  nowMs?: number;
  /**
   * Bitcoin tip height the hashprice ask was bought with. REQUIRED for a
   * clearing verdict: without it the hashprice-block check is
   * unverifiable and the verdict is HOLD.
   */
  expectedBlockHeight?: number;
}

/**
 * Evaluate a Mission 12 dispatch. Pure function: no I/O, no randomness.
 * `optsOrNowMs` accepts either a millisecond timestamp (legacy callers
 * and tests) or an { nowMs, expectedBlockHeight } options object.
 * Throws ApiError on invalid inputs (400) — a refusal, never a verdict.
 */
export function evaluateM12(
  rawInput: M12Input,
  evidence: M12Evidence,
  optsOrNowMs?: number | M12EvaluateOpts,
): M12Result {
  const input = validateM12Input(rawInput);
  const opts: M12EvaluateOpts =
    typeof optsOrNowMs === "number" ? { nowMs: optsOrNowMs } : (optsOrNowMs ?? {});
  const nowMs = opts.nowMs ?? Date.now();
  const interval = checkIntervalFinished(input, nowMs);
  const intervalMatch = checkIntervalMatch(input, evidence);
  const location = checkLocation(input, evidence);
  const gridPrice = checkGridPrice(input, evidence);
  const hashprice = checkHashprice(input, evidence);
  const hashpriceBlock = checkHashpriceBlock(input, evidence, opts.expectedBlockHeight);
  const dispatch = checkDispatch(input, evidence);
  const checks: M12Check[] = [
    interval,
    intervalMatch,
    location,
    gridPrice,
    hashprice,
    hashpriceBlock,
    dispatch,
  ];

  let verdict: M12Verdict = "HOLD";
  const blocked = checks.some((c) => c.status === "hold" || c.status === "unverifiable");
  if (!blocked && dispatch.side) verdict = dispatch.side;

  const why = checks.map(
    (c) => `${c.status === "pass" ? "PASS" : c.status.toUpperCase()} — ${c.name}: ${c.reason}`,
  );
  return { verdict, checks, why, input };
}
