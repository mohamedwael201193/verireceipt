/**
 * Shared session receipt ledger (2026-11-20 browser click-test fix).
 *
 * ONE store, TWO writers: the /receipts try-it forms AND the /dashboard
 * live checks both append here, so the ledger on /receipts shows every
 * receipt collected in this browser session — not only the ones made on
 * that page. Before this module the dashboard kept its receipts in React
 * state only (pages/dashboard/utils.ts appendToLedger), so navigating
 * Dashboard → Receipts showed "0 receipts this session" even minutes
 * after a dashboard run, despite the page promising the ledger "survives
 * navigation".
 *
 * Storage key is unchanged (verireceipt.session-receipts.v1) so receipts
 * stored by the previous build still load. Entries are UNTRUSTED input:
 * every stored entry is fully validated on load (bad entries dropped),
 * a corrupt value is never silently overwritten (M6), and the newest 200
 * receipts are kept.
 *
 * Guarantees added in the J2 round-2 rework (2026-11-20):
 * - Dedupe is by the per-call entry `key`, NEVER by `receipt_id`: two
 *   legitimate calls can share one receipt_id (same not_found answer,
 *   B01 bursts), and the old receipt_id dedupe collapsed 25 dashboard
 *   rows to 1 on /receipts. Writers must give every call a unique key
 *   (dashboard: the LiveReceipt.key; /receipts: uniqueSessionReceiptKey).
 * - appendSessionReceipt VALIDATES its input and refuses invalid entries
 *   (write nothing, return false): one bad write used to brick the
 *   ledger until the user discarded it.
 * - A stored array with dropped (invalid) entries is backed up before
 *   any filtering rewrite, so no legitimate receipt is silently
 *   destroyed with no evidence.
 * - Storage-unavailable (getItem throws, e.g. private mode) is reported
 *   as `unavailable`, NOT as corrupt — the two states need different UI.
 */
import type { Receipt } from "./types";

export const SESSION_RECEIPTS_KEY = "verireceipt.session-receipts.v1";
export const SESSION_RECEIPTS_CORRUPT_BACKUP_KEY =
  "verireceipt.session-receipts.v1.corrupt-backup";
/**
 * Shared clear-generation counter (J2 R6 cross-tab): "Clear session
 * ledger" bumps this stored counter, so a try-it in flight in ANOTHER
 * tab is dropped by its writer instead of resurrecting its receipt
 * into the freshly cleared ledger. The in-memory clearGenRef in
 * Receipts.tsx covers the same tab (and storage-unavailable); the
 * stored counter covers every other tab sharing this ledger. Discard
 * does NOT bump it — its promise is narrow (only the corrupt stored
 * value goes). clearSessionReceipts() itself does NOT bump it (Discard
 * calls it); only the Clear action bumps, via bumpLedgerGeneration().
 */
export const SESSION_RECEIPTS_GEN_KEY = "verireceipt.session-receipts.gen.v1";

export function readLedgerGeneration(): number {
  try {
    const raw = localStorage.getItem(SESSION_RECEIPTS_GEN_KEY);
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Bump the stored clear generation. The in-memory ref in Receipts.tsx
 * still covers this tab when the write throws.
 */
export function bumpLedgerGeneration(): void {
  try {
    localStorage.setItem(SESSION_RECEIPTS_GEN_KEY, String(readLedgerGeneration() + 1));
  } catch {
    // ignore — the in-memory ref still covers this tab
  }
}
/** Cap the session ledger: the newest 200 receipts, same as the dashboard. */
export const SESSION_RECEIPTS_CAP = 200;
/** Length caps on ledger text fields (J2 R2 M4): a huge answer-as-summary
 *  must never fill the ~5 MB quota and then fail every later append. The
 *  caps must cover the longest label the app builds from API-accepted
 *  params: entity and period are each accepted up to MAX_PARAM_LENGTH
 *  (512, lib/api.ts), so a filings label ("filings " + entity + " · " +
 *  period) can reach ~1035 chars — the old 500 cap refused receipts for
 *  inputs the API itself accepts (J2 R3 M4, feeding the silent-loss
 *  B2). 1200 covers that worst case with margin; over-long entries are
 *  invalid, never truncated. */
export const SESSION_RECEIPT_MAX_LABEL_LEN = 1200;
export const SESSION_RECEIPT_MAX_PARAMS_LEN = 2000;
export const SESSION_RECEIPT_MAX_SUMMARY_LEN = 2000;

export type SessionReceiptEndpoint = "tx" | "filings" | "tvl" | "route" | "grid";

export interface SessionReceipt {
  /** Per-call unique key (never the bare receipt_id — see module header).
   *  Used for dedupe and as the React key. */
  key: string;
  endpoint: SessionReceiptEndpoint;
  label: string;
  params: string;
  fetchedAt: string;
  receipt: Receipt;
  summary: string;
  // Minimal fields the verifier needs for endpoints whose hash is not a
  // plain upstream re-fetch (tx hash for the JSON-RPC replay; the four grid
  // evidence fields for the canonical re-hash).
  verifyData?: {
    tx_hash?: string;
    node_or_zone?: string;
    interval_start?: string;
    lmp_usd_per_mwh?: number;
    market?: string;
  };
}

/** Monotonic per-call counter backing uniqueSessionReceiptKey. */
let sessionReceiptSeq = 0;

/** Random per-tab id: the counter alone is per module instance, so two
 *  tabs could mint the same key for the same receipt_id and dedupe would
 *  drop a legitimate receipt. The tab id makes cross-tab collisions
 *  negligible (8 base-36 chars ≈ 2.8e12 values). */
const SESSION_TAB_ID = Math.random().toString(36).slice(2, 10);

/** Build a per-call unique ledger key. The receipt_id alone is NOT
 *  unique across calls (same not_found answer, bursts), so the key
 *  carries a per-tab random id plus a session counter: two calls never
 *  share a key — in this tab or another — and dedupe by key never drops
 *  a legitimate second receipt. */
export function uniqueSessionReceiptKey(
  endpoint: SessionReceiptEndpoint,
  receiptId: string,
): string {
  sessionReceiptSeq += 1;
  return `${endpoint}-${receiptId}-${SESSION_TAB_ID}-${sessionReceiptSeq}`;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidReceipt(v: unknown): v is Receipt {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.receipt_id) &&
    isNonEmptyString(v.upstream_url) &&
    isNonEmptyString(v.raw_response_sha256) &&
    isNonEmptyString(v.fetched_at)
  );
}

export function isValidSessionReceipt(v: unknown): v is SessionReceipt {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.key)) return false;
  if (
    v.endpoint !== "tx" &&
    v.endpoint !== "filings" &&
    v.endpoint !== "tvl" &&
    v.endpoint !== "route" &&
    v.endpoint !== "grid"
  ) {
    return false;
  }
  if (
    !isNonEmptyString(v.label) ||
    v.label.length > SESSION_RECEIPT_MAX_LABEL_LEN ||
    !isNonEmptyString(v.params) ||
    v.params.length > SESSION_RECEIPT_MAX_PARAMS_LEN ||
    !isNonEmptyString(v.summary) ||
    v.summary.length > SESSION_RECEIPT_MAX_SUMMARY_LEN
  ) {
    return false;
  }
  if (!isNonEmptyString(v.fetchedAt) || Number.isNaN(Date.parse(v.fetchedAt))) return false;
  if (!isValidReceipt(v.receipt)) return false;
  if (v.verifyData !== undefined) {
    if (!isRecord(v.verifyData)) return false;
    const vd = v.verifyData;
    if (vd.tx_hash !== undefined && typeof vd.tx_hash !== "string") return false;
    if (vd.node_or_zone !== undefined && typeof vd.node_or_zone !== "string") return false;
    if (vd.interval_start !== undefined && typeof vd.interval_start !== "string") return false;
    if (vd.lmp_usd_per_mwh !== undefined && typeof vd.lmp_usd_per_mwh !== "number") return false;
    if (vd.market !== undefined && typeof vd.market !== "string") return false;
  }
  return true;
}

export interface ReadSessionReceiptsResult {
  entries: SessionReceipt[];
  /** Stored value is unparseable, not an array, or a non-empty array with
   *  zero valid entries: callers must not overwrite it. */
  corrupt: boolean;
  /** Browser storage itself threw on read (e.g. private mode): nothing is
   *  known to be corrupt — callers must not report corruption, and must
   *  not attempt a read-modify-write. */
  unavailable: boolean;
  /** Number of stored entries dropped by validation on this read (0 when
   *  the stored value was clean). Callers that rewrite the stored value
   *  must back the raw value up first when this is > 0. */
  dropped: number;
}

export function readSessionReceipts(): ReadSessionReceiptsResult {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SESSION_RECEIPTS_KEY);
  } catch {
    // Storage threw on read: unavailable, not corrupt.
    return { entries: [], corrupt: false, unavailable: true, dropped: 0 };
  }
  if (!raw) return { entries: [], corrupt: false, unavailable: false, dropped: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable JSON: corrupt, not empty — the caller must not overwrite it.
    return { entries: [], corrupt: true, unavailable: false, dropped: 0 };
  }
  if (!Array.isArray(parsed)) return { entries: [], corrupt: true, unavailable: false, dropped: 0 };
  // Invalid entries are dropped, never rendered; the ledger is capped.
  const valid = parsed.filter(isValidSessionReceipt);
  const entries = valid.slice(0, SESSION_RECEIPTS_CAP);
  const dropped = parsed.length - valid.length;
  // A parseable array that validates to ZERO entries is corrupt, not
  // empty: a non-empty stored array of invalid entries (e.g. [1,2,3])
  // must take the same path as unparseable data — corrupt notice + backup
  // — never a silent rewrite to []. A stored [] is a legitimate empty
  // ledger and stays non-corrupt.
  if (parsed.length > 0 && entries.length === 0)
    return { entries: [], corrupt: true, unavailable: false, dropped };
  return { entries, corrupt: false, unavailable: false, dropped };
}

function writeSessionReceipts(entries: SessionReceipt[]): boolean {
  try {
    localStorage.setItem(SESSION_RECEIPTS_KEY, JSON.stringify(entries));
    return true;
  } catch {
    // storage full/unavailable — receipts stay in memory for the session
    return false;
  }
}

/**
 * Preserve the CURRENT raw stored value under the backup key, but only
 * when no backup exists yet: the first evidence of poisoning is kept,
 * later rewrites must not overwrite it with a newer (already filtered)
 * value.
 */
function backupRawIfAbsent(): void {
  try {
    if (localStorage.getItem(SESSION_RECEIPTS_CORRUPT_BACKUP_KEY) !== null) return;
    const raw = localStorage.getItem(SESSION_RECEIPTS_KEY);
    if (raw !== null) localStorage.setItem(SESSION_RECEIPTS_CORRUPT_BACKUP_KEY, raw);
  } catch {
    // ignore — the stored value itself is left untouched either way
  }
}

/**
 * Append one receipt to the shared ledger (newest first, deduped by the
 * per-call entry `key`, capped at SESSION_RECEIPTS_CAP). Returns false —
 * and writes nothing — when the entry itself is invalid (J2 R2 B2), when
 * the stored value is corrupt (M6: never silently overwrite corrupt
 * stored data), or when storage is unavailable; the caller keeps the
 * receipt in memory in that case. When stored entries were dropped by
 * validation, the raw value is backed up first (J2 R2 B3) so no
 * legitimate receipt is silently destroyed with no evidence.
 */
export function appendSessionReceipt(entry: SessionReceipt): boolean {
  if (!isValidSessionReceipt(entry)) return false;
  const { entries, corrupt, unavailable, dropped } = readSessionReceipts();
  if (corrupt || unavailable) return false;
  if (dropped > 0) backupRawIfAbsent();
  const next = [entry, ...entries.filter((r) => r.key !== entry.key)].slice(
    0,
    SESSION_RECEIPTS_CAP,
  );
  return writeSessionReceipts(next);
}

/** Remove the shared ledger entirely (Clear button), including any
 *  corrupt-data backup: "discard" means discard the evidence too. */
export function clearSessionReceipts(): void {
  try {
    localStorage.removeItem(SESSION_RECEIPTS_KEY);
    localStorage.removeItem(SESSION_RECEIPTS_CORRUPT_BACKUP_KEY);
  } catch {
    // ignore
  }
}

/**
 * Preserve a corrupt stored value under the backup key (M6). No-op when
 * the stored value is readable.
 */
export function backupCorruptSessionReceipts(): void {
  backupRawIfAbsent();
}
