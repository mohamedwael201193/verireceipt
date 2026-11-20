// VeriReceipt Desk API client — Track 3 workbench.
//
// CONTRACT — the real Desk backend as built in
// ~/workspace/verireceipt-desk/backend/src/desk/ (routes.ts, ledger.ts,
// scenarios.ts, mcp.ts). The shapes below are copied from that code, not
// from the blueprint: an earlier version of this file invented its own
// request/response shapes (lowercase mission, nested `inputs`, `spend_usdc`,
// `receipts[]`, `latency_ms`, `payer_balance_usdc`, `page_size`) and every
// real backend reply failed its parsers. Those invented shapes are deleted;
// the parsers below accept ONLY the real backend shapes and fail closed
// on anything else.
//
//   POST /api/desk/run
//     M13: { mission: "M13", scenario_id, protocol, tx_hash, chain,
//            issuer_entity, period, trade_pair }            (FLAT fields)
//     M12: { mission: "M12", scenario_id, node_or_zone, interval_start,
//            breakeven_usd_per_mwh }
//     -> { run_id, mission, scenario_id, verdict, checks[{id,name,status,
//            reason,detail?}], why[], calls[{intent, params, miner_id,
//            miner_name, signal_hash, receipt_hash, cost_uusdc, rail,
//            fetched_at, signal_url}], total_cost_uusdc, total_cost_usd,
//            related_party: true, disclosure }
//     verdicts: M13 APPROVE | HOLD | REJECT; M12 MINE | CURTAIL | HOLD
//     (enforced by parseDeskRunResponse — a cross-mission verdict, an
//     empty checks[], an empty why[], an empty calls[], a negative cost,
//     an unparseable fetched_at, or ANY fetched_at in the future is
//     INVALID_RESPONSE, never rendered — round 4, F3: the tolerance is
//     zero, see DESK_FETCHED_AT_CLOCK_SKEW_MS below). Round 7, F1: a
//     verdict that contradicts its own check statuses is also
//     INVALID_RESPONSE — the backend derives the verdict from the
//     statuses alone (policyM13.ts:558-560, policyM12.ts:391-393), so
//     e.g. APPROVE beside a reject check can never be a real reply.
//     There is no `receipts[]`, no per-call `status`/`latency_ms`, no
//     `miner`/`cost_usdc` — a call carries miner_id/miner_name,
//     cost_uusdc, rail and fetched_at.
//   GET  /api/desk/ledger?page=1&limit=20
//     -> { page, limit, total, runs[] } — rows are PER-CALL
//        ({id, run_id, mission, scenario_id, intent, miner_id, miner_name,
//        signal_hash, signal_url, receipt_hash, cost_uusdc, cost_usd, rail,
//        verdict, related_party, fetched_at, verification_status}).
//        No `page_size`, no per-run spend/call_count/created_at/preset_id.
//   GET  /api/desk/stats
//     -> { payer_address, diamond, network, chain, escrow, runway_checks,
//            runway_label, spend{...}, spend_today{day,calls,cost_uusdc,
//            cost_usd}, caps{free_checks_per_ip_per_day,
//            daily_global_cap_usd, cost_per_check_usd},
//            related_party_disclosure }
//     None of payer_balance_usdc / funded_for_checks / spent_today_usdc
//     exists. runway_checks / runway_label are null when no payer is
//     configured; escrow is null or the ledger-account object.
//
// PATH / REMOUNT NOTE (coordinator-owned, pending): this client keeps
// calling SAME-ORIGIN /api/desk/* — the vite dev proxy and the Vercel
// rewrite both strip the /api prefix, so on Render the call arrives as
// /desk/* . That is correct ONLY AFTER the backend remounts from
// /api/desk/* + /api/mcp to /desk/* + /mcp (coordinated alignment change,
// pending at the time of writing). Until that backend deploy lands the
// Desk endpoints are NOT live: a call to /api/desk/stats reaches Render
// as /desk/stats and 404s against the not-yet-remounted backend. Never
// present these endpoints as callable-live until the remount is deployed.
//
// No invented numbers: every balance, cost and verdict shown comes from
// one of the three endpoints above. A missing/unreachable endpoint is an
// error state, never a fabricated fallback.

import { ApiError, MAX_RESPONSE_BODY_BYTES } from "./api";
import { hasVisibleCharacter } from "./format";

export const DESK_RUN_TIMEOUT_MS = 120_000;
export const DESK_STATS_TIMEOUT_MS = 15_000;
export const DESK_LEDGER_PAGE_SIZE = 20;

/** Clock-skew tolerance for a Desk call's fetched_at (round 4, F3):
 *  ZERO. Round 3 allowed 5 minutes on a "miner/client clock skew"
 *  rationale that was factually wrong: fetched_at is stamped by the
 *  backend itself (backend/src/desk/telegraphClient.ts:429, toAskResult
 *  sets `fetched_at: new Date().toISOString()`), so the miner's clock
 *  is never involved, and a repo-wide grep found zero evidence of
 *  minutes of skew anywhere. The only clock difference that could
 *  exist is Render-server clock vs browser clock, which is unmeasured
 *  — so no tolerance is justified and any future stamp is
 *  INVALID_RESPONSE, never rendered: a future-dated call would render
 *  a "Delivery epoch pending" window in the future and future-stamped
 *  stream lines. Kept as a named constant (value 0) so the rule stays
 *  explicit and greppable at the single check site below. */
export const DESK_FETCHED_AT_CLOCK_SKEW_MS = 0;

/** Telegraph devnode signal proof — the ONLY signal URL the UI ever
 *  links. Never explorer.telegraphprotocol.com (dead 404s). */
export const SIGNAL_BASE_URL = "https://devnode.telegraphprotocol.com/engine/v1/signal";

export function signalUrl(signalHash: string): string {
  return `${SIGNAL_BASE_URL}/${signalHash}`;
}

export type DeskVerdict = "APPROVE" | "HOLD" | "REJECT" | "MINE" | "CURTAIL";

/** Verdicts each mission may return (desk.ts header contract). The
 *  parser enforces the mapping: a cross-mission verdict (M12 +
 *  APPROVE, M13 + MINE) is a malformed response, never rendered. */
export const DESK_VERDICTS_BY_MISSION: Record<"M13" | "M12", DeskVerdict[]> = {
  M13: ["APPROVE", "HOLD", "REJECT"],
  M12: ["MINE", "CURTAIL", "HOLD"],
};

export const DESK_VERDICTS: DeskVerdict[] = ["APPROVE", "HOLD", "REJECT", "MINE", "CURTAIL"];

export function isDeskVerdict(value: unknown): value is DeskVerdict {
  return typeof value === "string" && (DESK_VERDICTS as string[]).includes(value);
}

export type DeskCheckStatus = "pass" | "hold" | "reject" | "unverifiable" | "skipped";

export const DESK_CHECK_STATUSES: DeskCheckStatus[] = [
  "pass",
  "hold",
  "reject",
  "unverifiable",
  "skipped",
];

export function isDeskCheckStatus(value: unknown): value is DeskCheckStatus {
  return typeof value === "string" && (DESK_CHECK_STATUSES as string[]).includes(value);
}

export interface DeskCheck {
  id: string;
  name: string;
  status: DeskCheckStatus;
  reason: string;
  detail?: string;
}

/** One ranked escrow call, exactly as the backend returns it
 *  (scenarios.ts ScenarioCallRecord + signal_url; routes.ts). */
export interface DeskCall {
  intent: string;
  params: Record<string, unknown>;
  miner_id: string | null;
  miner_name: string | null;
  /** Null on an unbilled refusal — no signal link is rendered then. */
  signal_hash: string | null;
  receipt_hash: string | null;
  cost_uusdc: number;
  rail: string;
  /** ISO-8601 fetch time — the ONLY timestamp a call carries. The UI
   *  uses this for stream/summary lines, never the render time. */
  fetched_at: string;
  signal_url: string | null;
}

export interface DeskRunResponse {
  run_id: string;
  mission: "M13" | "M12";
  scenario_id: string;
  verdict: DeskVerdict;
  checks: DeskCheck[];
  why: string[];
  calls: DeskCall[];
  total_cost_uusdc: number;
  total_cost_usd: number;
  related_party: true;
  disclosure: string;
}

/** POST /api/desk/run request — FLAT fields, UPPERCASE mission
 *  (routes.ts: mission must be "M13" or "M12"; lowercase trips
 *  INVALID_MISSION). scenario_id is the ledger label for the run. */
export type DeskRunRequest =
  | {
      mission: "M13";
      scenario_id: string;
      protocol: string;
      tx_hash: string;
      chain: string;
      issuer_entity: string;
      period: string;
      trade_pair: string;
    }
  | {
      mission: "M12";
      scenario_id: string;
      node_or_zone: string;
      interval_start: string;
      breakeven_usd_per_mwh: number;
    };

export interface DeskSpendTotals {
  total_calls: number;
  total_cost_uusdc: number;
  total_cost_usd: number;
  m13_calls: number;
  m12_calls: number;
  verified_calls: number;
  distinct_miners: number;
  distinct_scenarios: number;
}

export interface DeskSpendToday {
  day: string;
  calls: number;
  cost_uusdc: number;
  cost_usd: number;
}

export interface DeskCaps {
  free_checks_per_ip_per_day: number;
  daily_global_cap_usd: number;
  cost_per_check_usd: number;
}

export interface DeskStats {
  payer_address: string | null;
  diamond: string;
  network: string;
  chain: string;
  escrow: Record<string, unknown> | null;
  /** Null when no payer is configured — never a fabricated runway. */
  runway_checks: number | null;
  runway_label: string | null;
  spend: DeskSpendTotals;
  spend_today: DeskSpendToday;
  caps: DeskCaps;
  related_party_disclosure: string;
}

/** One ledger row = ONE ranked call (ledger.ts deskRunToPublic). */
export interface DeskLedgerRun {
  id: number;
  run_id: string;
  mission: "M13" | "M12";
  scenario_id: string;
  intent: string;
  miner_id: string | null;
  miner_name: string | null;
  signal_hash: string | null;
  signal_url: string | null;
  receipt_hash: string | null;
  cost_uusdc: number;
  cost_usd: number;
  rail: string;
  verdict: string | null;
  related_party: boolean;
  fetched_at: string;
  verification_status: string;
}

export interface DeskLedgerPage {
  runs: DeskLedgerRun[];
  page: number;
  limit: number;
  total: number;
}

/**
 * Related-party disclosure — VERBATIM from blueprint §7.3 / backend
 * routes.ts RELATED_PARTY_DISCLOSURE. Copy character-for-character; do
 * not reword, shorten, or paraphrase. Verified byte-identical to the
 * backend constant (both 394 chars). Rendered in the Desk page footer,
 * and the run/stats parsers require the server to return this exact text.
 */
export const RELATED_PARTY_DISCLOSURE =
  "Disclosure: VeriReceipt Desk and the VeriReceipt Miner are operated by the same team. " +
  "Calls made by VeriReceipt Desk use Telegraph's ranked router (`POST /engine/v1/ask`) on " +
  "Ethereum Sepolia testnet (Test USDC only) and are explicitly labeled as related-party / " +
  "internal test traffic, not independent customer demand. Independent third-party developer " +
  "runs are logged and identified separately.";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && hasVisibleCharacter(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): ApiError {
  return new ApiError(`Invalid response from server: ${message}`, 200, "INVALID_RESPONSE");
}

function assertDeskCheck(value: unknown, index: number): asserts value is DeskCheck {
  if (!isRecord(value)) {
    throw invalid(`desk check ${index} is not an object`);
  }
  if (!isNonEmptyString(value["id"]) || !isNonEmptyString(value["name"])) {
    throw invalid(`desk check ${index} is missing id/name`);
  }
  if (!isDeskCheckStatus(value["status"])) {
    throw invalid(`desk check ${index} has an unknown status`);
  }
  if (!isNonEmptyString(value["reason"])) {
    throw invalid(`desk check ${index} is missing reason`);
  }
  if (
    value["detail"] !== undefined &&
    value["detail"] !== null &&
    typeof value["detail"] !== "string"
  ) {
    throw invalid(`desk check ${index} has a non-string detail`);
  }
}

function assertDeskCall(value: unknown, index: number): asserts value is DeskCall {
  if (!isRecord(value)) {
    throw invalid(`desk call ${index} is not an object`);
  }
  if (!isNonEmptyString(value["intent"])) {
    throw invalid(`desk call ${index} is missing intent`);
  }
  if (!isRecord(value["params"])) {
    throw invalid(`desk call ${index} is missing params`);
  }
  for (const field of ["miner_id", "miner_name", "signal_hash", "receipt_hash", "signal_url"] as const) {
    const v = value[field];
    if (v !== null && typeof v !== "string") {
      throw invalid(`desk call ${index} has a non-string ${field}`);
    }
  }
  if (!isFiniteNumber(value["cost_uusdc"]) || value["cost_uusdc"] < 0) {
    throw invalid(`desk call ${index} has a missing or negative cost_uusdc`);
  }
  if (!isNonEmptyString(value["rail"])) {
    throw invalid(`desk call ${index} is missing rail`);
  }
  if (!isNonEmptyString(value["fetched_at"]) || Number.isNaN(Date.parse(value["fetched_at"] as string))) {
    throw invalid(`desk call ${index} has a missing or unparseable fetched_at`);
  }
  // Future-dated fetch (round 3, F3; tolerance closed to zero in
  // round 4): ANY stamp after now is INVALID_RESPONSE. A call stamped
  // in the future would render a "Delivery epoch pending" window in
  // the future and future-stamped stream lines — fail closed instead
  // of rendering it.
  if (Date.parse(value["fetched_at"] as string) > Date.now() + DESK_FETCHED_AT_CLOCK_SKEW_MS) {
    throw invalid(`desk call ${index} has a fetched_at in the future`);
  }
}

function parseDeskRunResponse(body: unknown): DeskRunResponse {
  if (!isRecord(body)) {
    throw invalid("expected a JSON object");
  }
  if (!isNonEmptyString(body["run_id"])) {
    throw invalid("missing run_id");
  }
  if (body["mission"] !== "M13" && body["mission"] !== "M12") {
    throw invalid('missing or unknown desk mission (expected "M13" or "M12")');
  }
  if (!isNonEmptyString(body["scenario_id"])) {
    throw invalid("missing scenario_id");
  }
  if (!isDeskVerdict(body["verdict"])) {
    throw invalid("missing or unknown desk verdict");
  }
  // Mission -> verdict mapping: M13 APPROVE | HOLD | REJECT, M12 MINE |
  // CURTAIL | HOLD. A cross-mission verdict is malformed, never rendered.
  const mission = body["mission"] as "M13" | "M12";
  if (!(DESK_VERDICTS_BY_MISSION[mission] as string[]).includes(body["verdict"] as string)) {
    throw invalid(`desk verdict ${body["verdict"]} is not valid for mission ${mission}`);
  }
  if (!Array.isArray(body["checks"])) {
    throw invalid("desk checks must be an array");
  }
  // Zero evidence is not a verdict: an APPROVE banner with no checks
  // would assert a gate passed on nothing.
  if (body["checks"].length === 0) {
    throw invalid("desk checks must not be empty");
  }
  body["checks"].forEach((c, i) => assertDeskCheck(c, i));
  // Skip model (round 6, F2 — corrected; the round-4 comment below was
  // FALSE): only ONE check in the whole backend can ever return
  // "skipped" — M13 checkSanctions, and only when no sanctions
  // evidence was bought (backend/src/desk/policyM13.ts:309, the ONLY
  // `status: "skipped"` return in the file; header :15–17 and :476
  // state the same). checkRouteVsSpot (:471) returns "unverifiable"
  // for a missing spot price, never "skipped", and forces HOLD. M12
  // has no skipped branch at all (policyM12.ts:45 — M12CheckStatus =
  // "pass" | "hold" | "unverifiable"). A "skipped" anywhere else is
  // malformed, never rendered: the old parser accepted an M13 APPROVE
  // with both sanctions and route_vs_spot skipped, and an M12 run with
  // a skipped check, because it rejected only all-skipped. The one
  // blueprint-sanctioned sanctions skip beside a pass still parses.
  for (const check of body["checks"] as DeskCheck[]) {
    if (check.status !== "skipped") continue;
    if (mission === "M13" && check.id === "sanctions") continue;
    throw invalid(`desk check ${check.id} must never be skipped for mission ${mission}`);
  }
  // All-skipped is not a verdict (round 4, F4): the backend can never
  // emit it — even the one skippable check sits beside seven others
  // that return pass/hold/reject/unverifiable, and missing evidence
  // for them yields hold/unverifiable (verdict HOLD), never APPROVE.
  // An APPROVE (or MINE) banner with zero passing evidence would
  // assert "Allocation verified across the ranked checks" on nothing.
  // Some skipped checks beside a pass are legitimate (the
  // blueprint-sanctioned sanctions skip) and still parse.
  if (body["checks"].every((c) => (c as DeskCheck).status === "skipped")) {
    throw invalid("desk checks must not all be skipped");
  }
  // Verdict/check-status consistency (round 7, F1 — J2 reproduced 8
  // impossible combos the old parser ACCEPTED): Desk.tsx renders the
  // verdict banner from result.verdict and the checks list from
  // result.checks with no cross-check, so an accepted APPROVE + reject
  // response rendered "Allocation verified across the ranked checks."
  // beside a REJECT badge reading "Counterparty transaction is
  // reverted." The backend derives the verdict from the statuses
  // alone — the ONLY verdict source is evaluateM13/evaluateM12
  // (scenarios.ts:287,296,318,368) and routes.ts:188,214 copies
  // outcome.decision.verdict verbatim — so a verdict that contradicts
  // its statuses can never be a real reply:
  //   M13 (policyM13.ts:558-560): APPROVE ⟺ all checks pass/skipped
  //     (skipped ignored — only reject, then hold/unverifiable, decide
  //     the verdict); REJECT ⟺ ≥1 reject; HOLD ⟺ no reject + ≥1
  //     hold/unverifiable.
  //   M12 (policyM12.ts:325-340,391-393): MINE/CURTAIL ⟺ all checks
  //     pass (blocked=false + dispatch.side, and checkDispatch sets
  //     side only with status pass); HOLD ⟺ ≥1 hold/unverifiable
  //     (any hold/unverifiable blocks, blocked=true → HOLD). MINE vs
  //     CURTAIL need not be distinguished — that depends on
  //     dispatch.side, not derivable from statuses.
  // Placed AFTER the skip rules above, so a skipped check still fails
  // with its own "must never be skipped" / "must not all be skipped"
  // message. A missing/unknown verdict still fails earlier with
  // "missing or unknown desk verdict" — no verdict is invented here.
  const verdict = body["verdict"] as string;
  const checks = body["checks"] as DeskCheck[];
  const hasReject = checks.some((c) => c.status === "reject");
  const hasHold = checks.some((c) => c.status === "hold" || c.status === "unverifiable");
  if (mission === "M13") {
    if (verdict === "APPROVE" && (hasReject || hasHold)) {
      throw invalid(
        `desk verdict APPROVE contradicts its checks: every check must pass (skipped ignored) but a ${hasReject ? "reject" : "hold/unverifiable"} check is present`,
      );
    }
    if (verdict === "REJECT" && !hasReject) {
      throw invalid(
        "desk verdict REJECT contradicts its checks: no check rejected (the backend verdict would be APPROVE or HOLD)",
      );
    }
    if (verdict === "HOLD" && (hasReject || !hasHold)) {
      throw invalid(
        hasReject
          ? "desk verdict HOLD contradicts its checks: a reject check is present (the backend verdict would be REJECT)"
          : "desk verdict HOLD contradicts its checks: no check held or was unverifiable (the backend verdict would be APPROVE)",
      );
    }
  } else {
    // M12 has no skipped branch (any skipped M12 check is already
    // rejected above), so "all pass" here is literal.
    const allPass = checks.every((c) => c.status === "pass");
    if ((verdict === "MINE" || verdict === "CURTAIL") && !allPass) {
      const bad = checks.find((c) => c.status !== "pass")!;
      throw invalid(
        `desk verdict ${verdict} contradicts its checks: every check must pass but check ${bad.id} is ${bad.status}`,
      );
    }
    if (verdict === "HOLD" && (hasReject || !hasHold)) {
      throw invalid(
        hasReject
          ? "desk verdict HOLD contradicts its checks: a reject check is present (the backend can never emit a reject check in M12)"
          : "desk verdict HOLD contradicts its checks: no check held or was unverifiable (the backend verdict would be MINE or CURTAIL)",
      );
    }
  }
  if (!Array.isArray(body["why"]) || !body["why"].every((w) => isNonEmptyString(w))) {
    throw invalid("desk why entries must be non-empty strings");
  }
  // The UI renders a why-box for every run; an empty why[] would render
  // "The run returned no why entries" for a verdict the backend did not
  // explain (round 3, F3). Zero explanation is not a verdict.
  if (body["why"].length === 0) {
    throw invalid("desk why must not be empty");
  }
  if (!Array.isArray(body["calls"])) {
    throw invalid("desk calls must be an array");
  }
  // Zero evidence is not a verdict (round 3, F2): an empty calls[]
  // passed the old parser while every per-call assertion was vacuously
  // skipped, so an APPROVE with 0 ranked calls and $0.00 spent was
  // rendered. Same rule as checks[] above.
  if (body["calls"].length === 0) {
    throw invalid("desk calls must not be empty");
  }
  body["calls"].forEach((c, i) => assertDeskCall(c, i));
  if (
    !isFiniteNumber(body["total_cost_uusdc"]) ||
    body["total_cost_uusdc"] < 0 ||
    !isFiniteNumber(body["total_cost_usd"]) ||
    body["total_cost_usd"] < 0
  ) {
    throw invalid("desk total_cost_uusdc/total_cost_usd must be non-negative numbers");
  }
  // Totals are a sum by construction (round 4, F1), not independent
  // fields: the backend defines total_cost_uusdc as the sum of the call
  // costs (scenarios.ts:327,380: `records.reduce((s, c) => s +
  // c.cost_uusdc, 0)`) and total_cost_usd as total_cost_uusdc /
  // 1_000_000 (routes.ts:202-203, mcp.ts:206-207). A total that is not
  // the sum is malformed per the backend's own contract — the old
  // non-negative-only check accepted total 0 beside a $0.01 call and
  // the UI rendered "$0.00 Test USDC spent" beside "$0.01" lines.
  // The usd comparison allows 1e-9 of float slack (the backend's /1e6
  // division and JSON round-trip land on the same double, but a 1-ulp
  // difference on a large sum is not a malformed response); any real
  // mismatch is orders of magnitude larger.
  const sumCostUusdc = (body["calls"] as DeskCall[]).reduce((s, c) => s + c.cost_uusdc, 0);
  if (body["total_cost_uusdc"] !== sumCostUusdc) {
    throw invalid(
      `desk total_cost_uusdc does not equal the sum of the call costs: ${body["total_cost_uusdc"]} vs ${sumCostUusdc}`,
    );
  }
  if (Math.abs((body["total_cost_usd"] as number) - sumCostUusdc / 1_000_000) > 1e-9) {
    throw invalid(
      `desk total_cost_usd does not equal total_cost_uusdc / 1_000_000: ${body["total_cost_usd"]} vs ${sumCostUusdc / 1_000_000}`,
    );
  }
  if (body["related_party"] !== true) {
    throw invalid("desk related_party must be true");
  }
  if (body["disclosure"] !== RELATED_PARTY_DISCLOSURE) {
    throw invalid("desk disclosure does not match the verbatim §7.3 text");
  }
  return {
    run_id: body["run_id"] as string,
    mission: body["mission"] as "M13" | "M12",
    scenario_id: body["scenario_id"] as string,
    verdict: body["verdict"] as DeskVerdict,
    checks: body["checks"] as DeskCheck[],
    why: body["why"] as string[],
    calls: (body["calls"] as DeskCall[]).map((c) => ({
      ...c,
      signal_hash:
        typeof c.signal_hash === "string" && c.signal_hash.length > 0 ? c.signal_hash : null,
      signal_url:
        typeof c.signal_url === "string" && c.signal_url.length > 0 ? c.signal_url : null,
    })),
    total_cost_uusdc: body["total_cost_uusdc"] as number,
    total_cost_usd: body["total_cost_usd"] as number,
    related_party: true,
    disclosure: body["disclosure"] as string,
  };
}

function parseDeskStats(body: unknown): DeskStats {
  if (!isRecord(body)) {
    throw invalid("expected a JSON object");
  }
  if (body["payer_address"] !== null && typeof body["payer_address"] !== "string") {
    throw invalid("desk stats payer_address must be a string or null");
  }
  if (!isNonEmptyString(body["diamond"]) || !isNonEmptyString(body["network"]) || !isNonEmptyString(body["chain"])) {
    throw invalid("desk stats is missing diamond/network/chain");
  }
  if (body["escrow"] !== null && !isRecord(body["escrow"])) {
    throw invalid("desk stats escrow must be an object or null");
  }
  if (
    body["runway_checks"] !== null &&
    !isFiniteNumber(body["runway_checks"])
  ) {
    throw invalid("desk stats runway_checks must be a number or null");
  }
  if (body["runway_label"] !== null && typeof body["runway_label"] !== "string") {
    throw invalid("desk stats runway_label must be a string or null");
  }
  const spend = body["spend"];
  if (
    !isRecord(spend) ||
    !isFiniteNumber(spend["total_calls"]) ||
    !isFiniteNumber(spend["total_cost_uusdc"]) ||
    !isFiniteNumber(spend["total_cost_usd"]) ||
    !isFiniteNumber(spend["m13_calls"]) ||
    !isFiniteNumber(spend["m12_calls"]) ||
    !isFiniteNumber(spend["verified_calls"]) ||
    !isFiniteNumber(spend["distinct_miners"]) ||
    !isFiniteNumber(spend["distinct_scenarios"])
  ) {
    throw invalid("malformed desk stats spend totals");
  }
  const today = body["spend_today"];
  if (
    !isRecord(today) ||
    !isNonEmptyString(today["day"]) ||
    !isFiniteNumber(today["calls"]) ||
    !isFiniteNumber(today["cost_uusdc"]) ||
    !isFiniteNumber(today["cost_usd"])
  ) {
    throw invalid("malformed desk stats spend_today");
  }
  const caps = body["caps"];
  if (
    !isRecord(caps) ||
    !isFiniteNumber(caps["free_checks_per_ip_per_day"]) ||
    !isFiniteNumber(caps["daily_global_cap_usd"]) ||
    !isFiniteNumber(caps["cost_per_check_usd"])
  ) {
    throw invalid("malformed desk stats caps");
  }
  if (body["related_party_disclosure"] !== RELATED_PARTY_DISCLOSURE) {
    throw invalid("desk stats disclosure does not match the verbatim §7.3 text");
  }
  return {
    payer_address: body["payer_address"] as string | null,
    diamond: body["diamond"] as string,
    network: body["network"] as string,
    chain: body["chain"] as string,
    escrow: body["escrow"] as Record<string, unknown> | null,
    runway_checks: body["runway_checks"] as number | null,
    runway_label: body["runway_label"] as string | null,
    spend: spend as unknown as DeskSpendTotals,
    spend_today: today as unknown as DeskSpendToday,
    caps: caps as unknown as DeskCaps,
    related_party_disclosure: body["related_party_disclosure"] as string,
  };
}

function parseDeskLedgerPage(body: unknown): DeskLedgerPage {
  if (!isRecord(body)) {
    throw invalid("expected a JSON object");
  }
  if (!Array.isArray(body["runs"])) {
    throw invalid("desk ledger runs must be an array");
  }
  for (const [i, run] of (body["runs"] as unknown[]).entries()) {
    if (!isRecord(run)) {
      throw invalid(`desk ledger run ${i} is not an object`);
    }
    if (!isFiniteNumber(run["id"]) || !isNonEmptyString(run["run_id"])) {
      throw invalid(`desk ledger run ${i} is missing id/run_id`);
    }
    if (run["mission"] !== "M13" && run["mission"] !== "M12") {
      throw invalid(`desk ledger run ${i} has an unknown mission`);
    }
    if (!isNonEmptyString(run["scenario_id"]) || !isNonEmptyString(run["intent"])) {
      throw invalid(`desk ledger run ${i} is missing scenario_id/intent`);
    }
    for (const field of ["miner_id", "miner_name", "signal_hash", "signal_url", "receipt_hash"] as const) {
      const v = run[field];
      if (v !== null && typeof v !== "string") {
        throw invalid(`desk ledger run ${i} has a non-string ${field}`);
      }
    }
    if (!isFiniteNumber(run["cost_uusdc"]) || !isFiniteNumber(run["cost_usd"])) {
      throw invalid(`desk ledger run ${i} is missing cost_uusdc/cost_usd`);
    }
    if (!isNonEmptyString(run["rail"])) {
      throw invalid(`desk ledger run ${i} is missing rail`);
    }
    if (run["verdict"] !== null && typeof run["verdict"] !== "string") {
      throw invalid(`desk ledger run ${i} has a non-string verdict`);
    }
    if (typeof run["related_party"] !== "boolean") {
      throw invalid(`desk ledger run ${i} is missing related_party`);
    }
    if (!isNonEmptyString(run["fetched_at"]) || !isNonEmptyString(run["verification_status"])) {
      throw invalid(`desk ledger run ${i} is missing fetched_at/verification_status`);
    }
  }
  if (
    !isFiniteNumber(body["page"]) ||
    !isFiniteNumber(body["limit"]) ||
    !isFiniteNumber(body["total"])
  ) {
    throw invalid("desk ledger pagination fields (page/limit/total) must be numbers");
  }
  return {
    runs: body["runs"] as DeskLedgerRun[],
    page: body["page"] as number,
    limit: body["limit"] as number,
    total: body["total"] as number,
  };
}

async function fetchDeskJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  // jsdom has no AbortSignal.any: combine the per-call timeout and the
  // caller's external signal with a local controller instead.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : "Request failed";
    throw new ApiError(message, 0, "NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onExternalAbort);
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    throw new ApiError("Failed to read response body", 0, "NETWORK_ERROR");
  }
  if (text.length > MAX_RESPONSE_BODY_BYTES) {
    throw new ApiError(`Response body exceeds the ${MAX_RESPONSE_BODY_BYTES} byte limit`, res.status, "INVALID_RESPONSE");
  }
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const err = body as { error?: string; message?: string; code?: string } | null;
    const message =
      (typeof err?.message === "string" && hasVisibleCharacter(err.message) ? err.message : undefined) ??
      (typeof err?.error === "string" && hasVisibleCharacter(err.error) ? err.error : undefined) ??
      `Request failed with status ${res.status}`;
    throw new ApiError(message, res.status, err?.code);
  }
  if (body === null) {
    throw new ApiError("Invalid response from server: empty JSON body", res.status, "INVALID_RESPONSE");
  }
  return body;
}

function validateDeskRunRequest(request: DeskRunRequest): void {
  if (request === null || typeof request !== "object") {
    throw new ApiError('Invalid parameter "request": expected a desk run request object', 400, "INVALID_PARAM");
  }
  if (request.mission !== "M13" && request.mission !== "M12") {
    throw new ApiError('Invalid parameter "request": mission must be "M13" or "M12"', 400, "INVALID_PARAM");
  }
  if (!isNonEmptyString(request.scenario_id)) {
    throw new ApiError('Invalid parameter "request": scenario_id is required', 400, "INVALID_PARAM");
  }
  if (request.mission === "M13") {
    for (const field of ["protocol", "tx_hash", "chain", "issuer_entity", "period", "trade_pair"] as const) {
      if (!isNonEmptyString(request[field])) {
        throw new ApiError(`Invalid parameter "request": ${field} is required`, 400, "INVALID_PARAM");
      }
    }
  } else {
    if (!isNonEmptyString(request.node_or_zone) || !isNonEmptyString(request.interval_start)) {
      throw new ApiError('Invalid parameter "request": node_or_zone and interval_start are required', 400, "INVALID_PARAM");
    }
    if (!isFiniteNumber(request.breakeven_usd_per_mwh) || request.breakeven_usd_per_mwh <= 0) {
      throw new ApiError('Invalid parameter "request": breakeven_usd_per_mwh must be a positive number', 400, "INVALID_PARAM");
    }
  }
}

/** POST /api/desk/run — one ranked escrow run (flat fields, UPPERCASE
 *  mission). Same-origin /api/desk/run — see the remount note above. */
export async function runDeskCheck(
  request: DeskRunRequest,
  signal?: AbortSignal,
): Promise<DeskRunResponse> {
  validateDeskRunRequest(request);
  const body = await fetchDeskJson(
    "/api/desk/run",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
    DESK_RUN_TIMEOUT_MS,
  );
  return parseDeskRunResponse(body);
}

/** GET /api/desk/stats — live payer runway. No fallback values:
 *  runway fields are null when no payer is configured. */
export async function getDeskStats(signal?: AbortSignal): Promise<DeskStats> {
  const body = await fetchDeskJson(
    "/api/desk/stats",
    { headers: { Accept: "application/json" }, signal },
    DESK_STATS_TIMEOUT_MS,
  );
  return parseDeskStats(body);
}

/** GET /api/desk/ledger — paginated past calls, newest first.
 *  The backend reads ?limit (default 20, max 100), not ?page_size. */
export async function getDeskLedger(
  page = 1,
  limit: number = DESK_LEDGER_PAGE_SIZE,
  signal?: AbortSignal,
): Promise<DeskLedgerPage> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  const body = await fetchDeskJson(
    `/api/desk/ledger?${params.toString()}`,
    { headers: { Accept: "application/json" }, signal },
    DESK_STATS_TIMEOUT_MS,
  );
  return parseDeskLedgerPage(body);
}
