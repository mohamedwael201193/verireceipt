// GET /v1/validator — effective_balance (gwei) of an Ethereum validator.
//
// Zero-LLM. Calls the standard beacon API on FOUR independently operated
// keyless public beacon sources (A9 r2: was three) and answers only
// when at least TWO agree on effective_balance AND status (2-of-N,
// N = BEACON_SOURCES.length). A single-source answer is NEVER served
// as verified: fewer than two agreeing sources fails closed with 502
// QUORUM_UNREACHABLE (no answer, no receipt), and any source that
// answered with a DIFFERENT value than the agreeing pair — or returned
// 404 while the pair found the validator — fails closed with 502
// QUORUM_CONFLICT (a 2-vs-1, or any dissent, is not certified). The
// first agreeing pair wins once every started source has settled or
// can no longer answer inside the budget; conflict rules are unchanged
// from r1. MIN_AGREEING is never lowered to absorb a 429.
//
// A9 r2 finalized-state binding: an agreed finalized state root is
// resolved from >= 2 non-optimistic sources (PublicNode, blockreq,
// Stakely; ChainSafe is not used for root resolution so its rate
// budget is reserved for a validator leg). Validator legs then query
// states/{root}/validators/{index} when the host supports root-pin
// (PublicNode, ChainSafe, Stakely). blockreq returns 501 for
// states/{root}/*; its vote is taken from states/finalized/validators
// only after states/finalized/root equals the agreed root.
//
// Stakely exception (root-pin only): Stakely may flag
// execution_optimistic=true even on a finalized root. If — and only if
// — GET states/{root}/root returns data.root equal to the agreed root
// and finalized===true, the validator body for that exact root is
// accepted even when execution_optimistic is true. Head or
// finalized-label optimistic data is still rejected. A mismatched
// bind fails the leg; it is not counted as a value vote.
//
// Verified-result cache: once 2-of-N agree on a finalized state, the
// envelope (including the original receipt and finalized_state_root)
// is cached under (validator_index, finalized state root) and served
// unchanged until the agreed root advances, at which point the index
// is re-verified. Every verified envelope names the finalized root it
// is bound to; a cached envelope is never relabelled as a newer root.
// After the 12 s root-cache TTL, a failed fresh root quorum fails
// closed (502) instead of presenting a last-known root as current.
// A cached answer is NEVER used as a cross-check vote for a different
// (or unknown) root, and is never served as a 1-of-N substitute.
// The verified Map is a bounded LRU (VERIFIED_CACHE_MAX_ENTRIES).
//
// Rate-aware pacing: a 429 on any host puts that host in a cooldown
// (Retry-After, capped). ChainSafe additionally has a 1-token bucket
// (refill 2 s, emptied on 429) sized from observed nginx 429s. A
// cooled-down / empty-bucket source is not started (failure
// "skipped (rate-limited)"); already-started sources still wait under
// the conflict rules. Prefer PublicNode, blockreq and Stakely.
//
// Order independence (V-M1, J2 round 2; J1 R1, round 3): when a pair
// first agrees, the verdict is NOT taken while the third source can
// still answer inside the 4.5 s budget — an attempt still in flight
// (its abort timer never outlives the budget) or a retry already
// scheduled to land inside it (e.g. a 429 back-off). The verdict is
// computed once over everything that arrived, so the same three answers
// give the same verdict whatever order they arrive in, anywhere inside
// the budget — including a dissent that only comes back on a 429 retry.
// A source that answers only after the 4.5 s budget is not counted
// (it cannot complete a quorum and cannot flip a verified pair into
// a conflict). When an unsettled source has DEFINITIVELY failed
// (non-retryable status,
// optimistic again after its retry, no budget left for a retry, network
// error, timeout), the pair is decided at once, with no fixed wait. A
// source that never answers inside the budget does not count and does
// not block the pair beyond the budget.
//
// VR + A9 transient-error policy: HTTP 429/500/502/503/504 get ONE
// bounded retry per source, inside the same request budget. The wait
// honours the source's Retry-After (delta-seconds or HTTP-date), else
// RETRY_BASE_DELAY_MS for 5xx / RETRY_429_DEFAULT_DELAY_MS for 429,
// capped at RETRY_AFTER_CAP_MS so a 5–10 s nginx Retry-After still
// gets one short retry inside the 4.5 s budget instead of being
// skipped. If the (capped) wait would leave less than
// MIN_RETRY_WINDOW_MS of the budget, the source is NOT retried. 404,
// other malformed bodies and timeouts are not retried; an
// execution_optimistic=true answer is retried once after
// RETRY_BASE_DELAY_MS (and still never accepted). Each leg is additionally
// bound to the requested validator (data.index must equal the requested
// index), rejected if the node flags it execution_optimistic (except
// the Stakely root-pin bind described above), and rejected if its
// status is outside the nine-value beacon status enum.
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
import { saveReceipt } from "../core/storage";
import { TIMEOUT_MS } from "../config/limits";

export const INTENT = "VALIDATOR_PERFORMANCE_VERIFY_GENERAL";

/**
 * Per-source capabilities for the four keyless mainnet beacon REST bases
 * (four independent operators). BEACON_SOURCES is derived from this
 * list and keeps the r1 order so existing fixtures that stage
 * [ChainSafe, PublicNode, Stakely] keep their meaning; the fourth
 * entry is blockreq.
 *
 * 1. ChainSafe Lodestar public mainnet node
 *    (https://lodestar-mainnet.chainsafe.io). Verified 2026-11-20
 *    ~18:32–18:58 UTC and again 2026-11-21: answers
 *    states/finalized/validators/{id} and states/{root}/validators/{id}
 *    with finalized=true, execution_optimistic=false, no API key.
 *    nginx 429s under modest load (Retry-After typically 5–10 s);
 *    paced with a 1-token bucket (A9 r2). peer_id
 *    16Uiu2HAmPCHN6LsNv7RUoc2iFBbWWDSkxBq5Bo7…, egress 65.108.66.225.
 *
 * 2. PublicNode public Ethereum Beacon API
 *    (https://ethereum-beacon-api.publicnode.com). Same indices, same
 *    values; fast (~30–60 ms). Root-pin supported. peer_id
 *    16Uiu2HAkvQVKG6XjhN2G7wTJBw3R1dM9qspfK8J… . Independent
 *    verification-2026-11-20.md rows 25-27.
 *
 * 3. Stakely public Ethereum Beacon API
 *    (https://ethereum-beacon-api.stakely.io). Same values. Root-pin
 *    supported. states/finalized and states/{root}/validators can
 *    return finalized=true AND execution_optimistic=true; states/{root}/root
 *    is used to bind the body to the agreed root (A9 r2). peer_id
 *    16Uiu2HAm3rY69UsNs8qxHhzq7saH51Zys8n22d2…, egress 185.181.229.82.
 *
 * 4. blockreq public Ethereum Beacon RPC
 *    (https://ethereum-beacon-rpc.blockreq.com). Verified live from
 *    this build box on 2026-11-21: no API key; Lighthouse/v8.3.3-57c2abc;
 *    genesis_time 1606824023 (mainnet); states/finalized/root matched
 *    PublicNode; validators 1, 2, 1000, 100000, 500000, 700000 matched
 *    PublicNode exactly (finalized=true, execution_optimistic=false).
 *    states/{root}/* and /eth/v1/node/identity return 501 ("not
 *    available on the public endpoint") — votes are finalized-label
 *    + finalized/root bind, never root-pinned.
 *
 * Rejected candidates (verified live, A9 r2 hunt 2026-11-21 and
 * earlier): BlastAPI (unverifiable / proxy abort); SigP checkpoint,
 * beaconcha.in checkpoint-sync, Checkpointz, EthStaker checkpoint
 * (HTTP 404 on the validators path); dRPC (400 paid-only); Nimbus
 * official HTTP test endpoints (HTTP 500); Tatum public beacon
 * (works, different peer_id 16Uiu2HAmUgXB9yRH3eaJ3Ro2zuWAa2Q9qp1Wo5q…
 * from PublicNode/Stakely/ChainSafe, but documented 5 req/min — not a
 * production quorum leg); other PublicNode beacon hosts (404 on
 * validators).
 */
export interface BeaconSourceCap {
  /** Short stable id (logs / tests). */
  id: string;
  /** Keyless base URL, no trailing slash. */
  base: string;
  /** Host implements GET /eth/v1/beacon/states/{state_root}/… */
  rootPin: boolean;
  /** Apply the ChainSafe token bucket in addition to generic 429 cooldown. */
  paced: boolean;
  /**
   * Accept execution_optimistic=true only after states/{root}/root
   * equals the agreed finalized root (Stakely).
   */
  allowOptimisticIfRootBound: boolean;
}

export const BEACON_SOURCE_CAPS: readonly BeaconSourceCap[] = [
  {
    id: "chainsafe",
    base: "https://lodestar-mainnet.chainsafe.io",
    rootPin: true,
    paced: true,
    allowOptimisticIfRootBound: false,
  },
  {
    id: "publicnode",
    base: "https://ethereum-beacon-api.publicnode.com",
    rootPin: true,
    paced: false,
    allowOptimisticIfRootBound: false,
  },
  {
    id: "stakely",
    base: "https://ethereum-beacon-api.stakely.io",
    rootPin: true,
    paced: false,
    allowOptimisticIfRootBound: true,
  },
  {
    id: "blockreq",
    base: "https://ethereum-beacon-rpc.blockreq.com",
    rootPin: false,
    paced: false,
    allowOptimisticIfRootBound: false,
  },
];

export const BEACON_SOURCES: readonly string[] = BEACON_SOURCE_CAPS.map((s) => s.base);


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

/** Max time spent resolving the finalized root, leaving budget for validator legs. */
export const ROOT_RESOLVE_BUDGET_MS = 800;
/** Agreed finalized-root cache TTL (finality advances every ~12 min; 12 s is conservative). */
export const FINALIZED_ROOT_CACHE_TTL_MS = 12_000;
/**
 * Max entries in the verified-result Map (LRU). Unique (index, root)
 * keys evict the least-recently used entry when the cap is reached.
 * 10,000 is well above a session's first-seen indexes for one root
 * (and a handful of recent finalized roots) and bounds process memory.
 */
export const VERIFIED_CACHE_MAX_ENTRIES = 10_000;
/** ChainSafe token-bucket capacity. Observed 2026-11-21: 1–2 successes then nginx 429. */
export const CHAINSAFE_BUCKET_CAPACITY = 1;
/** ChainSafe token refill interval (ms). */
export const CHAINSAFE_BUCKET_REFILL_MS = 2_000;
/** 32-byte state root: 0x + 64 hex chars. */
export const FINALIZED_STATE_ROOT_RE = /^0x[0-9a-fA-F]{64}$/;

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
  /** Clock override (test only) for cache / bucket TTL. */
  nowMs?: () => number;
}

// Canonical decimal integer: no sign, no leading zeros ("01" is not an
// integer literal in the intent's JSON schema, `validator_index:
// integer`; J1/J2 round 2). "0" itself is valid.
const VALIDATOR_INDEX_RE = /^(0|[1-9][0-9]*)$/;

// ---------------------------------------------------------------------------
// A9 r2: verified-result cache, finalized-root cache, per-host pacing.
// ---------------------------------------------------------------------------

interface VerifiedCacheEntry {
  envelope: Record<string, unknown>;
  root: string;
  index: number;
}

interface FinalizedRootCacheEntry {
  root: string;
  atMs: number;
}

const verifiedCache = new Map<string, VerifiedCacheEntry>();
let finalizedRootCache: FinalizedRootCacheEntry | undefined;

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
  cooldownUntilMs: number;
}

let chainsafeBucket: TokenBucket = {
  tokens: CHAINSAFE_BUCKET_CAPACITY,
  lastRefillMs: 0,
  cooldownUntilMs: 0,
};

/** Per-host 429 cooldown (all sources). */
const hostCooldownUntilMs = new Map<string, number>();

function verifiedCacheKey(index: number, root: string): string {
  return `${index}:${root.toLowerCase()}`;
}

/** Move `key` to the most-recently-used end and evict if over cap. */
function rememberVerified(key: string, entry: VerifiedCacheEntry): void {
  if (verifiedCache.has(key)) verifiedCache.delete(key);
  verifiedCache.set(key, entry);
  while (verifiedCache.size > VERIFIED_CACHE_MAX_ENTRIES) {
    const oldest = verifiedCache.keys().next().value;
    if (oldest === undefined) break;
    verifiedCache.delete(oldest);
  }
}

function takeVerified(index: number, root: string): VerifiedCacheEntry | undefined {
  const key = verifiedCacheKey(index, root);
  const hit = verifiedCache.get(key);
  if (hit === undefined) return undefined;
  // Refresh LRU order on a hit so a frequently served (index, root)
  // is not evicted ahead of a colder entry.
  verifiedCache.delete(key);
  verifiedCache.set(key, hit);
  return hit;
}

function refillChainSafeBucket(now: number): void {
  if (now < chainsafeBucket.cooldownUntilMs) {
    chainsafeBucket.tokens = 0;
    return;
  }
  if (chainsafeBucket.lastRefillMs === 0) {
    chainsafeBucket.lastRefillMs = now;
    return;
  }
  const elapsed = now - chainsafeBucket.lastRefillMs;
  if (elapsed >= CHAINSAFE_BUCKET_REFILL_MS) {
    const add = Math.floor(elapsed / CHAINSAFE_BUCKET_REFILL_MS);
    chainsafeBucket.tokens = Math.min(CHAINSAFE_BUCKET_CAPACITY, chainsafeBucket.tokens + add);
    chainsafeBucket.lastRefillMs += add * CHAINSAFE_BUCKET_REFILL_MS;
  }
}

/** Test-only: empty caches, refill the ChainSafe bucket, clear cooldowns. */
export function resetValidatorCachesForTests(nowMs: number = Date.now()): void {
  verifiedCache.clear();
  finalizedRootCache = undefined;
  hostCooldownUntilMs.clear();
  chainsafeBucket = {
    tokens: CHAINSAFE_BUCKET_CAPACITY,
    lastRefillMs: nowMs,
    cooldownUntilMs: 0,
  };
}

/** Test-only: inspect the verified cache size. */
export function verifiedCacheSizeForTests(): number {
  return verifiedCache.size;
}

/** Test-only: whether (index, root) is in the verified cache. */
export function verifiedCacheHasForTests(index: number, root: string): boolean {
  return verifiedCache.has(verifiedCacheKey(index, root));
}

/**
 * Test-only: insert via the production LRU path (so cap / eviction
 * can be exercised without 10,000 live quorum calls).
 */
export function rememberVerifiedForTests(
  index: number,
  root: string,
  envelope: Record<string, unknown> = { validator_index: index, finalized_state_root: root },
): void {
  rememberVerified(verifiedCacheKey(index, root), { envelope, root, index });
}

/** Test-only: LRU-touch a cached entry the same way a cache hit does. */
export function touchVerifiedForTests(index: number, root: string): boolean {
  return takeVerified(index, root) !== undefined;
}

export function isChainSafeBase(base: string): boolean {
  return new URL(base).hostname === "lodestar-mainnet.chainsafe.io";
}

export function chainsafeCanStart(nowMs: number = Date.now()): boolean {
  refillChainSafeBucket(nowMs);
  return chainsafeBucket.tokens >= 1 && nowMs >= chainsafeBucket.cooldownUntilMs;
}

export function chainsafeTakeToken(nowMs: number = Date.now()): boolean {
  refillChainSafeBucket(nowMs);
  if (chainsafeBucket.tokens < 1 || nowMs < chainsafeBucket.cooldownUntilMs) return false;
  chainsafeBucket.tokens -= 1;
  return true;
}

export function chainsafeOn429(retryAfterMs: number | undefined, nowMs: number = Date.now()): void {
  chainsafeBucket.tokens = 0;
  chainsafeBucket.lastRefillMs = nowMs;
  const cool =
    retryAfterMs !== undefined
      ? Math.min(Math.max(retryAfterMs, CHAINSAFE_BUCKET_REFILL_MS), 10_000)
      : CHAINSAFE_BUCKET_REFILL_MS;
  chainsafeBucket.cooldownUntilMs = nowMs + cool;
}

export function noteSource429(base: string, retryAfterMs: number | undefined, nowMs: number = Date.now()): void {
  const wait = Math.min(Math.max(retryAfterMs ?? CHAINSAFE_BUCKET_REFILL_MS, 500), 10_000);
  hostCooldownUntilMs.set(base, nowMs + wait);
  if (isChainSafeBase(base)) chainsafeOn429(retryAfterMs, nowMs);
}

export function canStartSource(cap: BeaconSourceCap, nowMs: number = Date.now()): boolean {
  const until = hostCooldownUntilMs.get(cap.base) ?? 0;
  if (nowMs < until) return false;
  if (cap.paced) return chainsafeCanStart(nowMs);
  return true;
}

function normalizeStateRoot(root: string): string {
  return root.toLowerCase();
}

export function parseStateRootResponse(rawBody: string, sourceUrl: string): {
  root: string;
  finalized: boolean;
  executionOptimistic: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error(`malformed beacon root response from ${sourceUrl}: not JSON`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`malformed beacon root response from ${sourceUrl}: top level is not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.execution_optimistic !== "boolean") {
    throw new Error(
      `malformed beacon root response from ${sourceUrl}: execution_optimistic is missing or not a boolean`,
    );
  }
  if (obj.finalized !== true) {
    throw new Error(
      `malformed beacon root response from ${sourceUrl}: finalized is missing or not true`,
    );
  }
  const data = obj.data;
  if (data === null || typeof data !== "object") {
    throw new Error(`malformed beacon root response from ${sourceUrl}: missing data object`);
  }
  const root = (data as Record<string, unknown>).root;
  if (typeof root !== "string" || !FINALIZED_STATE_ROOT_RE.test(root)) {
    throw new Error(`malformed beacon root response from ${sourceUrl}: data.root is not a 32-byte hex root`);
  }
  return {
    root: normalizeStateRoot(root),
    finalized: true,
    executionOptimistic: obj.execution_optimistic,
  };
}

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
export interface ParseValidatorOptions {
  /**
   * When true (only after states/{root}/root matched the agreed
   * finalized root), execution_optimistic=true is accepted. finalized
   * must still be boolean true. Default false — head / finalized-label
   * optimistic data is still rejected.
   */
  allowOptimisticIfRootBound?: boolean;
}

export function parseValidatorResponse(
  rawBody: string,
  sourceUrl: string,
  expectedIndex: number,
  opts: ParseValidatorOptions = {},
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
  // A9: we query states/finalized, so the body must explicitly vouch
  // that this is finalized state. Only boolean `true` is accepted —
  // missing / non-boolean / false (a head payload) fails the leg and
  // is never served as verified. Measured 2026-11-21: Stakely's
  // states/head was execution_optimistic=true and finalized=false;
  // the same host's states/finalized was finalized=true and
  // execution_optimistic=false.
  if (parsedObj.finalized !== true) {
    throw new Error(
      `malformed beacon response from ${sourceUrl}: finalized is missing or not true (refusing non-finalized state)`,
    );
  }
  // F2: optimistic-head / unverified-EL data is rejected, except the
  // A9 r2 root-pin path: after states/{root}/root equals the agreed
  // finalized root, Stakely's optimistic flag on that exact root is
  // allowed (the bind, not the flag, is the voucher).
  if (parsedObj.execution_optimistic === true) {
    if (opts.allowOptimisticIfRootBound === true) {
      // accepted: caller already verified states/{root}/root.
    } else {
      const err = new Error(
        `malformed beacon response from ${sourceUrl}: execution_optimistic is true (data not verified by the node)`,
      ) as Error & { optimistic: true };
      err.optimistic = true;
      throw err;
    }
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
 * retried, after the Retry-After wait (or RETRY_BASE_DELAY_MS),
 * capped at RETRY_AFTER_CAP_MS (a longer Retry-After still retries
 * once after the cap, inside the budget). The wait must leave
 * >= MIN_RETRY_WINDOW_MS of the budget, and is never started once the
 * request has already settled (requestDone). Network errors / timeouts
 * are not retried (they already consumed the budget).
 */
async function fetchStateRoot(
  base: string,
  stateId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  deadlineAt: number,
): Promise<{ root: string; executionOptimistic: boolean; httpStatus: number; retryAfterMs?: number }> {
  const sourceUrl = `${base}/eth/v1/beacon/states/${stateId}/root`;
  const attemptMs = Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), attemptMs);
  let res: Response;
  try {
    res = await fetchImpl(sourceUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(`beacon source ${base} returned HTTP ${res.status} for state root ${stateId}`) as Error & {
      httpStatus: number;
    };
    err.httpStatus = res.status;
    if (res.status === 429) {
      noteSource429(base, parseRetryAfterMs(retryAfterHeader(res)));
    }
    throw err;
  }
  const rawBody = await res.text();
  const parsed = parseStateRootResponse(rawBody, sourceUrl);
  return { root: parsed.root, executionOptimistic: parsed.executionOptimistic, httpStatus: res.status };
}

/**
 * Resolve the current finalized state root from >= 2 non-optimistic
 * sources. ChainSafe is not queried here (rate budget reserved for a
 * validator leg). Optimistic roots that match the majority are ignored,
 * not counted and not treated as dissent; a different root from any
 * source (optimistic or not) is a conflict. After the 12 s TTL, a
 * failed fresh quorum returns undefined (the handler fails closed);
 * a last-known root is never presented as the current root.
 *
 * Each probe is hard-capped at the root budget (and the request
 * deadline) so a source that ignores AbortSignal cannot hang the
 * request. The budget is at most ROOT_RESOLVE_BUDGET_MS and always
 * leaves time for validator legs.
 */
async function resolveFinalizedRoot(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  deadlineAt: number,
  nowMs: number,
): Promise<string | undefined> {
  if (finalizedRootCache && nowMs - finalizedRootCache.atMs < FINALIZED_ROOT_CACHE_TTL_MS) {
    return finalizedRootCache.root;
  }
  const reservedForLegs = Math.min(1_000, Math.max(200, Math.floor(timeoutMs / 2)));
  const rootBudget = Math.min(ROOT_RESOLVE_BUDGET_MS, Math.max(50, timeoutMs - reservedForLegs));
  const rootDeadlineAt = Math.min(deadlineAt, Date.now() + rootBudget);

  const rootSources = BEACON_SOURCE_CAPS.filter((cap) => !cap.paced);
  type RootVote =
    | { base: string; root: string; optimistic: boolean }
    | { base: string; error: unknown };
  const votes: RootVote[] = await Promise.all(
    rootSources.map(async (cap) => {
      const left = Math.max(1, rootDeadlineAt - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const got = await Promise.race([
          fetchStateRoot(cap.base, "finalized", fetchImpl, timeoutMs, rootDeadlineAt),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const err = new Error(`beacon source ${cap.base} state root timed out`);
              err.name = "AbortError";
              reject(err);
            }, left);
          }),
        ]);
        return { base: cap.base, root: got.root, optimistic: got.executionOptimistic };
      } catch (error) {
        return { base: cap.base, error };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );

  const ok = votes.filter((v): v is { base: string; root: string; optimistic: boolean } => "root" in v);
  if (ok.length >= 1) {
    const roots = [...new Set(ok.map((v) => v.root))];
    if (roots.length > 1) {
      throw new ApiError(
        502,
        "QUORUM_CONFLICT",
        `beacon sources disagree on finalized state root: ${ok
          .map((v) => `${new URL(v.base).hostname}=${v.root.slice(0, 10)}…(opt=${v.optimistic})`)
          .join(", ")}`,
      );
    }
    const agreed = roots[0];
    const nonOptimistic = ok.filter((v) => v.root === agreed && v.optimistic === false).length;
    if (nonOptimistic >= VALIDATOR_MIN_AGREEING) {
      finalizedRootCache = { root: agreed, atMs: nowMs };
      return agreed;
    }
  }
  // A9 r3 (J2 m1): do not reuse a last-known root as the current
  // identifier. After the 12 s TTL, fail closed rather than serve a
  // previous root as if it were still current.
  return undefined;
}

interface FetchSourceOpts {
  expectedRoot?: string;
  cap: BeaconSourceCap;
}

/**
 * One source leg: up to VALIDATOR_MAX_ATTEMPTS attempts, all inside the
 * request budget that ends at deadlineAt. Each attempt has its own abort
 * timer of min(timeoutMs, time left). Only RETRYABLE_STATUSES are
 * retried, after the Retry-After wait (or RETRY_BASE_DELAY_MS),
 * capped at RETRY_AFTER_CAP_MS (a longer Retry-After still retries
 * once after the cap, inside the budget). The wait must leave
 * >= MIN_RETRY_WINDOW_MS of the budget, and is never started once the
 * request has already settled (requestDone). Network errors / timeouts
 * are not retried (they already consumed the budget).
 *
 * A9 r2: when expectedRoot is set, root-pin sources are queried at
 * states/{root}/validators/{index}. blockreq (no root-pin) is queried
 * at states/finalized/validators/{index} only after states/finalized/root
 * equals expectedRoot. Stakely may be accepted optimistic iff the
 * states/{root}/root bind succeeds.
 */
async function fetchValidatorFromSource(
  base: string,
  index: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  deadlineAt: number,
  requestDone: () => boolean = () => false,
  onRetry: (reason: string, retryAt: number) => void = () => {},
  opts?: FetchSourceOpts,
): Promise<ValidatorLeg> {
  const cap = opts?.cap ?? BEACON_SOURCE_CAPS.find((c) => c.base === base);
  const expectedRoot = opts?.expectedRoot !== undefined ? normalizeStateRoot(opts.expectedRoot) : undefined;
  const useRootPin = Boolean(expectedRoot && cap?.rootPin);
  const stateId = useRootPin ? (expectedRoot as string) : "finalized";
  const sourceUrl = `${base}/eth/v1/beacon/states/${stateId}/validators/${index}`;
  for (let attempt = 1; ; attempt++) {
    // Bind first when required: root-pin+optimistic-allow (Stakely), or
    // finalized-label sources (blockreq) whose vote is only valid for
    // the agreed root.
    let rootBound = false;
    const needsBind = Boolean(expectedRoot && cap && (cap.allowOptimisticIfRootBound || !cap.rootPin));
    if (needsBind && cap && expectedRoot) {
      const bindId = cap.rootPin ? expectedRoot : "finalized";
      try {
        const got = await fetchStateRoot(cap.base, bindId, fetchImpl, timeoutMs, deadlineAt);
        if (got.root !== expectedRoot) {
          throw new Error(
            `beacon source ${base} state root bind failed: got ${got.root} expected ${expectedRoot}`,
          );
        }
        rootBound = true;
      } catch (bindErr) {
        const status = httpStatusOf(bindErr);
        if (status === 501 && cap.rootPin) {
          // Host advertised root-pin but rejected this public path;
          // fall through to finalized-label bind.
          try {
            const got = await fetchStateRoot(cap.base, "finalized", fetchImpl, timeoutMs, deadlineAt);
            if (got.root !== expectedRoot) {
              throw new Error(
                `beacon source ${base} finalized-root bind failed: got ${got.root} expected ${expectedRoot}`,
              );
            }
            rootBound = true;
          } catch (fallbackErr) {
            throw fallbackErr;
          }
        } else if (status !== undefined && RETRYABLE_STATUSES.has(status) && attempt < VALIDATOR_MAX_ATTEMPTS) {
          const rawWaitMs =
            status === 429 ? RETRY_429_DEFAULT_DELAY_MS : RETRY_BASE_DELAY_MS;
          const waitMs = Math.min(rawWaitMs, RETRY_AFTER_CAP_MS);
          if (deadlineAt - Date.now() - waitMs < MIN_RETRY_WINDOW_MS || requestDone()) throw bindErr;
          onRetry(`HTTP ${status}, retry pending`, Date.now() + waitMs);
          await sleep(waitMs);
          if (requestDone()) throw bindErr;
          continue;
        } else {
          throw bindErr;
        }
      }
    }

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
          const allowOptimistic = Boolean(cap?.allowOptimisticIfRootBound && rootBound);
          return parseValidatorResponse(rawBody, sourceUrl, index, {
            allowOptimisticIfRootBound: allowOptimistic,
          });
        } catch (parseErr) {
          // VR: an optimistic-head answer is transient (the node's EL is
          // catching up); retry once under the same budget rules. Every
          // other malformed body fails the leg at once. Root-bound
          // Stakely optimistic is accepted above and never reaches here.
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
      onRetry("optimistic answer, retry pending", Date.now() + RETRY_BASE_DELAY_MS);
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
    if (res.status === 429) {
      noteSource429(base, parseRetryAfterMs(retryAfterHeader(res)));
    }
    if (attempt >= VALIDATOR_MAX_ATTEMPTS || !RETRYABLE_STATUSES.has(res.status)) throw err;
    const rawWaitMs =
      parseRetryAfterMs(retryAfterHeader(res)) ??
      (res.status === 429 ? RETRY_429_DEFAULT_DELAY_MS : RETRY_BASE_DELAY_MS);
    // A9: cap a long Retry-After (e.g. nginx 5–10 s) at
    // RETRY_AFTER_CAP_MS so one short retry still fits the 4.5 s
    // budget, instead of skipping the retry entirely. Do NOT shrink
    // the wait further just to force a retry — if the (capped) wait
    // would leave < MIN_RETRY_WINDOW_MS, the source is not retried.
    const waitMs = Math.min(rawWaitMs, RETRY_AFTER_CAP_MS);
    if (deadlineAt - Date.now() - waitMs < MIN_RETRY_WINDOW_MS) throw err;
    // Never start a retry for a request that has already been answered
    // (or failed): no wasted calls to a source that is rate-limiting us.
    if (requestDone()) throw err;
    onRetry(`HTTP ${res.status}, retry pending`, Date.now() + waitMs);
    await sleep(waitMs);
    if (requestDone()) throw err;
  }
}

export async function handleValidator(
  query: Record<string, string | undefined>,
  deps: ValidatorDeps = {},
): Promise<Record<string, unknown>> {
  // Official VALIDATOR_PERFORMANCE_VERIFY_GENERAL request max (live
  // devnode schema 2026-11-21: param min 0, max 1000000000).
  // miner.yaml declares this as MAX_PARAM_VALUE (machine-enforced).
  const VALIDATOR_INDEX_MAX = 1_000_000_000;
  const VALIDATOR_QUERY_KEYS = new Set(["validator_index"]);
  // `index` is not a declared param (YAML and the official intent both
  // name only validator_index). An undeclared key is 400 UNKNOWN_PARAM,
  // never served as an alias.
  for (const key of Object.keys(query)) {
    if (!VALIDATOR_QUERY_KEYS.has(key)) {
      throw badRequest(
        "UNKNOWN_PARAM",
        `Query parameter "${key}" is not supported; /v1/validator takes validator_index`,
      );
    }
  }
  const rawIndex = query.validator_index;
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
  if (index > VALIDATOR_INDEX_MAX) {
    throw badRequest(
      "MAX_PARAM_VALUE",
      "validator_index must be at most 1000000000",
    );
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? VALIDATOR_TIMEOUT_MS;
  const nowFn = deps.nowMs ?? Date.now;
  // One request budget shared by all legs (F6 round 2 + VR): every
  // attempt, retry and wait below ends by deadlineAt, so the whole
  // request ends within ~timeoutMs even when a leg never settles.
  // Budget timers always use wall-clock Date.now(); nowFn is only for
  // the result / root caches and the rate-limit bucket.
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeoutMs;
  const agreedRoot = await resolveFinalizedRoot(fetchImpl, timeoutMs, deadlineAt, nowFn());
  if (agreedRoot === undefined) {
    throw new ApiError(
      502,
      "QUORUM_UNREACHABLE",
      "quorum unreachable: could not agree on a current finalized state root (fail closed; a last-known root is never presented as current)",
    );
  }
  const hit = takeVerified(index, agreedRoot);
  if (hit !== undefined) {
    return hit.envelope;
  }
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

  // V-M1 (J2 round 2) + J1 R1 (round 3): the verdict must not depend on
  // arrival order anywhere inside the budget. After a pair agrees, the
  // decision waits while an unsettled source can still answer inside
  // the budget (canStillAnswer), then is computed from everything that
  // arrived (see decide() below). Early exits only where the verdict can
  // no longer change: every leg settled (incl. a third that definitively
  // failed — decided at once), a dissent already seen next to a pair
  // (conflict is final), no unsettled source can still answer in budget,
  // or neither an answer nor a "does not exist" is reachable.
  //   legRetryAt[i]  when source i's scheduled retry fires (undefined
  //                  while its attempt is in flight)
  const legRetryAt: Array<number | undefined> = BEACON_SOURCES.map(() => undefined);
  const canStillAnswer = (i: number): boolean => {
    if (legSettled[i]) return false;
    const retryAt = legRetryAt[i];
    // In flight: the attempt's abort timer is min(timeout, budget left),
    // so it answers or fails inside the budget. Scheduled retry: only if
    // it fires before the budget ends (fetchValidatorFromSource already
    // refuses retries that would leave < MIN_RETRY_WINDOW_MS).
    return retryAt === undefined || retryAt < deadlineAt;
  };
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
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
        // Otherwise wait only while some unsettled source can still
        // answer inside the budget; the deadline timer bounds the wait.
        if (!BEACON_SOURCES.some((_, i) => canStillAnswer(i))) return finish();
        return;
      }
      // No pair yet. Can one still form? Can "does not exist" (>= 2
      // 404s and no answer) still be reached? If neither, stop now.
      const pairPossible = group.length + pending >= VALIDATOR_MIN_AGREEING || pending >= VALIDATOR_MIN_AGREEING;
      const notFoundPossible = arrival.length === 0 && n404 + pending >= VALIDATOR_MIN_AGREEING;
      if (!pairPossible && !notFoundPossible) finish();
    };
    BEACON_SOURCE_CAPS.forEach((cap, i) => {
      const base = cap.base;
      const now = nowFn();
      if (!canStartSource(cap, now)) {
        legFailure[i] = "skipped (rate-limited)";
        legSettled[i] = true;
        check();
        return;
      }
      if (cap.paced && !chainsafeTakeToken(now)) {
        legFailure[i] = "skipped (rate-limited, token bucket empty)";
        legSettled[i] = true;
        check();
        return;
      }
      fetchValidatorFromSource(base, index, fetchImpl, timeoutMs, deadlineAt, requestDone, (reason, retryAt) => {
        legFailure[i] = reason;
        legRetryAt[i] = retryAt;
        check();
      }, { expectedRoot: agreedRoot, cap }).then(
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
    await saveReceipt(receipt, leg.rawBody);
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
    `(status ${leg.status}), verified by ${votes} at finalized state root ${agreedRoot}.`;
  const result = envelope(
    INTENT,
    {
      validator_index: index,
      effective_balance: leg.effectiveBalance,
      status: leg.status,
      finalized_state_root: agreedRoot,
    },
    receipt,
    { answer, verdict: "verified", confidence: 1.0, source: agreeingSources.join(" + ") },
  );
  rememberVerified(verifiedCacheKey(index, agreedRoot), {
    envelope: result,
    root: agreedRoot,
    index,
  });
  return result;
}
