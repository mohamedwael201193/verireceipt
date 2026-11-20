// GET /v1/validator — effective_balance (gwei) of an Ethereum validator.
//
// Zero-LLM. Calls the standard beacon API path
// /eth/v1/beacon/states/head/validators/{index} on TWO keyless public
// beacon sources and requires 2-of-2 agreement on effective_balance AND
// status before answering. A single-source answer is NEVER served as
// verified: one source down, or a disagreement, fails closed with 502
// QUORUM_UNREACHABLE (no answer, no receipt). Each leg is additionally
// bound to the requested validator (data.index must equal the requested
// index), rejected if the node flags it execution_optimistic, and
// rejected if its status is outside the nine-value beacon status enum.
// Both legs 404 means the validator does not exist: 422
// VALIDATOR_NOT_FOUND (repo precedent: filings 404 -> 422
// ENTITY_NOT_FOUND, TVL unknown -> 422 PROTOCOL_NOT_FOUND).
//
// effective_balance is returned as a NUMBER in gwei. 0 is a real 0
// (an exited / fully-withdrawn validator), never null. The beacon API
// serves it as a JSON string ("32000000000"); the handler parses it to
// a safe integer and refuses a leg whose value is not a digit string.
//
// Only effective_balance + status are compared across legs. The beacon
// `balance` field is deliberately NOT compared: two nodes at different
// head slots legitimately report different current balances, while
// effective_balance only moves on activation/exit (32 ETH cap) and is
// stable across heads. Comparing `balance` would 502 on ordinary
// head-slot drift.
//
// Receipt: the receipt hashes the EXACT raw body bytes of the winning
// leg (the first of the agreeing pair, in arrival order) and stores
// those bytes as evidence via saveReceipt(receipt, rawBody), so a
// re-hash of GET /receipts/:id/evidence always matches. The receipt's
// upstream_url is that leg's full request URL.

import { badRequest, unprocessable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/db";
import { quorum2of3 } from "../core/quorum";
import { TIMEOUT_MS } from "../config/limits";

export const INTENT = "VALIDATOR_PERFORMANCE_VERIFY_GENERAL";

/**
 * The two keyless beacon API bases. Verified live 2026-11-20 (see
 * RUN-LOG): each answers the standard path for indices 1, 100000 and
 * 500000 with no API key and no signup.
 *
 * 1. ChainSafe Lodestar public mainnet node.
 * 2. PublicNode public Ethereum Beacon API endpoint.
 *
 * Both verified live 2026-11-20 ~18:32–18:58 UTC: each answers the
 * standard path for indices 1, 100000 and 500000 with no API key and
 * no signup, and both agree (1 -> 32000000000 active_ongoing;
 * 100000/500000 -> 0 withdrawal_done). PublicNode was additionally
 * verified by the independent verification run the same day
 * (verification-2026-11-20.md rows 25-27: same values, including
 * balance 32083979186 and 0x02 credentials for index 1).
 *
 * Verified alternate (not wired in): Stakely
 * https://ethereum-beacon-api.stakely.io — same three indices, same
 * values, verified live 2026-11-20 ~18:46-18:51 UTC.
 *
 * Rejected candidates (verified live, same session): BlastAPI public
 * beacon (fetcher could not resolve it; VM egress probe aborted at
 * 20 s and 60 s — sandbox proxy, not proof the host is down, but
 * unverifiable from here); SigP checkpoint and beaconcha.in
 * checkpoint-sync (HTTP 404 on the validators path); dRPC beacon
 * (400 "chain is not available on free plan" — paid only); other
 * PublicNode beacon hosts (404 on the validators path).
 *
 * VM-egress caveat (2026-11-20): direct egress from this VM is dead
 * (curl --noproxy times out even for example.com) and the egress
 * proxy aborts node-fetch/curl to BOTH wired sources even at a 60 s
 * timeout, while the runtime page fetcher reaches them fine. So the
 * live vitest tests and a local-server curl check 502 from this VM
 * for an environmental reason, not a code reason. The production
 * path (Render, direct egress) is where the live curl check must
 * pass; the fixture tests + fetcher verification above are the
 * evidence available from here.
 */
export const BEACON_SOURCES: readonly string[] = [
  "https://lodestar-mainnet.chainsafe.io",
  "https://ethereum-beacon-api.publicnode.com",
];

/** Per-leg upstream timeout (ms). Same 4.5 s contract as the other handlers. */
export const VALIDATOR_TIMEOUT_MS = TIMEOUT_MS;

/**
 * Beacon API validator status enum (ethereum/beacon-apis
 * `GET /eth/v1/beacon/states/{state_id}/validators/{validator_id}`).
 * Verified 2026-11-20 against the beacon API docs (Chainstack beacon
 * reference + beaconcha.in API reference list the same nine values).
 * A status outside this set fails the leg (J2 F3): the beacon API only
 * ever returns one of these nine, so anything else is a malformed or
 * spoofed body, even if both legs agree on it.
 */
export const VALIDATOR_STATUSES: ReadonlySet<string> = new Set([
  "pending_initialized",
  "pending_queued",
  "active_ongoing",
  "active_exiting",
  "active_slashed",
  "exited_unslashed",
  "exited_slashed",
  "withdrawal_possible",
  "withdrawal_done",
]);

/** Optional transport override — used only by tests to inject fixtures. */
export interface ValidatorDeps {
  fetchImpl?: typeof fetch;
  /** Per-fetch timeout override in ms (test only, default 4500). Tests may raise it; production must not. */
  timeoutMs?: number;
}

const VALIDATOR_INDEX_RE = /^\d+$/;

interface ValidatorLeg {
  /** Effective balance in gwei, as a number (0 is a real 0). */
  effectiveBalance: number;
  /** Beacon status string, e.g. "active_ongoing", "withdrawal_done". */
  status: string;
  /** Exact raw response bytes of this leg (receipt evidence). */
  rawBody: string;
  /** Full request URL of this leg (receipt upstream_url). */
  sourceUrl: string;
}

/**
 * Parse one beacon API validator response body. Throws on any malformed
 * shape (non-JSON, missing data/validator, non-digit effective_balance,
 * empty status) — the caller treats a throw as a failed leg, never as
 * an answer. Pure function, unit-tested.
 *
 * Fail-closed checks (J2 fix round, 2026-11-20):
 * - F1 index binding: `data.index` MUST equal `String(expectedIndex)`.
 *   A leg returning a different validator's data fails the leg, even if
 *   effective_balance/status agree — otherwise the receipt would certify
 *   the wrong validator while upstream_url names the requested one.
 * - F2 execution_optimistic: a leg with `execution_optimistic === true`
 *   fails — the node flags its own data unverified, so it must never be
 *   served as verified with confidence 1.0. (F7 round 2: the field must
 *   be an explicit boolean — a missing field or a non-boolean value
 *   ("true", 1, null, ...) also fails the leg; only `false` vouches.)
 * - F3 status allowlist: `data.status` must be one of VALIDATOR_STATUSES.
 */
export function parseValidatorResponse(
  rawBody: string,
  sourceUrl: string,
  expectedIndex: number,
): ValidatorLeg {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error(`malformed beacon response from ${sourceUrl}: not JSON`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`malformed beacon response from ${sourceUrl}: top level is not an object`);
  }
  const parsedObj = parsed as Record<string, unknown>;
  // F7 (round 2): execution_optimistic is a spec-required boolean. Only
  // an explicit boolean vouches for the data: a missing field or a
  // non-boolean value ("true", 1, null, ...) is malformed and fails the
  // leg — it must never be served as verified with confidence 1.0.
  if (typeof parsedObj.execution_optimistic !== "boolean") {
    throw new Error(
      `malformed beacon response from ${sourceUrl}: execution_optimistic is missing or not a boolean`,
    );
  }
  // F2: optimistic-head data is explicitly unverified by the beacon node.
  if (parsedObj.execution_optimistic === true) {
    throw new Error(
      `malformed beacon response from ${sourceUrl}: execution_optimistic is true (data not verified by the node)`,
    );
  }
  const data = parsedObj.data;
  if (data === null || typeof data !== "object") {
    throw new Error(`malformed beacon response from ${sourceUrl}: missing data object`);
  }
  const dataObj = data as Record<string, unknown>;
  // F1: bind the evidence to the validator that was asked for.
  if (dataObj.index !== String(expectedIndex)) {
    throw new Error(
      `malformed beacon response from ${sourceUrl}: data.index ${JSON.stringify(dataObj.index)} does not match requested validator ${expectedIndex}`,
    );
  }
  const status = dataObj.status;
  if (typeof status !== "string" || status.length === 0) {
    throw new Error(`malformed beacon response from ${sourceUrl}: missing status`);
  }
  // F3: only the nine beacon-API statuses are acceptable.
  if (!VALIDATOR_STATUSES.has(status)) {
    throw new Error(
      `malformed beacon response from ${sourceUrl}: unknown status ${JSON.stringify(status)}`,
    );
  }
  const validator = dataObj.validator;
  if (validator === null || typeof validator !== "object") {
    throw new Error(`malformed beacon response from ${sourceUrl}: missing validator object`);
  }
  const effectiveBalanceRaw = (validator as Record<string, unknown>).effective_balance;
  if (typeof effectiveBalanceRaw !== "string" || !/^\d+$/.test(effectiveBalanceRaw)) {
    throw new Error(
      `malformed beacon response from ${sourceUrl}: effective_balance is not a digit string`,
    );
  }
  const effectiveBalance = Number(effectiveBalanceRaw);
  if (!Number.isSafeInteger(effectiveBalance) || effectiveBalance < 0) {
    throw new Error(
      `malformed beacon response from ${sourceUrl}: effective_balance is not a safe non-negative integer`,
    );
  }
  return { effectiveBalance, status, rawBody, sourceUrl };
}

/** Read the HTTP status a fetch leg failed with, if it failed on a non-200. */
function httpStatusOf(err: unknown): number | undefined {
  if (err !== null && typeof err === "object" && "httpStatus" in err) {
    const s = (err as { httpStatus?: unknown }).httpStatus;
    if (typeof s === "number") return s;
  }
  return undefined;
}

async function fetchValidatorFromSource(
  base: string,
  index: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ValidatorLeg> {
  const sourceUrl = `${base}/eth/v1/beacon/states/head/validators/${index}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(sourceUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      // F4: surface the HTTP status so the handler can tell a dual-404
      // (validator does not exist) apart from a generic upstream failure.
      const err = new Error(
        `beacon source ${base} returned HTTP ${res.status} for validator ${index}`,
      ) as Error & { httpStatus: number };
      err.httpStatus = res.status;
      throw err;
    }
    const rawBody = await res.text();
    return parseValidatorResponse(rawBody, sourceUrl, index);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleValidator(
  query: Record<string, string | undefined>,
  deps: ValidatorDeps = {},
): Promise<Record<string, unknown>> {
  // Param name: `validator_index` (declared in miner.yaml by A8).
  // `index` is accepted as an alias so a request builder that sends
  // the shorter name still reaches the same validation.
  const rawIndex = query.validator_index ?? query.index;
  if (rawIndex === undefined || !VALIDATOR_INDEX_RE.test(rawIndex)) {
    throw badRequest(
      "INVALID_VALIDATOR_INDEX",
      "validator_index is required and must be a non-negative integer (e.g. 1)",
    );
  }
  const index = Number(rawIndex);
  if (!Number.isSafeInteger(index)) {
    throw badRequest(
      "INVALID_VALIDATOR_INDEX",
      "validator_index must be a non-negative integer (e.g. 1)",
    );
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? VALIDATOR_TIMEOUT_MS;
  // F6 (round 2): request-start clock for the settlement-wait budget.
  // The F4 wait below is raced against the time LEFT in timeoutMs, so
  // the whole request ends within ~timeoutMs even when a leg never
  // settles (quorum's withTimeout is only a race — it does not settle
  // the underlying leg promise — and the abort only helps if fetch
  // honors the signal).
  const startedAt = Date.now();
  // Legs are started eagerly (one promise per source) so the handler can
  // inspect each leg's outcome after quorum rejects. quorum2of3
  // early-fails on the first leg failure — before the second leg settles —
  // so a dual-404 cannot be recognised from the quorum error alone.
  // F4: record each leg's HTTP status (200, 404, or undefined while
  // still pending / failed otherwise) as it settles.
  const legHttpStatus: Array<number | undefined> = [undefined, undefined];
  const legPromises = BEACON_SOURCES.map((base, i) =>
    fetchValidatorFromSource(base, index, fetchImpl, timeoutMs).then(
      (leg) => {
        legHttpStatus[i] = 200;
        return leg;
      },
      (err: unknown) => {
        legHttpStatus[i] = httpStatusOf(err);
        throw err;
      },
    ),
  );
  const tasks = legPromises.map((p) => () => p);
  // 2-of-2: quorum2of3 with exactly 2 legs resolves only when both
  // legs succeed AND agree (effective_balance + status). One leg down
  // or a disagreement rejects with 502 QUORUM_UNREACHABLE — never a
  // single-source answer served as verified.
  let leg: ValidatorLeg;
  let votes: string;
  try {
    ({ value: leg, votes } = await quorum2of3(
      tasks,
      (a, b) => a.effectiveBalance === b.effectiveBalance && a.status === b.status,
      timeoutMs,
    ));
  } catch (err) {
    // F4: both legs 404 means the validator does not exist — 422
    // VALIDATOR_NOT_FOUND, per repo precedent (filings 404 -> 422
    // ENTITY_NOT_FOUND, TVL unknown -> 422 PROTOCOL_NOT_FOUND), not a
    // 502 that conflates "does not exist" with "upstream down". Only
    // await the second leg's settlement when a 404 was already seen.
    // F6 (round 2): that wait is BOUNDED — raced against the time left
    // in this request's timeoutMs budget (measured from handler start),
    // never a bare allSettled. A 404 + a hanging leg therefore ends in
    // 502 within ~timeoutMs, and a 404 + a slow-but-finite leg also
    // 502s within ~timeoutMs instead of waiting out the leg. 422 iff
    // both legs are observed 404 (settled rejections, or both statuses
    // already recorded as 404); anything else rethrows the 502.
    if (legHttpStatus.some((s) => s === 404)) {
      const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
      const settled = await Promise.race([
        Promise.allSettled(legPromises),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), remainingMs);
        }),
      ]);
      const both404 =
        (settled !== null &&
          settled.length === BEACON_SOURCES.length &&
          settled.every((r) => r.status === "rejected" && httpStatusOf(r.reason) === 404)) ||
        legHttpStatus.every((s) => s === 404);
      if (both404) {
        throw unprocessable(
          "VALIDATOR_NOT_FOUND",
          `validator ${index} does not exist (both beacon sources returned 404)`,
        );
      }
    }
    throw err;
  }

  const receipt = makeReceipt(INTENT, leg.sourceUrl, leg.rawBody, votes);
  try {
    saveReceipt(receipt, leg.rawBody);
  } catch (err) {
    // F5: a failed persist is logged, never silent (txLookup.ts precedent)
    // — the answer still ships, but a receipt_id whose audit URL 404s
    // must be visible. Mirrors txLookup.ts:874-882.
    console.warn(
      `verireceipt: failed to persist VALIDATOR receipt ${receipt.receipt_id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const answer =
    `Validator ${index} has an effective balance of ${leg.effectiveBalance} gwei ` +
    `(status ${leg.status}), verified by ${votes}.`;
  return envelope(
    INTENT,
    {
      validator_index: index,
      effective_balance: leg.effectiveBalance,
      status: leg.status,
    },
    receipt,
    { answer, verdict: "verified", confidence: 1.0, source: BEACON_SOURCES.join(" + ") },
  );
}
