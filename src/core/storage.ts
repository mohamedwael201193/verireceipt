// PG-MIGRATE (2026-11-21): the ONE storage entry point for request paths.
//
// Backend choice: DATABASE_URL set -> Postgres (src/core/pgStore.ts);
// unset -> the original SQLite file (src/core/db.ts, unchanged semantics,
// used for local dev, as the migration source, and as the rollback path
// while the Render disk still exists). Both backends share the same
// validation / gzip / decode / eviction functions, so a receipt saved on
// one is byte-identical to a receipt saved on the other.
//
// Every function is async. In SQLite mode it wraps the synchronous call
// (a throw becomes a rejection, so `await` inside try/catch keeps the
// callers' old fail-soft behaviour exactly).

import type { Receipt } from "./receipt";
import * as sqlite from "./db";
import * as pg from "./pgStore";
import type {
  GridRevalidateState,
  ReceiptEvidence,
  ReceiptPageInput,
  StoredEvidenceBlob,
  StoredReceiptMeta,
  StoredReceiptPage,
} from "./db";

export type StorageBackend = "postgres" | "sqlite";

let forced: StorageBackend | null = null;

export function storageBackend(): StorageBackend {
  if (forced) return forced;
  return (process.env.DATABASE_URL ?? "").trim() ? "postgres" : "sqlite";
}

/**
 * Test hook: pin a backend regardless of DATABASE_URL (white-box SQLite
 * test files seed the SQLite file directly and must read it back through
 * the handlers). null restores env-based selection.
 */
export function __setStorageBackendForTests(b: StorageBackend | null): void {
  forced = b;
}

const isPg = () => storageBackend() === "postgres";

/**
 * PG-MIGRATE r2 (J1 M2): request-path WRITES on Postgres are bounded by a
 * short deadline. A stalled DB (network blackhole, failover) used to hold
 * every intent answer ~24 s (12 s query_timeout + 12 s ROLLBACK). Now the
 * await rejects after STORAGE_WRITE_DEADLINE_MS, the caller's existing
 * fail-soft/fail-closed handling runs (receipt dropped + logged, or the
 * filings fail-closed 500), and the stalled client is destroyed by
 * pgStore.tx() when its own statement/query timeout fires (never returned
 * to the pool). In the healthy case a save is ~2-20 ms, so the answer
 * still carries a receipt that is already committed.
 *
 * SQLite is untouched (synchronous, local disk, cannot stall this way).
 */
export const STORAGE_WRITE_DEADLINE_MS = (() => {
  const n = Number(process.env.STORAGE_WRITE_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? n : 1_500;
})();

export class StorageTimeoutError extends Error {
  readonly code = "STORAGE_TIMEOUT";
  constructor(op: string, ms: number) {
    super(`storage ${op} exceeded ${ms}ms deadline`);
  }
}

function withWriteDeadline<T>(op: string, p: Promise<T>): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const ms = STORAGE_WRITE_DEADLINE_MS;
  // The underlying promise keeps running; swallow its late rejection.
  p.catch(() => undefined);
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new StorageTimeoutError(op, ms)), ms);
      if (typeof t.unref === "function") t.unref();
    }),
  ]).finally(() => {
    if (t) clearTimeout(t);
  });
}

/** Open / create the active store. Postgres: schema + first connection. */
export async function initStorage(): Promise<void> {
  if (isPg()) await pg.ensurePgReady();
  else sqlite.getDb();
}

export async function closeStorage(): Promise<void> {
  // Close both: a process can have touched SQLite (e.g. migration) and pg.
  sqlite.closeDb();
  // r3: let a running/queued evidence prune finish first (capped), so it
  // cannot re-open a pool after closePg(). Within the shutdown deadline.
  let t: NodeJS.Timeout | undefined;
  await Promise.race([
    settleStoragePrunes(),
    new Promise<void>((r) => {
      t = setTimeout(r, PRUNE_SETTLE_WAIT_MS);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);
  if (t) clearTimeout(t);
  await pg.closePg();
}

/** Max wait for an in-flight prune at close (the pool close itself is capped separately at 3 s). */
export const PRUNE_SETTLE_WAIT_MS = 2_000;

export const saveReceipt = async (
  r: Receipt,
  evidence?: string | Buffer,
  pages: ReceiptPageInput[] = [],
): Promise<void> => {
  if (!isPg()) return sqlite.saveReceipt(r, evidence, pages);
  // r3 (J1-r2 m4): only the INSERT transaction is under the deadline. Once
  // it resolves the receipt is committed, so the caller's answer (which
  // always carries this receipt_id) is never failed by a slow prune.
  const added = await withWriteDeadline("saveReceipt", pg.insertReceiptPg(r, evidence, pages));
  if (added > 0) schedulePrune(r.receipt_id, added);
};

// r3 (J1-r2 m4, J2-r2 H1/m3): the evidence prune runs AFTER the save
// resolves, fire-and-forget (pruneAfterSavePg never throws; failures are
// logged), so it can neither delay nor fail an answer. It is:
//  * CHEAP under budget: this process keeps a running estimate of the
//    stored evidence total (the exact total measured by its last prune,
//    plus the gzip bytes of every save since). While the estimate stays
//    under MAX_EVIDENCE_TOTAL_BYTES and is < 5 min old, a save does NO
//    prune query at all (r2 took a global lock + two full scans on every
//    evidence save). The 5 min refresh bounds drift from writes by another
//    instance (deploy overlap) — the budget can be exceeded transiently,
//    never the reverse (nothing is pruned early).
//  * NON-BLOCKING: pg_try_advisory_xact_lock; if another session (another
//    instance, or a stale holder) has the lock, this prune is skipped and
//    the next save retries. Stale holders are ended server-side by
//    idle_in_transaction_session_timeout (15 s).
//  * COALESCED per process: at most one prune runs, plus one queued rerun
//    for the newest receipt, so a burst of saves cannot hold the pool.
//    The end state equals SQLite's (oldest-first until under budget,
//    sparing the newest receipt).
let pruneRunning: Promise<void> | null = null;
let pruneAgainFor: string | null = null;
let knownTotal: number | null = null;
let knownAt = 0;
export const PRUNE_ESTIMATE_MAX_AGE_MS = 5 * 60_000;
export const PRUNE_BUSY_RETRIES = 6;
export const PRUNE_BUSY_RETRY_MS = 500;

function schedulePrune(receiptId: string, addedBytes: number): void {
  if (
    !pruneRunning &&
    knownTotal !== null &&
    Date.now() - knownAt < PRUNE_ESTIMATE_MAX_AGE_MS &&
    knownTotal + addedBytes <= sqlite.MAX_EVIDENCE_TOTAL_BYTES
  ) {
    knownTotal += addedBytes;
    pruneStats.skippedUnderBudget += 1;
    return;
  }
  pruneAgainFor = receiptId;
  if (pruneRunning) return;
  pruneRunning = (async () => {
    while (pruneAgainFor !== null) {
      const id = pruneAgainFor;
      pruneAgainFor = null;
      let out = await pg.pruneAfterSavePg(id);
      // Lock busy (another instance pruning, or a stale holder): retry a
      // few times in the background (no pool client is held while
      // waiting), then give up until the next save.
      for (let i = 0; out && !out.ran && i < PRUNE_BUSY_RETRIES && pruneAgainFor === null; i++) {
        await new Promise((r) => setTimeout(r, PRUNE_BUSY_RETRY_MS).unref?.());
        out = await pg.pruneAfterSavePg(id);
      }
      if (out && out.ran) {
        knownTotal = out.totalAfter;
        knownAt = Date.now();
        pruneStats.ran += 1;
      } else {
        knownTotal = null; // unknown: the next save tries again
        if (out) pruneStats.skippedBusy += 1;
      }
    }
  })().finally(() => {
    pruneRunning = null;
  });
}

/** Counters for tests / diagnostics. */
export const pruneStats = { ran: 0, skippedBusy: 0, skippedUnderBudget: 0 };

/** Test hook: forget the running estimate (next evidence save measures). */
export function __resetPruneEstimateForTests(): void {
  knownTotal = null;
  knownAt = 0;
}

/** Resolves once no evidence prune is running or queued (tests, shutdown). */
export async function settleStoragePrunes(): Promise<void> {
  while (pruneRunning) await pruneRunning;
}

export const getReceiptEvidence = async (id: string): Promise<ReceiptEvidence> =>
  isPg() ? pg.getReceiptEvidencePg(id) : sqlite.getReceiptEvidence(id);

export const getReceiptPageEvidence = async (id: string, pageIndex: number): Promise<ReceiptEvidence> =>
  isPg() ? pg.getReceiptPageEvidencePg(id, pageIndex) : sqlite.getReceiptPageEvidence(id, pageIndex);

export const getReceiptPages = async (id: string): Promise<StoredReceiptPage[]> =>
  isPg() ? pg.getReceiptPagesPg(id) : sqlite.getReceiptPages(id);

export const getEvidenceBlob = async (id: string, pageIndex: number | null): Promise<StoredEvidenceBlob | null> =>
  isPg() ? pg.getEvidenceBlobPg(id, pageIndex) : sqlite.getEvidenceBlob(id, pageIndex);

export const getReceiptMeta = async (id: string): Promise<StoredReceiptMeta | null> =>
  isPg() ? pg.getReceiptMetaPg(id) : sqlite.getReceiptMeta(id);

export const getGridPrice = async (
  nodeOrZone: string,
  intervalStart: string,
): Promise<{ lmp_usd_per_mwh: number; market: string; ingested_at: string; upstream_url: string } | null> =>
  isPg() ? pg.getGridPricePg(nodeOrZone, intervalStart) : sqlite.getGridPrice(nodeOrZone, intervalStart);

export const saveGridPrice = async (
  nodeOrZone: string,
  intervalStart: string,
  lmp: number,
  market: string,
  ingestedAt?: string,
  upstreamUrl?: string,
): Promise<void> =>
  isPg()
    ? withWriteDeadline("saveGridPrice", pg.saveGridPricePg(nodeOrZone, intervalStart, lmp, market, ingestedAt, upstreamUrl))
    : sqlite.saveGridPrice(nodeOrZone, intervalStart, lmp, market, ingestedAt, upstreamUrl);

export const getGridRevalidate = async (n: string, i: string): Promise<GridRevalidateState | null> =>
  isPg() ? pg.getGridRevalidatePg(n, i) : sqlite.getGridRevalidate(n, i);

export const markGridRevalidateSuccess = async (n: string, i: string, at: string): Promise<void> =>
  isPg() ? withWriteDeadline("markGridRevalidateSuccess", pg.markGridRevalidateSuccessPg(n, i, at)) : sqlite.markGridRevalidateSuccess(n, i, at);

export const markGridRevalidateAttempt = async (n: string, i: string, at: string): Promise<void> =>
  isPg() ? withWriteDeadline("markGridRevalidateAttempt", pg.markGridRevalidateAttemptPg(n, i, at)) : sqlite.markGridRevalidateAttempt(n, i, at);

export const purgeGridCacheOverflow = async (maxRows?: number, nowMs?: number): Promise<number> =>
  isPg() ? pg.purgeGridCacheOverflowPg(maxRows, nowMs) : sqlite.purgeGridCacheOverflow(maxRows, nowMs);

// ------------------------------------------------------------ /health view

export interface StorageHealth {
  backend: StorageBackend;
  /** null until the first ping (or always, for sqlite: no network). */
  ok: boolean | null;
  last_ping_ms: number | null;
  last_checked_at: string | null;
  last_error: string | null;
}

let health: StorageHealth = {
  backend: storageBackend(),
  ok: null,
  last_ping_ms: null,
  last_checked_at: null,
  last_error: null,
};
let pinger: NodeJS.Timeout | null = null;

/** Ping budget: a ping slower than this counts as failed (it still never blocks /health). */
export const STORAGE_PING_TIMEOUT_MS = 2_000;

/** One background ping; /health only ever READS the result (never awaits the DB). */
export async function pingStorageOnce(): Promise<StorageHealth> {
  const backend = storageBackend();
  if (backend === "sqlite") {
    health = { backend, ok: true, last_ping_ms: 0, last_checked_at: new Date().toISOString(), last_error: null };
    return health;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const ms = await Promise.race([
      pg.pgPing(),
      new Promise<number>((_, rej) => {
        timer = setTimeout(() => rej(new Error("ping timeout")), STORAGE_PING_TIMEOUT_MS);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    health = { backend, ok: true, last_ping_ms: ms, last_checked_at: new Date().toISOString(), last_error: null };
  } catch (err) {
    health = {
      backend,
      ok: false,
      last_ping_ms: null,
      last_checked_at: new Date().toISOString(),
      // PG-MIGRATE r2 (J1 m3): /health is public — publish a fixed error
      // CODE, never the driver message (pg/libpq messages can echo the
      // DB host, port, user or database name).
      last_error: storageErrorCode(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
  return health;
}

/** Map a driver error to a fixed, non-identifying code for the public /health. */
export function storageErrorCode(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_error";
  if (code === "ECONNRESET" || code === "EPIPE") return "connection_reset";
  if (code === "28P01" || code === "28000") return "auth_failed";
  if (code === "3D000") return "database_missing";
  if (code === "57P01" || code === "57P02" || code === "57P03") return "server_unavailable";
  if (code === "ETIMEDOUT" || code === "57014" || msg.includes("timeout")) return "timeout";
  if (code.startsWith("53")) return "server_resources";
  if (msg.includes("ssl") || msg.includes("tls")) return "tls_error";
  return "error";
}

/** Start the 15 s background pinger (idempotent, unref'd). */
export function startStoragePinger(intervalMs = 15_000): void {
  if (pinger) return;
  void pingStorageOnce();
  pinger = setInterval(() => void pingStorageOnce(), intervalMs);
  if (typeof pinger.unref === "function") pinger.unref();
}

export function stopStoragePinger(): void {
  if (pinger) clearInterval(pinger);
  pinger = null;
}

/** In-memory snapshot for /health (no I/O). */
export function getStorageHealth(): StorageHealth {
  return { ...health, backend: storageBackend() };
}
