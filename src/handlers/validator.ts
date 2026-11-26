import {withAnswerClass} from "../core/answerClass";
// GET /v1/validator, finalized validator data with canonical effective_balance in gwei.
//
// Zero-LLM. Calls the standard beacon API on FOUR configured
// keyless public beacon sources and answers only when at least TWO agree
// on every returned validator field at the same finalized state root.
// The quorum size is 2-of-N, where N = BEACON_SOURCES.length. A single-source answer is NEVER served
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
// At least two source404s and no returned validator is a disclosed200
// no-data response with effective_balance:null, never a zero or verified value.
// A lone404, dissent or failed root quorum remains a source failure.
//
// Found effective_balance is a NUMBER in gwei. 0 is a real 0
// (an exited / fully-withdrawn validator); only quorum no-data is null. The beacon API
// serves it as a JSON string ("32000000000"); the handler parses it to
// a safe integer and refuses a leg whose value is not a digit string.
//
// All returned validator fields are compared at the same finalized root.
// Balance and epochs retain the beacon API's exact uint64 decimal strings.
// The canonical effective_balance field remains a number in gwei.
// BLS-pubkey lookup is a native-API extension, not a change to the canonical
// integer-index intent declaration.
//
// Receipt: the receipt hashes the EXACT raw body bytes of the winning
// leg (the first-arrived leg of the agreeing group) and stores
// those bytes as evidence via saveReceipt(receipt, rawBody), so a
// re-hash of GET /receipts/:id/raw always matches. The receipt's
// upstream_url is that leg's full request URL.

import { ApiError, badRequest } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { TIMEOUT_MS } from "../config/limits";

export const INTENT = "VALIDATOR_PERFORMANCE_VERIFY_GENERAL";

/** Exact gwei-to-ETH text: integer whole part plus the 9-digit
 * fractional part, trailing zeros trimmed (no float rounding). */
function gweiToEth(gwei: string | number): string {
  const v = BigInt(gwei);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac === "" ? `${whole}` : `${whole}.${frac}`;
}

/** Pubkey, shortened for the answer text: 0x plus four hex chars on
 * each side. The full pubkey stays in the envelope field. */
function shortenPubkey(pubkey: string): string {
  return /^0x[0-9a-fA-F]{10,}$/.test(pubkey) ? `${pubkey.slice(0, 6)}...${pubkey.slice(-4)}` : pubkey;
}

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
  /** Optional enrichment budget override for decision-neutrality tests only. */
  performanceBudgetMs?:number;
  /** Attestation-rewards optional-read budget override (test only). */
  attestationBudgetMs?:number;
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
export const VALIDATOR_PUBKEY_RE = /^0x[0-9a-fA-F]{96}$/;
const UINT64_MAX = (1n << 64n) - 1n;
type ValidatorIdentifier = number | string;

function exactUint64(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) {
    throw new Error(`malformed beacon response: ${field} is not a uint64 decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw new Error(`malformed beacon response: ${field} exceeds uint64`);
  return parsed.toString();
}

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

function verifiedCacheKey(index: ValidatorIdentifier, root: string): string {
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

function takeVerified(index: ValidatorIdentifier, root: string): VerifiedCacheEntry | undefined {
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

export const VALIDATOR_SLOW_HOST_MS=3000;
export const VALIDATOR_SLOW_ERROR_MS=1500;
export const VALIDATOR_SLOW_HOST_COOLDOWN_MS=60000;
const activeValidatorHosts=new Set<string>();
const slowCooldownUntil=new Map<string,number>();
function slowHostEligible(base:string):boolean{return !activeValidatorHosts.has(base);}
export function noteSourceSlow(base:string,nowMs=Date.now()):void{
 slowCooldownUntil.set(base,nowMs+VALIDATOR_SLOW_HOST_COOLDOWN_MS);
 console.warn(JSON.stringify({event:"validator_source_cooldown",host:new URL(base).hostname,reason:"slow"}));
}
/** Own the complete root-bound workflow until its underlying IO settles.
 * The timer only changes eligibility of later requests. It never shortens
 * the current request's dissent/absence decision window.
 * This is general slow-source exclusion: even a valid in-budget dissenter
 * taking>=3s is skipped for60s on later requests, not only hung sources.
 * Recovery never bypasses active IO or429, and never lowers two-source quorum. */
export async function ownValidatorHost<T>(base:string,work:()=>Promise<T>):Promise<T>{
 if(!slowHostEligible(base))throw Error('validator host cooling down or active');
 activeValidatorHosts.add(base);const start=Date.now();
 const timer=setTimeout(()=>noteSourceSlow(base),VALIDATOR_SLOW_HOST_MS);
 try{return await work();}catch(error){if((error instanceof Error&&error.name==='AbortError')||(Date.now()-start>=VALIDATOR_SLOW_ERROR_MS&&RETRYABLE_STATUSES.has(httpStatusOf(error)??0)))noteSourceSlow(base);throw error;}finally{clearTimeout(timer);activeValidatorHosts.delete(base);if(Date.now()-start>=VALIDATOR_SLOW_HOST_MS)noteSourceSlow(base);}
}

/** Test-only: empty caches, refill the ChainSafe bucket, clear cooldowns. */
export function resetValidatorCachesForTests(nowMs: number = Date.now()): void {
  verifiedCache.clear();
  finalizedRootCache = undefined;
  hostCooldownUntilMs.clear();
  activeValidatorHosts.clear();slowCooldownUntil.clear();
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
  hostCooldownUntilMs.set(base, Math.max(hostCooldownUntilMs.get(base)??0,nowMs + wait));
  if (isChainSafeBase(base)) chainsafeOn429(retryAfterMs, nowMs);
}

export function canStartSource(cap: BeaconSourceCap, nowMs: number = Date.now()): boolean {
  if(!slowHostEligible(cap.base))return false;
  const until = Math.max(hostCooldownUntilMs.get(cap.base) ?? 0,slowCooldownUntil.get(cap.base)??0);
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
  index: number;
  pubkey: string;
  balance: string;
  slashed: boolean;
  activationEligibilityEpoch: string;
  activationEpoch: string;
  exitEpoch: string;
  withdrawableEpoch: string;
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
  expectedIndex: ValidatorIdentifier,
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
  if (typeof dataObj.index !== "string" || !VALIDATOR_INDEX_RE.test(dataObj.index) ||
      !Number.isSafeInteger(Number(dataObj.index))) {
    throw new Error(`malformed beacon response from ${sourceUrl}: data.index does not match requested validator (missing or unsafe canonical index)`);
  }
  if (typeof expectedIndex === "number" && dataObj.index !== String(expectedIndex)) {
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
  const validatorObj = validator as Record<string, unknown>;
  const pubkey = validatorObj.pubkey;
  if (typeof pubkey !== "string" || !VALIDATOR_PUBKEY_RE.test(pubkey)) {
    throw new Error(`malformed beacon response from ${sourceUrl}: pubkey is not a bytes48 hex key`);
  }
  if (typeof expectedIndex === "string" && pubkey.toLowerCase() !== expectedIndex.toLowerCase()) {
    throw new Error(`malformed beacon response from ${sourceUrl}: pubkey does not match requested validator`);
  }
  if (typeof validatorObj.slashed !== "boolean") {
    throw new Error(`malformed beacon response from ${sourceUrl}: slashed is not a boolean`);
  }
  const balance = exactUint64(dataObj.balance, "balance");
  return {
    index: Number(dataObj.index), pubkey: pubkey.toLowerCase(), balance,
    slashed: validatorObj.slashed,
    activationEligibilityEpoch: exactUint64(validatorObj.activation_eligibility_epoch, "activation_eligibility_epoch"),
    activationEpoch: exactUint64(validatorObj.activation_epoch, "activation_epoch"),
    exitEpoch: exactUint64(validatorObj.exit_epoch, "exit_epoch"),
    withdrawableEpoch: exactUint64(validatorObj.withdrawable_epoch, "withdrawable_epoch"),
    effectiveBalance, status, rawBody, sourceUrl,
  };
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

  const rootCandidates=BEACON_SOURCE_CAPS.filter(cap=>!cap.paced&&slowHostEligible(cap.base));
  const eligibleRoots=rootCandidates.filter(cap=>canStartSource(cap,nowMs));
  const rootSources=eligibleRoots.length>=VALIDATOR_MIN_AGREEING?eligibleRoots:rootCandidates.filter(cap=>nowMs>=(hostCooldownUntilMs.get(cap.base)??0));
  type RootVote =
    | { base: string; root: string; optimistic: boolean }
    | { base: string; error: unknown };
  const votes: RootVote[] = await Promise.all(
    rootSources.map(async (cap) => {
      const left = Math.max(1, rootDeadlineAt - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const got = await Promise.race([
          ownValidatorHost(cap.base,()=>fetchStateRoot(cap.base, "finalized", fetchImpl, timeoutMs, rootDeadlineAt)),
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
export function isValidatorAbsenceBody(raw:string,index:number|string):boolean {
 try{const j=JSON.parse(raw);if(j?.code!==404||typeof j.message!=="string")return false;
 return j.message==="Validator index from future state"&&typeof index==="number" || j.message===`NOT_FOUND: unknown validator: ${index}`;
 }catch{return false;}
}

async function fetchValidatorFromSource(
  base: string,
  index: ValidatorIdentifier,
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
    const attemptStartedAt=Date.now();
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
        } else if (status !== undefined && RETRYABLE_STATUSES.has(status) && Date.now()-attemptStartedAt<1000 && attempt < VALIDATOR_MAX_ATTEMPTS) {
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
    let validatorAbsent=false;
    try {
      res = await fetchImpl(sourceUrl, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if(res.status===404)validatorAbsent=isValidatorAbsenceBody(await res.text(),index);
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
    ) as Error & { httpStatus: number; validatorAbsent:boolean };
    err.httpStatus = res.status;
    err.validatorAbsent=validatorAbsent;
    if (res.status === 429) {
      noteSource429(base, parseRetryAfterMs(retryAfterHeader(res)));
    }
    if (attempt >= VALIDATOR_MAX_ATTEMPTS || !RETRYABLE_STATUSES.has(res.status) || Date.now()-attemptStartedAt>=1000) throw err;
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

interface EpochBalanceDelta {
  slotOld: string;
  slotNew: string;
  balanceOld: string;
  balanceNew: string;
  /** The four sample URLs (2 sources x 2 slots), space-separated. */
  sourceUrls: string;
  /**
   * Canonical evidence document: every sample's source, URL, slot and raw
   * body, so a judge can recompute the delta and the cross-source
   * agreement from the stored receipt evidence alone.
   */
  evidence: string;
  sources: string[];
}

/**
 * Sample the validator's balance at two finalized slots exactly one epoch
 * (32 slots) apart, on two independent state-capable sources. Both sources
 * must return identical balances at both slots; any failure, pruning,
 * non-finalized flag or disagreement yields undefined (section omitted).
 * Probes share the sources' rate budgets with the verified legs (review,
 * 2026-11-23): a source in 429 cooldown or with an empty token bucket is
 * not probed, and a probe 429 puts the host in the same cooldown a leg
 * would, so best-effort enrichment can never burn the verified path's
 * budget.
 */
const activePerformanceSources = new Set<string>();
export function resetValidatorPerformanceReadsForTests() { activePerformanceSources.clear(); }
/** Cancel a response body, waiting at most PERF_CANCEL_WAIT_MS so ownership is released only after the cancel settles or the bound passes. */
export const PERF_CANCEL_WAIT_MS = 250;
async function cancelBodyBounded(target: { cancel?: () => Promise<unknown> } | null | undefined): Promise<void> {
  if (!target || typeof target.cancel !== "function") return;
  let t: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.resolve().then(() => target.cancel!()).catch(() => {}), new Promise<void>(r => { t = setTimeout(r, PERF_CANCEL_WAIT_MS); })]); }
  finally { clearTimeout(t); }
}
/** Optional reads share one400ms budget. Ownership outlives a caller timeout. */
async function readPerformanceBody(url: string, fetchImpl: typeof fetch, deadline: number, nowMs: () => number, init?: { method: string; body: string }, maxBytes = 65536): Promise<string | undefined> {
  const host = new URL(url).origin;
  if (Date.now() >= deadline || activePerformanceSources.has(host)) return undefined;
  activePerformanceSources.add(host);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const io = (async () => {
    try {
      const res = await fetchImpl(url, {...(init ?? {}),headers:{accept:"application/json",...(init ? {"content-type":"application/json"} : {})},redirect:"error",signal:controller.signal});
      if (!res.ok) {
        if (res.status === 429) noteSource429(host, parseRetryAfterMs(retryAfterHeader(res)), nowMs());
        await cancelBodyBounded(res.body);
        controller.abort();
        return undefined;
      }
      let body: string;
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        const parts: Uint8Array[] = []; let size = 0;
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes) { await cancelBodyBounded(reader); controller.abort(); return undefined; }
          parts.push(part.value);
        }
        body = Buffer.concat(parts).toString("utf8");
      } else {
        // Dependency-injected response doubles may expose only text().
        body = await res.text();
        if (Buffer.byteLength(body) > maxBytes) return undefined;
      }
      return Date.now() >= deadline ? undefined : body;
    } catch { return undefined; }
    finally { activePerformanceSources.delete(host); }
  })();
  try {
    return await Promise.race([io, new Promise<undefined>(resolve => {
      timer = setTimeout(() => {controller.abort();resolve(undefined);}, Math.max(0, deadline-Date.now()));
    })]);
  } finally {clearTimeout(timer);}
}

async function fetchEpochBalanceDelta(
  index: string,
  bases: string[],
  fetchImpl: typeof fetch,
  nowMs: () => number = Date.now,
  budgetMs=400,
  headMemo?: { raw?: Promise<string | undefined> },
): Promise<EpochBalanceDelta | undefined> {
  const eligible = bases.filter((base) => {
    const cap = BEACON_SOURCE_CAPS.find((c) => c.base === base);
    if (cap === undefined || activeValidatorHosts.has(base) || nowMs()<(slowCooldownUntil.get(base)??0) || !canStartSource(cap, nowMs())) return false;
    if (cap.paced && !chainsafeTakeToken(nowMs())) return false;
    return true;
  });
  if (eligible.length < 2) return undefined;
  const probeBases = eligible.slice(0, 2);
  const deadline = Date.now() + budgetMs;
  const getJson = async (url: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const raw = await readPerformanceBody(url, fetchImpl, deadline, nowMs);
      return raw === undefined ? undefined : JSON.parse(raw);
    } catch { return undefined; }
  };
  const headRawText = memoHead(headMemo, `${probeBases[0]}/eth/v1/beacon/headers/finalized`, fetchImpl, deadline, nowMs);
  const head = await (async () => { try { const r = await headRawText; return r === undefined ? undefined : JSON.parse(r) as Record<string, unknown>; } catch { return undefined; } })();
  const finalizedSlotRaw =
    (head?.data as Record<string, unknown> | undefined)?.header as Record<string, unknown> | undefined;
  const slotStr = (finalizedSlotRaw?.message as Record<string, unknown> | undefined)?.slot;
  if (head?.execution_optimistic !== false || head?.finalized !== true || typeof slotStr !== "string" || !/^\d+$/.test(slotStr)) {
    return undefined;
  }
  const slotNew = Number(slotStr);
  if (!Number.isSafeInteger(slotNew) || slotNew < 32) return undefined;
  const slotOld = slotNew - 32;

  const sampleAt = async (base: string, slot: number): Promise<{ url: string; body: string; balance: string } | undefined> => {
    const url = `${base}/eth/v1/beacon/states/${slot}/validator_balances?id=${index}`;
    try {
      const body = await readPerformanceBody(url, fetchImpl, deadline, nowMs);
      if (body === undefined) return undefined;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (parsed.execution_optimistic !== false || parsed.finalized !== true) return undefined;
      const rows = parsed.data;
      if (!Array.isArray(rows) || rows.length !== 1) return undefined;
      const row = rows[0] as Record<string, unknown>;
      if (row.index !== String(index) || typeof row.balance !== "string" || !/^\d+$/.test(row.balance)) {
        return undefined;
      }
      return { url, body, balance: exactUint64(row.balance, "performance balance") };
    } catch {
      return undefined;
    }
  };

  const samples = await Promise.all(
    probeBases.map(async (base) => ({
      base,
      oldSample: await sampleAt(base, slotOld),
      newSample: await sampleAt(base, slotNew),
    })),
  );
  if (samples.some((s) => s.oldSample === undefined || s.newSample === undefined)) return undefined;
  const done = samples as Array<{
    base: string;
    oldSample: { url: string; body: string; balance: string };
    newSample: { url: string; body: string; balance: string };
  }>;
  const balanceOld = done[0].oldSample.balance;
  const balanceNew = done[0].newSample.balance;
  if (
    done.some((s) => s.oldSample.balance !== balanceOld || s.newSample.balance !== balanceNew)
  ) {
    return undefined; // sources disagree on a deterministic slot sample
  }
  const sampleDocs = done.flatMap((s) => [
    { source: s.base, url: s.oldSample.url, slot: String(slotOld), raw_body: s.oldSample.body },
    { source: s.base, url: s.newSample.url, slot: String(slotNew), raw_body: s.newSample.body },
  ]);
  return {
    slotOld: String(slotOld),
    slotNew: String(slotNew),
    balanceOld,
    balanceNew,
    sourceUrls: sampleDocs.map((s) => s.url).join(" "),
    evidence: JSON.stringify({
      kind: "validator_epoch_balance_delta",
      validator_index: String(index),
      slot_old: String(slotOld),
      slot_new: String(slotNew),
      samples: sampleDocs,
    }),
    sources: done.map((s) => s.base),
  };
}

/** Shared finalized-head read; a failed read is not memoized so a later optional read may retry it. */
async function memoHead(memo: { raw?: Promise<string | undefined> } | undefined, url: string, fetchImpl: typeof fetch, deadline: number, nowMs: () => number): Promise<string | undefined> {
  if (!memo) return readPerformanceBody(url, fetchImpl, deadline, nowMs);
  const pending = (memo.raw ??= readPerformanceBody(url, fetchImpl, deadline, nowMs));
  const raw = await pending;
  if (raw === undefined && memo.raw === pending) memo.raw = undefined;
  return raw;
}
const FAR_FUTURE_EPOCH = "18446744073709551615";
export const ATTESTATION_PERF_BUDGET_MS = 1700;
/** The rewards reply carries the whole ideal-reward table (about 215-260 KB observed 2026-11-26), so it needs a larger cap than other optional reads. */
export const ATTESTATION_BODY_MAX_BYTES = 320 * 1024;
/** Skip the rewards read when the verified path already used this much of the request, bounding total latency. */
export const ATTESTATION_START_BY_MS = 1500;
export interface AttestationPerf {
  epoch: string; finalizedFlag: boolean | null; head: string; target: string; source: string; inactivity: string;
  total: string; ideal: string | null; crossChecked: boolean; sources: string[]; sourceUrls: string; evidence: string;
}
/**
 * Last completed epoch's attestation rewards for one active validator, from the beacon
 * rewards endpoint on up to two independent sources. When two answer they must agree on
 * the validator's own row; a single answering source is reported and disclosed as not
 * cross-checked. Keyless hosts keep rewards state only for the newest epochs, so this is the latest
 * completed epoch the sources still serve, normally one epoch behind the finalized
 * checkpoint, and may carry finalized=false; the flag is reported, never upgraded.
 * Shares the optional-read ownership, cooldown, bucket and size rules of the balance probe.
 */
export async function fetchAttestationPerformance(
  index: string, effectiveBalance: string, bases: string[], fetchImpl: typeof fetch,
  nowMs: () => number = Date.now, budgetMs = ATTESTATION_PERF_BUDGET_MS, headMemo?: { raw?: Promise<string | undefined> },
): Promise<AttestationPerf | undefined> {
  const eligible = bases.filter((base) => {
    const cap = BEACON_SOURCE_CAPS.find((c) => c.base === base);
    if (cap === undefined || activeValidatorHosts.has(base) || nowMs() < (slowCooldownUntil.get(base) ?? 0) || !canStartSource(cap, nowMs())) return false;
    if (cap.paced && !chainsafeTakeToken(nowMs())) return false;
    return true;
  });
  if (eligible.length < 2) return undefined;
  const probeBases = eligible.slice(0, 2);
  const deadline = Date.now() + budgetMs;
  const headRaw = await memoHead(headMemo, `${probeBases[0]}/eth/v1/beacon/headers/finalized`, fetchImpl, deadline, nowMs);
  let slot: number;
  try {
    const head = JSON.parse(headRaw ?? "") as Record<string, any>;
    const slotStr = head?.data?.header?.message?.slot;
    if (head.execution_optimistic !== false || head.finalized !== true || typeof slotStr !== "string" || !/^\d+$/.test(slotStr)) return undefined;
    slot = Number(slotStr);
  } catch { return undefined; }
  if (!Number.isSafeInteger(slot) || slot < 64) return undefined;
  const epoch = String(Math.floor(slot / 32) - 1);
  const read = async (base: string) => {
    const url = `${base}/eth/v1/beacon/rewards/attestations/${epoch}`;
    try {
      const body = await readPerformanceBody(url, fetchImpl, deadline, nowMs, { method: "POST", body: JSON.stringify([String(index)]) }, ATTESTATION_BODY_MAX_BYTES);
      if (body === undefined) return undefined;
      const d = JSON.parse(body) as Record<string, any>;
      if (d.execution_optimistic === true) return undefined;
      const rows = d.data?.total_rewards, ideal = d.data?.ideal_rewards;
      if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(ideal)) return undefined;
      const r = rows[0];
      if (r?.validator_index !== String(index)) return undefined;
      const num = (v: unknown) => { if (typeof v !== "string" || !/^-?\d{1,20}$/.test(v)) throw new Error("bad reward"); return BigInt(v).toString(); };
      const row = { head: num(r.head), target: num(r.target), source: num(r.source), inactivity: num(r.inactivity) };
      const bucket = ideal.find((x: any) => x?.effective_balance === effectiveBalance);
      const idealTotal = bucket ? (BigInt(num(bucket.head)) + BigInt(num(bucket.target)) + BigInt(num(bucket.source))).toString() : null;
      return { base, url, body, row, idealTotal, finalizedFlag: typeof d.finalized === "boolean" ? d.finalized as boolean : null };
    } catch { return undefined; }
  };
  const got = (await Promise.all(probeBases.map(read))).filter((g): g is NonNullable<typeof g> => g !== undefined);
  if (got.length === 0) return undefined;
  const [a, b] = [got[0], got[got.length - 1]];
  if (got.length === 2 && (a.row.head !== b.row.head || a.row.target !== b.row.target || a.row.source !== b.row.source || a.row.inactivity !== b.row.inactivity)) return undefined;
  const ideal = a.idealTotal !== null && a.idealTotal === b.idealTotal ? a.idealTotal : null;
  const crossChecked = got.length === 2;
  const total = (BigInt(a.row.head) + BigInt(a.row.target) + BigInt(a.row.source) + BigInt(a.row.inactivity)).toString();
  return {
    epoch, finalizedFlag: a.finalizedFlag !== null && a.finalizedFlag === b.finalizedFlag ? a.finalizedFlag : null,
    ...a.row, total, ideal, crossChecked, sources: got.map((g) => g.base), sourceUrls: got.map((g) => g.url).join(" "),
    evidence: JSON.stringify({ kind: "validator_attestation_rewards", validator_index: String(index), epoch,
      cross_checked: crossChecked, samples: got.map((g) => ({ source: g.base, url: g.url, request_body: [String(index)], raw_body: g.body })) }),
  };
}

const NOT_MEASURED =
  "Not measured: proposer duties and block proposals (no keyless beacon source serves proposer duties; observed 403, 404 and 501), " +
  "sync-committee duties, attestation inclusion delay, and any history beyond two finalized epochs of balance.";

async function handleValidatorObserved(
  query: Record<string, string | undefined>,
  deps: ValidatorDeps = {},
): Promise<Record<string, unknown>> {
  const requestStartedAt = Date.now();
  // Official VALIDATOR_PERFORMANCE_VERIFY_GENERAL request max (live
  // devnode schema 2026-11-21: param min 0, max 1000000000).
  // miner.yaml declares this as MAX_PARAM_VALUE (machine-enforced).
  const VALIDATOR_INDEX_MAX = 1_000_000_000;
  const VALIDATOR_QUERY_KEYS = new Set(["validator_index", "validator_pubkey"]);
  // `index` is not a declared param (YAML and the official intent both
  // name only validator_index). An undeclared key is 400 UNKNOWN_PARAM,
  // never served as an alias.
  for (const key of Object.keys(query)) {
    if (!VALIDATOR_QUERY_KEYS.has(key)) {
      throw badRequest(
        "UNKNOWN_PARAM",
        `Query parameter "${key}" is not supported; /v1/validator takes validator_index or native validator_pubkey`,
      );
    }
  }
  const rawIndex = query.validator_index;
  const rawPubkey = query.validator_pubkey;
  if (rawIndex !== undefined && rawPubkey !== undefined) {
    throw badRequest("AMBIGUOUS_VALIDATOR_ID", "Supply either validator_index or validator_pubkey, not both");
  }
  const pubkeyInput = rawPubkey ?? (rawIndex !== undefined && VALIDATOR_PUBKEY_RE.test(rawIndex) ? rawIndex : undefined);
  let index: ValidatorIdentifier;
  if (pubkeyInput !== undefined) {
    if (!VALIDATOR_PUBKEY_RE.test(pubkeyInput)) {
      throw badRequest("INVALID_VALIDATOR_PUBKEY", "validator_pubkey must be a 0x-prefixed 48-byte BLS public key");
    }
    index = pubkeyInput.toLowerCase();
  } else {
    if (rawIndex === undefined || !VALIDATOR_INDEX_RE.test(rawIndex)) {
      throw badRequest("INVALID_VALIDATOR_INDEX", "validator_index is required and must be a non-negative integer (e.g. 1)");
    }
    index = Number(rawIndex);
    if (!Number.isSafeInteger(index)) {
      throw badRequest("INVALID_VALIDATOR_INDEX", "validator_index must be a non-negative integer (e.g. 1)");
    }
    if (index > VALIDATOR_INDEX_MAX) {
      throw badRequest("MAX_PARAM_VALUE", "validator_index must be at most 1000000000");
    }
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
    return withAnswerClass({...hit.envelope},INTENT,{validator_outcome:"cache_hit",validator_state:"finalized",effective_balance:hit.envelope.effective_balance});
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
  const legAbsent:boolean[]=BEACON_SOURCES.map(()=>false);
  const legSettled: boolean[] = BEACON_SOURCES.map(() => false);
  const arrival: number[] = [];
  let requestSettled = false;
  const requestDone = (): boolean => requestSettled;
  const same = (a: ValidatorLeg, b: ValidatorLeg): boolean =>
    a.index === b.index && a.pubkey === b.pubkey && a.balance === b.balance &&
    a.slashed === b.slashed && a.activationEligibilityEpoch === b.activationEligibilityEpoch &&
    a.activationEpoch === b.activationEpoch && a.exitEpoch === b.exitEpoch &&
    a.withdrawableEpoch === b.withdrawableEpoch &&
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
      const n404 = legAbsent.filter(Boolean).length;
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
    const initiallyStartable=BEACON_SOURCE_CAPS.filter(c=>canStartSource(c,nowFn())).length;
    BEACON_SOURCE_CAPS.forEach((cap, i) => {
      const base = cap.base;
      const now = nowFn();
      // Cooldown may be bypassed only to retain a possible two-source
      // quorum. Active IO is never bypassed (no same-host pile-up).
      const startable=initiallyStartable;
      const quorumRecovery=startable<VALIDATOR_MIN_AGREEING&&cap.rootPin&&!activeValidatorHosts.has(base)&&now>=(hostCooldownUntilMs.get(base)??0)&&(!cap.paced||chainsafeCanStart(now));
      if (!canStartSource(cap, now)&&!quorumRecovery) {
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
      const runLeg=()=>fetchValidatorFromSource(base,index,fetchImpl,timeoutMs,deadlineAt,requestDone,(reason,retryAt)=>{
        legFailure[i]=reason;legRetryAt[i]=retryAt;check();
      },{expectedRoot:agreedRoot,cap});
      (cap.rootPin?ownValidatorHost(base,runLeg):runLeg()).then(
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
          legAbsent[i]=Boolean((err as any)?.validatorAbsent);
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
  const n404 = legAbsent.filter(Boolean).length;
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
    // no-data result: at least VALIDATOR_MIN_AGREEING sources observed 404 and
    // NO source returned the validator. No-data is not a verified balance.
    if (n404 >= VALIDATOR_MIN_AGREEING && answeredCount === 0) {
      return withAnswerClass({
        validator_index:index, effective_balance:null, effective_balance_unit:"gwei",
        status:"not_found", verdict:"no_data", confidence:0, receipt:null,
        finalized_state_root:agreedRoot,
        answer:`Validator ${index} was not found at finalized state root ${agreedRoot}; ${n404} of ${n} beacon sources returned recognized validator-not-found404 and none returned a validator. effective_balance is null (unknown/not found), not zero. No validator value is verified and no value receipt is issued.`,
        source:BEACON_SOURCES.filter((_,i)=>legAbsent[i]).join(" + "),
      },INTENT,{validator_outcome:"not_found",validator_state:"finalized",effective_balance:null});
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
  } catch {
    // Never return or cache a verified answer without its stored evidence.
    throw new ApiError(
      502,
      "RECEIPT_PERSIST_FAILED",
      "receipt evidence could not be stored; answer unavailable",
    );
  }
  // Attestation-performance proxy (best-effort enrichment): the net
  // balance change between two finalized states exactly 32 slots (one
  // epoch) apart. Beacon REST attestation-rewards endpoints need pruned
  // historical states that no keyless source serves (verified live
  // 2026-11-23), and beaconcha.in performance APIs need an API key, so
  // the verifiable keyless signal is the on-ledger balance delta itself:
  // for an active validator it is dominated by attestation rewards and
  // turns negative under inactivity penalties. Both samples must agree
  // across two independent state-capable sources or the section is
  // omitted; it never blocks or degrades the verified balance answer.
  const headMemo: { raw?: Promise<string | undefined> } = {};
  let perfFields: Record<string, unknown> = {};
  let perfSentence = "";
  try {
    const stateSources = agreeingSources.filter(
      (base) => !base.includes("blockreq"), // blockreq: 501 on states/{root}/*
    );
    if (stateSources.length >= 2) {
      const perf = await fetchEpochBalanceDelta(
        String(leg.index),
        stateSources,
        fetchImpl,
        nowFn,
        deps.performanceBudgetMs??400,
        headMemo,
      );
      if (perf !== undefined) {
        const perfReceipt = makeReceipt(
          INTENT,
          perf.sourceUrls,
          perf.evidence,
          `${perf.sources.length}/${perf.sources.length} sources agreed on both balance samples`,
        );
        try {
          await saveReceipt(perfReceipt, perf.evidence);
        } catch {
          throw new Error("performance receipt could not be stored");
        }
        const delta = BigInt(perf.balanceNew) - BigInt(perf.balanceOld);
        const annualizedBps =
          BigInt(perf.balanceNew) === 0n
            ? 0n
            : (delta * 82125n * 10000n) / BigInt(perf.balanceNew);
        const aprPct = (Number(annualizedBps) / 100).toFixed(2);
        const direction = delta > 0n ? "gained" : delta < 0n ? "lost" : "did not change";
        perfFields = {
          recent_epoch_balance_delta: {
            from_slot: perf.slotOld,
            to_slot: perf.slotNew,
            balance_from_gwei: perf.balanceOld,
            balance_to_gwei: perf.balanceNew,
            net_change_gwei: delta.toString(),
            annualized_rate_estimate_pct: aprPct,
            basis:
              "net balance change between two finalized states 32 slots (one epoch) apart; " +
              "dominated by attestation rewards, may include proposal or sync-committee rewards; " +
              "annualized from this single-epoch sample only",
          },
          performance_receipt: perfReceipt,
        };
        perfSentence =
          ` Between finalized slots ${perf.slotOld} and ${perf.slotNew} (one epoch apart) its balance ` +
          `${direction}${delta === 0n ? "" : ` ${delta < 0n ? -delta : delta} gwei`} ` +
          `(from ${perf.balanceOld} to ${perf.balanceNew}), an annualized rate of about ${aprPct}% ` +
          `from this single-epoch sample; the change is dominated by attestation rewards and may ` +
          `include proposal or sync-committee rewards.`;
      }
    }
  } catch {
    perfFields = {};
    perfSentence = "";
  }
  // Performance section (additive). Exited, withdrawn, slashed and not-yet-active validators
  // have no live attestation performance: say so and give the epochs we know. Active
  // validators get the last completed epoch's attestation rewards when two sources agree.
  let liveFields: Record<string, unknown> = {};
  let liveSentence = "";
  const measured: string[] = ["status", "slashed", "activation and exit epochs", "balance"];
  const lastActiveEpoch = leg.exitEpoch !== FAR_FUTURE_EPOCH && leg.activationEpoch !== FAR_FUTURE_EPOCH && BigInt(leg.exitEpoch) > BigInt(leg.activationEpoch)
    ? (BigInt(leg.exitEpoch) - 1n).toString() : null;
  const exitedStatus = leg.status.startsWith("exited_") || leg.status.startsWith("withdrawal_");
  if (leg.slashed || exitedStatus || leg.status.startsWith("pending_")) {
    const why = leg.status.startsWith("pending_") && !leg.slashed
      ? `Validator ${leg.index} is not active yet (${leg.status}), so no live performance exists; activation epoch is ${leg.activationEpoch}.`
      : `Validator ${leg.index} is ${leg.slashed ? "slashed" : leg.status}, so no live performance exists for it` +
        `${lastActiveEpoch !== null ? `; its last active epoch is ${lastActiveEpoch} and its exit epoch is ${leg.exitEpoch}` : leg.exitEpoch !== FAR_FUTURE_EPOCH ? `; its exit epoch is ${leg.exitEpoch}` : ""}.`;
    liveFields = { performance_status: "no_live_performance", performance_note: why, last_active_epoch: lastActiveEpoch, exit_epoch: leg.exitEpoch };
    liveSentence = ` ${why}`;
  } else if (leg.status === "active_ongoing" || leg.status === "active_exiting") {
    let att: AttestationPerf | undefined;
    try {
      const stateSources = agreeingSources.filter((base) => !base.includes("blockreq"));
      if (stateSources.length >= 2 && Date.now() - requestStartedAt < ATTESTATION_START_BY_MS) att = await fetchAttestationPerformance(String(leg.index), String(leg.effectiveBalance), stateSources, fetchImpl, nowFn, deps.attestationBudgetMs ?? ATTESTATION_PERF_BUDGET_MS, headMemo);
      if (att !== undefined) {
        const attReceipt = makeReceipt(INTENT, att.sourceUrls, att.evidence, att.crossChecked ? "2/2 sources agreed on the validator's attestation reward row" : "1 source only, attestation reward row not cross-checked");
        try { await saveReceipt(attReceipt, att.evidence); } catch { throw new Error("attestation receipt could not be stored"); }
        const pos = (v: string) => BigInt(v) > 0n;
        const eff = att.ideal !== null && BigInt(att.ideal) > 0n ? Number((BigInt(att.total) * 10000n) / BigInt(att.ideal)) / 100 : null;
        liveFields = {
          performance_status: "measured",
          attestation_performance: {
            epoch: att.epoch, epoch_finalized: att.finalizedFlag, cross_checked: att.crossChecked, sources_agreeing: att.sources.length,
            head_reward_gwei: att.head, target_reward_gwei: att.target, source_reward_gwei: att.source, inactivity_gwei: att.inactivity,
            head_correct: pos(att.head), target_correct: pos(att.target), source_correct: pos(att.source),
            total_reward_gwei: att.total, ideal_reward_gwei: att.ideal, reward_efficiency_pct: eff,
            basis: "beacon attestation-rewards endpoint, row for this validator, " + (att.crossChecked ? "identical on two sources." : "from ONE source only, not cross-checked.") + " A vote is marked correct when its reward is positive; zero or negative means wrong, late or missing, and the reward alone cannot say which. Ideal is the head+target+source reward for this effective balance.",
          },
          attestation_receipt: attReceipt,
        };
        measured.push("attestation head/target/source rewards for one epoch");
        liveSentence = ` For attestation epoch ${att.epoch}${att.finalizedFlag === false ? " (the newest epoch the keyless sources still serve; not yet finalized)" : ""}, head was ${pos(att.head) ? "correct" : "not rewarded"} (${att.head} gwei), target ${pos(att.target) ? "correct" : "not rewarded"} (${att.target}), source ${pos(att.source) ? "correct" : "not rewarded"} (${att.source}); total ${att.total} gwei${eff !== null ? `, ${eff}% of the ideal ${att.ideal}` : ""}${att.crossChecked ? "" : ". This reward row came from a single source and was not cross-checked"}.`;
      }
    } catch { liveFields = {}; liveSentence = ""; att = undefined; }
    if (att === undefined) {
      liveFields = { performance_status: "attestation_rewards_unavailable",
        performance_note: "Attestation rewards were not obtained: no source served this validator's row inside the optional budget, the verified path had already used too much of the request, or two sources disagreed." };
      liveSentence = " Attestation rewards were not obtained this call (no source answered inside the optional-read budget, the request had little time left, or two sources disagreed).";
    }
  }
  const delta = perfFields.recent_epoch_balance_delta as Record<string, string> | undefined;
  if (delta !== undefined) {
    liveFields = { ...liveFields, balance_history: [
      { slot: delta.from_slot, epoch: String(Math.floor(Number(delta.from_slot) / 32)), balance_gwei: delta.balance_from_gwei },
      { slot: delta.to_slot, epoch: String(Math.floor(Number(delta.to_slot) / 32)), balance_gwei: delta.balance_to_gwei },
    ] };
    measured.push("balance at two finalized epochs");
  }
  liveFields = { ...liveFields, performance_measured: measured, performance_not_measured: NOT_MEASURED };
  liveSentence += ` ${NOT_MEASURED}`;
  const hasFarFutureEpoch = [
    leg.activationEligibilityEpoch,
    leg.activationEpoch,
    leg.exitEpoch,
    leg.withdrawableEpoch,
  ].includes("18446744073709551615");
  const sentinelNote = hasFarFutureEpoch
    ? "Epoch 18446744073709551615 is the beacon far-future sentinel, not a scheduled date. "
    : "";
  const answer =
    `Validator ${leg.index} effective balance is ${leg.effectiveBalance} gwei (${gweiToEth(leg.effectiveBalance)} ETH). ` +
    `Validator ${leg.index} is ${leg.status} and ${leg.slashed ? "HAS been slashed" : "has not been slashed"}; ` +
    `balance ${gweiToEth(leg.balance)} ETH, ` +
    `active since epoch ${leg.activationEpoch} (eligible from epoch ${leg.activationEligibilityEpoch}), ` +
    `${leg.exitEpoch === "18446744073709551615" ? "no exit scheduled" : `exit scheduled at epoch ${leg.exitEpoch}, withdrawable epoch ${leg.withdrawableEpoch}`}. ` +
    sentinelNote +
    `Finalized beacon state verified by ${votes} at state root ${agreedRoot}; pubkey ${shortenPubkey(leg.pubkey)}.` +
    liveSentence + perfSentence;
  const result = envelope(
    INTENT,
    {
      validator_index: leg.index,
      validator_pubkey: leg.pubkey,
      balance: leg.balance,
      balance_unit: "gwei",
      slashed: leg.slashed,
      activation_eligibility_epoch: leg.activationEligibilityEpoch,
      activation_epoch: leg.activationEpoch,
      exit_epoch: leg.exitEpoch,
      withdrawable_epoch: leg.withdrawableEpoch,
      effective_balance: leg.effectiveBalance,
      status: leg.status,
      finalized_state_root: agreedRoot,
      ...perfFields,
      ...liveFields,
    },
    receipt,
    { answer, verdict: "verified", confidence: 1.0, source: agreeingSources.join(" + ") },
  );
  rememberVerified(verifiedCacheKey(index, agreedRoot), {
    envelope: result,
    root: agreedRoot,
    index: leg.index,
  });
  return withAnswerClass(result,INTENT,{validator_outcome:"verified",validator_state:"finalized",effective_balance:leg.effectiveBalance});
}

/** Log-only metadata. Public response and evidence are unchanged. */
export async function handleValidator(query:Record<string,string|undefined>,deps:ValidatorDeps={}):Promise<Record<string,unknown>> {
 try{return await handleValidatorObserved(query,deps);}
 catch(error){try{if(error&&typeof error==='object')withAnswerClass(error,INTENT,{validator_outcome:'refused'});}catch{}throw error;}
}
