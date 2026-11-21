// GET /v1/validator — effective_balance (gwei) of an Ethereum validator.
//
// Zero-LLM. Calls the standard beacon API path
// /eth/v1/beacon/states/head/validators/{index} on THREE independently
// operated keyless public beacon sources and answers only when at least
// TWO agree on effective_balance AND status (VR, 2026-11-21: was 2-of-2
// on two sources, so one rate-limited source — a 429 — failed the whole
// request). A single-source answer is NEVER served as verified: fewer
// than two agreeing sources fails closed with 502 QUORUM_UNREACHABLE (no
// answer, no receipt), and any source that answered with a DIFFERENT
// value than the agreeing pair — or returned 404 while the pair found
// the validator — fails closed with 502 QUORUM_CONFLICT (a 2-vs-1 split
// is not certified).
//
// Order independence (V-M1, J2 round 2): when a pair first agrees, the
// third source is still awaited for min(VALIDATOR_STRAGGLER_GRACE_MS =
// 1000 ms, time left in the 4.5 s budget) (ROUTE's straggler-grace rule),
// and the verdict is computed once over everything that arrived. So the
// same three answers give the same verdict whatever order they arrive
// in, as long as the third lands within the grace. A third source that
// fails, times out, or answers after the grace / budget does not count
// (it never answered in time) and does not block the pair.
//
// VR transient-error policy: HTTP 429/500/502/503/504 get ONE bounded
// retry per source, inside the same request budget. The wait honours
// the source's Retry-After (delta-seconds or HTTP-date), else
// RETRY_BASE_DELAY_MS for 5xx / RETRY_429_DEFAULT_DELAY_MS for 429. If
// Retry-After exceeds RETRY_AFTER_CAP_MS, or the
// wait would leave less than MIN_RETRY_WINDOW_MS of the budget, the
// source is NOT retried (never called sooner than it asked). 404,
// other malformed bodies and timeouts are not retried; an
// execution_optimistic=true answer is retried once after
// RETRY_BASE_DELAY_MS (and still never accepted). Each leg is additionally
// bound to the requested validator (data.index must equal the requested
// index), rejected if the node flags it execution_optimistic, and
// rejected if its status is outside the nine-value beacon status enum.
// At least two sources 404 and none returning the validator means the
// validator does not exist: 422
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
// leg (the first-arrived leg of the agreeing group) and stores
// those bytes as evidence via saveReceipt(receipt, rawBody), so a
// re-hash of GET /receipts/:id/raw always matches. The receipt's
// upstream_url is that leg's full request URL.

import { ApiError, badRequest, unprocessable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/db";
import { TIMEOUT_MS } from "../config/limits";

export const INTENT = "VALIDATOR_PERFORMANCE_VERIFY_GENERAL";

/**
 * The three keyless beacon API bases (three independent operators). Verified live 2026-11-20 (see
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
 * 3. Stakely public Ethereum Beacon API endpoint (VR, wired in
 *    2026-11-21; previously the verified alternate): same three indices,
 *    same values, verified live 2026-11-20 ~18:46-18:51 UTC and again
 *    2026-11-21 01:37 UTC from the build box (all three sources returned
 *    1 -> 32000000000 active_ongoing, 100000/500000 -> 0 withdrawal_done).
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
  "https://ethereum-beacon-api.stakely.io",
];

/**
 * Straggler grace (V-M1, J2 round 2): after two sources agree, how long
 * the third source is still awaited before the verdict, capped by the
 * time left in the request budget. Same value and rule as ROUTE's
 * QUORUM_STRAGGLER_GRACE_MS. Live answer times from the build box
 * (2026-11-21): ~0.05 s, ~0.15-0.96 s and ~0.53-0.76 s per source, so a
 * healthy third source lands inside the grace.
 */
export const VALIDATOR_STRAGGLER_GRACE_MS = 1000;

/** Minimum number of agreeing sources for a verified answer (and for "does not exist"). */
export const VALIDATOR_MIN_AGREEING = 2;
/** Attempts per source (2 = one retry). */
export const VALIDATOR_MAX_ATTEMPTS = 2;
/** HTTP statuses treated as transient and retried once. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
/** Wait before the retry (5xx, optimistic) when the source sent no usable Retry-After. */
export const RETRY_BASE_DELAY_MS = 250;
/**
 * Wait before retrying a 429 that carried no usable Retry-After. Longer
 * than the 5xx default because rate-limit windows are usually >= 1 s:
 * measured live from the build box on 2026-11-21 against the source that
 * 429s us, a second call after 250 ms never succeeded (0 of 4), after
 * 1000 ms 1 of 5, after 2000 ms 2 of 4 (small sample). 1500 ms still
 * leaves >= MIN_RETRY_WINDOW_MS of the 4500 ms budget after a typical
 * ~0.7 s first attempt.
 */
export const RETRY_429_DEFAULT_DELAY_MS = 1500;
/** A Retry-After longer than this is honoured by NOT retrying. */
export const RETRY_AFTER_CAP_MS = 2000;
/** A retry is only attempted if at least this much request budget remains after the wait. */
export const MIN_RETRY_WINDOW_MS = 1000;

/**
 * Parse an HTTP Retry-After value (RFC 9110 section 10.2.3): delta-seconds
 * or an HTTP-date. Returns the wait in ms (never negative), or undefined
 * when absent or unparseable. Pure, unit-tested.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // HTTP-date only (IMF-fixdate / obsolete forms all contain a letter);
  // reject bare numbers with signs/decimals that Date.parse might accept.
  if (!/[A-Za-z]/.test(v)) return undefined;
  const date = Date.parse(v);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

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
  /**
   * Request budget override in ms (test only, default 4500): bounds each
   * fetch attempt AND the whole request, retries included. Tests may
   * raise it; production must not.
   */
  timeoutMs?: number;
}

// Canonical decimal integer: no sign, no leading zeros ("01" is not an
// integer literal in the intent's JSON schema, `validator_index:
// integer`; J1/J2 round 2). "0" itself is valid.
const VALIDATOR_INDEX_RE = /^(0|[1-9][0-9]*)$/;

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
    // VR: tagged so the fetch leg can retry it once — a load-balanced
    // public endpoint can route to a backend whose execution client is
    // briefly optimistic (seen live from the build box on 2026-11-21,
    // intermittently, on one source). The data is still NEVER accepted.
    const err = new Error(
      `malformed beacon response from ${sourceUrl}: execution_optimistic is true (data not verified by the node)`,
    ) as Error & { optimistic: true };
    err.optimistic = true;
    throw err;
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

/** One-line reason a leg failed (no bodies, no secrets): status, timeout, or parse error class. */
function shortLegFailure(err: unknown): string {
  const status = httpStatusOf(err);
  if (status !== undefined) return `HTTP ${status}`;
  if (err !== null && typeof err === "object" && (err as { optimistic?: unknown }).optimistic === true) {
    // m2 (J1 round 2): name it — the node flagged its own answer as
    // execution_optimistic (unverified); it is not a malformed body.
    return "optimistic answer (execution_optimistic=true), rejected";
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || /abort/i.test(err.message)) return "timeout";
    if (err.message.startsWith("malformed beacon response")) return "malformed response";
    return "network error";
  }
  return "error";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read Retry-After from a fetch Response (tolerates header-less test stubs). */
function retryAfterHeader(res: Response): string | null {
  const headers = (res as { headers?: { get?: unknown } }).headers;
  if (headers && typeof headers.get === "function") {
    return (headers as Headers).get("retry-after");
  }
  return null;
}

/**
 * One source leg: up to VALIDATOR_MAX_ATTEMPTS attempts, all inside the
 * request budget that ends at deadlineAt. Each attempt has its own abort
 * timer of min(timeoutMs, time left). Only RETRYABLE_STATUSES are
 * retried, after the Retry-After wait (or RETRY_BASE_DELAY_MS), and only
 * when that wait is <= RETRY_AFTER_CAP_MS and still leaves
 * >= MIN_RETRY_WINDOW_MS of the budget, and never once the request has
 * already settled (requestDone). Network errors / timeouts are not
 * retried (they already consumed the budget).
 */
async function fetchValidatorFromSource(
  base: string,
  index: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  deadlineAt: number,
  requestDone: () => boolean = () => false,
  onRetry: (reason: string) => void = () => {},
): Promise<ValidatorLeg> {
  const sourceUrl = `${base}/eth/v1/beacon/states/head/validators/${index}`;
  for (let attempt = 1; ; attempt++) {
    const attemptMs = Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now()));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptMs);
    let res: Response;
    try {
      res = await fetchImpl(sourceUrl, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (res.ok) {
        const rawBody = await res.text();
        try {
          return parseValidatorResponse(rawBody, sourceUrl, index);
        } catch (parseErr) {
          // VR: an optimistic-head answer is transient (the node's EL is
          // catching up); retry once under the same budget rules. Every
          // other malformed body fails the leg at once.
          const optimistic =
            parseErr !== null &&
            typeof parseErr === "object" &&
            (parseErr as { optimistic?: unknown }).optimistic === true;
          if (
            !optimistic ||
            attempt >= VALIDATOR_MAX_ATTEMPTS ||
            deadlineAt - Date.now() - RETRY_BASE_DELAY_MS < MIN_RETRY_WINDOW_MS ||
            requestDone()
          ) {
            throw parseErr;
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      // optimistic answer: wait the base delay, then retry.
      onRetry("optimistic answer, retry pending");
      await sleep(RETRY_BASE_DELAY_MS);
      if (requestDone()) {
        throw new Error(`beacon source ${base} answered optimistic for validator ${index}; request already settled`);
      }
      continue;
    }
    // F4: surface the HTTP status so the handler can tell a dual-404
    // (validator does not exist) apart from a generic upstream failure.
    const err = new Error(
      `beacon source ${base} returned HTTP ${res.status} for validator ${index}` +
        (attempt > 1 ? ` (attempt ${attempt} of ${VALIDATOR_MAX_ATTEMPTS})` : ""),
    ) as Error & { httpStatus: number };
    err.httpStatus = res.status;
    if (attempt >= VALIDATOR_MAX_ATTEMPTS || !RETRYABLE_STATUSES.has(res.status)) throw err;
    const waitMs =
      parseRetryAfterMs(retryAfterHeader(res)) ??
      (res.status === 429 ? RETRY_429_DEFAULT_DELAY_MS : RETRY_BASE_DELAY_MS);
    if (waitMs > RETRY_AFTER_CAP_MS) throw err;
    if (deadlineAt - Date.now() - waitMs < MIN_RETRY_WINDOW_MS) throw err;
    // Never start a retry for a request that has already been answered
    // (or failed): no wasted calls to a source that is rate-limiting us.
    if (requestDone()) throw err;
    onRetry(`HTTP ${res.status}, retry pending`);
    await sleep(waitMs);
    if (requestDone()) throw err;
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
  // One request budget shared by all legs (F6 round 2 + VR): every
  // attempt, retry and wait below ends by deadlineAt, so the whole
  // request ends within ~timeoutMs even when a leg never settles.
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeoutMs;
  const n = BEACON_SOURCES.length;
  // Per-source outcome, filled in as each leg settles.
  //   legResults[i]    the parsed answer (leg returned a validator)
  //   legHttpStatus[i] 200, or the HTTP status a failed leg ended on
  //   legFailure[i]    short operator-facing reason for a failed leg
  //   arrival          source indices in the order their answers came
  const legResults: Array<ValidatorLeg | undefined> = BEACON_SOURCES.map(() => undefined);
  const legHttpStatus: Array<number | undefined> = BEACON_SOURCES.map(() => undefined);
  const legFailure: Array<string | undefined> = BEACON_SOURCES.map(() => undefined);
  const legSettled: boolean[] = BEACON_SOURCES.map(() => false);
  const arrival: number[] = [];
  let requestSettled = false;
  const requestDone = (): boolean => requestSettled;
  const same = (a: ValidatorLeg, b: ValidatorLeg): boolean =>
    a.effectiveBalance === b.effectiveBalance && a.status === b.status;

  /** Largest group of answers that agree, in arrival order (empty if none). */
  const largestGroup = (): number[] => {
    let best: number[] = [];
    for (const i of arrival) {
      const li = legResults[i] as ValidatorLeg;
      const group = arrival.filter((j) => same(li, legResults[j] as ValidatorLeg));
      if (group.length > best.length) best = group;
    }
    return best;
  };

  // V-M1 (J2 round 2): the verdict must not depend on arrival order.
  // When a pair first agrees, the decision is NOT taken at once: the
  // remaining source gets a bounded straggler grace —
  // min(VALIDATOR_STRAGGLER_GRACE_MS, time left in the budget), the same
  // rule as ROUTE's QUORUM_STRAGGLER_GRACE_MS — and the verdict is then
  // computed from everything that arrived (see decide() below). A
  // dissent that arrives inside the grace refuses the answer exactly as
  // a dissent that arrived first. A leg that failed / timed out does not
  // block. Early exits only where the verdict can no longer change:
  // every leg settled, a dissent already seen next to a pair (conflict
  // is final), or neither an answer nor a "does not exist" is reachable.
  await new Promise<void>((resolve) => {
    let finished = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve();
    };
    const deadlineTimer = setTimeout(finish, Math.max(0, deadlineAt - Date.now()));
    const check = (): void => {
      if (finished) return;
      const pending = legSettled.filter((x) => !x).length;
      if (pending === 0) return finish();
      const group = largestGroup();
      const n404 = legHttpStatus.filter((st) => st === 404).length;
      if (group.length >= VALIDATOR_MIN_AGREEING) {
        // Conflict already certain: an answer outside the group, or a
        // 404 next to a pair that found the validator.
        if (arrival.length > group.length || n404 > 0) return finish();
        if (graceTimer === undefined) {
          const graceMs = Math.max(0, Math.min(VALIDATOR_STRAGGLER_GRACE_MS, deadlineAt - Date.now()));
          graceTimer = setTimeout(finish, graceMs);
        }
        return;
      }
      // No pair yet. Can one still form? Can "does not exist" (>= 2
      // 404s and no answer) still be reached? If neither, stop now.
      const pairPossible = group.length + pending >= VALIDATOR_MIN_AGREEING || pending >= VALIDATOR_MIN_AGREEING;
      const notFoundPossible = arrival.length === 0 && n404 + pending >= VALIDATOR_MIN_AGREEING;
      if (!pairPossible && !notFoundPossible) finish();
    };
    BEACON_SOURCES.forEach((base, i) => {
      fetchValidatorFromSource(base, index, fetchImpl, timeoutMs, deadlineAt, requestDone, (reason) => {
        legFailure[i] = reason;
      }).then(
        (leg) => {
          if (finished) return; // arrived after the decision: not counted
          legResults[i] = leg;
          legHttpStatus[i] = 200;
          legSettled[i] = true;
          arrival.push(i);
          check();
        },
        (err: unknown) => {
          if (finished) return;
          legHttpStatus[i] = httpStatusOf(err);
          legFailure[i] = shortLegFailure(err);
          legSettled[i] = true;
          check();
        },
      );
    });
  });
  // The request is decided: legs still waiting to retry stop here, and
  // anything that arrives later is ignored (it was outside the budget).
  requestSettled = true;

  const perSource = (): string =>
    BEACON_SOURCES.map((base, i) => {
      const host = new URL(base).hostname;
      if (legResults[i] !== undefined) {
        const l = legResults[i] as ValidatorLeg;
        return `${host}: ok (${l.status})`;
      }
      if (!legSettled[i]) return `${host}: ${legFailure[i] ?? "no answer"} (not settled within budget)`;
      return `${host}: ${legFailure[i] ?? "error"}`;
    }).join("; ");

  // decide(): one rule over the final snapshot, independent of order.
  const group = largestGroup();
  const answeredCount = arrival.length;
  const n404 = legHttpStatus.filter((st) => st === 404).length;
  if (group.length >= VALIDATOR_MIN_AGREEING) {
    // VR + v-m1 (J2 round 2): any answer outside the agreeing group, or
    // a 404 ("does not exist") from a source while the others found the
    // validator, is a dissent; a split is never certified as verified.
    if (answeredCount > group.length || n404 > 0) {
      throw new ApiError(
        502,
        "QUORUM_CONFLICT",
        `beacon sources disagree on validator ${index}: ${group.length} agree, ` +
          `${answeredCount - group.length} answered differently, ${n404} returned 404 [${perSource()}]`,
      );
    }
  } else {
    // F4 + VR: "does not exist" needs the same two-source standard as an
    // answer — at least VALIDATOR_MIN_AGREEING sources observed 404 and
    // NO source returned the validator (repo precedent: filings 404 ->
    // 422 ENTITY_NOT_FOUND, TVL unknown -> 422 PROTOCOL_NOT_FOUND).
    if (n404 >= VALIDATOR_MIN_AGREEING && answeredCount === 0) {
      throw unprocessable(
        "VALIDATOR_NOT_FOUND",
        `validator ${index} does not exist (${n404} of ${n} beacon sources returned 404)`,
      );
    }
    throw new ApiError(
      502,
      "QUORUM_UNREACHABLE",
      `quorum unreachable: ${answeredCount} of ${n} sources answered and no ${VALIDATOR_MIN_AGREEING} agree [${perSource()}]`,
    );
  }
  // Evidence = the exact raw body of the first-arrived leg of the
  // agreeing group; provenance names only the agreeing sources.
  const leg = legResults[group[0]] as ValidatorLeg;
  const votes = `${group.length}/${n} sources agreed`;
  const agreeingSources = BEACON_SOURCES.filter((_, i) => group.includes(i));
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
    { answer, verdict: "verified", confidence: 1.0, source: agreeingSources.join(" + ") },
  );
}
