// PG-MIGRATE (2026-11-21): copy every row of the SQLite store (the file on
// the Render disk) into Postgres, then verify it row by row.
//
// Usage (Render Shell, same region as the database, disk still attached):
//   node dist/tools/migrateSqliteToPg.js                  # copy + verify
//   node dist/tools/migrateSqliteToPg.js --verify-only    # verify, write nothing
// Env: SQLITE_PATH (source, default ./data/verireceipt.sqlite; opened
// READ-ONLY), DATABASE_URL (target). Prints one JSON summary line; exit 0
// only when every source row is present in Postgres with identical
// columns and byte-identical evidence — OR with identical columns and the
// blob legitimately pruned on exactly one side (evidence_pruned_source /
// evidence_pruned_target counts; r2, J1 M1 / J2 H1). Streams in chunks
// (r2, J1 M3): memory stays ~one chunk regardless of store size.
//
// Rules:
//   * Idempotent: ON CONFLICT (<primary key>) DO NOTHING everywhere — a rerun copies only
//     what is missing and never rewrites a row (receipts are immutable;
//     a grid row already written by the live Postgres app is newer and
//     wins).
//   * Evidence blobs are copied byte-for-byte (the gzipped bytes). The
//     verification compares sha256(gzip) on both sides AND gunzips the
//     Postgres copy and checks it hashes to raw_response_sha256 with the
//     recorded length — the exact check GET /receipts/:id/raw performs.
//   * Insertion order (SQLite rowid, the prune tie-break) is preserved as
//     seq = rowid - SEQ_OFFSET: negative, unique, stable across reruns,
//     and always BELOW any seq the live Postgres app assigns (identity
//     starts at 1), so migrated receipts stay "older" than new ones.
//   * The source is read inside one read transaction (a consistent
//     snapshot even while the SQLite app is still writing); copy and
//     verify both stream that same snapshot by rowid.

import Database from "better-sqlite3";
import { createHash } from "crypto";
import { gunzipSync } from "zlib";
import { resolve } from "path";
import { Pool } from "pg";
import { PG_SCHEMA_SQL, attachClientErrorGuard, pgPoolConfig } from "../core/pgStore";
import { redactSecrets } from "../core/db";

export const SEQ_OFFSET = 1_000_000_000_000;
const CHUNK = 500;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface ReceiptRow {
  rowid: number;
  receipt_id: string;
  intent: string;
  upstream_url: string;
  raw_response_sha256: string;
  fetched_at: string;
  evidence_gzip: Buffer | null;
  evidence_bytes: number;
  quorum_votes: string | null;
}
interface PageRow {
  receipt_id: string;
  page_index: number;
  url: string;
  raw_response_sha256: string;
  evidence_gzip: Buffer | null;
  evidence_bytes: number;
}
interface GridRow {
  node_or_zone: string;
  interval_start: string;
  lmp_usd_per_mwh: number;
  market: string;
  ingested_at: string;
  upstream_url: string;
}
interface RevalRow {
  node_or_zone: string;
  interval_start: string;
  last_success_at: string;
  last_attempt_at: string;
}

export interface MigrationSummary {
  ok: boolean;
  mode: "copy+verify" | "verify-only";
  source: { receipts: number; pages: number; grid: number; revalidate: number };
  inserted: { receipts: number; pages: number; grid: number; revalidate: number };
  verified: {
    receipts_present: number;
    receipts_identical: number;
    evidence_rows: number;
    evidence_sha_ok: number;
    pages_present: number;
    pages_identical: number;
    grid_present: number;
    grid_identical: number;
    grid_superseded: number;
    revalidate_present: number;
  };
  /** Rows whose blob was pruned (50 MB budget) on the SQLite side only; metadata identical. Not an error. */
  evidence_pruned_source: { receipts: number; pages: number };
  /** Rows whose blob was pruned on the Postgres side only; metadata identical. Not an error. */
  evidence_pruned_target: { receipts: number; pages: number };
  target_extra_receipts: number;
  mismatches: string[];
  /** Grid keys absent in Postgres (cache: the live app may purge under the row cap). Reported, not fatal. */
  grid_missing: string[];
  source_corrupt_evidence: string[];
  /**
   * r3 (J2-r2 m1): pruned rows that could NOT have come from the real
   * prune (oldest-first; a receipt's main blob and pages dropped
   * together). Each entry is also in `mismatches` (fails the run).
   */
  prune_violations: string[];
}

/** Receipts classified "pruned" on one side: which part was pruned. */
type PrunedSet = Map<string, { main: boolean; page: boolean }>;

/*
 * r3 (J2-r2 m1): a "pruned" row must be one the real prune could have
 * produced. The prune (db.ts pruneEvidence / pgStore pruneEvidencePg)
 * picks the receipt with the smallest (fetched_at, insertion order) that
 * still holds evidence — skipping only the receipt being saved, which is
 * the newest insert — and nulls its main blob AND all its pages in one
 * statement; evidence is never re-added. So on one side:
 *   coupling: a pruned page means its receipt's main blob is NULL; a
 *             pruned main blob means none of its pages holds evidence;
 *   order:    a pruned receipt P cannot coexist with a receipt K that
 *             still holds evidence, was inserted BEFORE P, and has
 *             fetched_at <= P's (K existed and was a better candidate
 *             when P was dropped).
 * Only the pruned ids are held in memory; the order check is one
 * window-function scan per side (streamed on SQLite, server-side on
 * Postgres), so peak RSS stays at the r2 level. Kept rows only ever
 * shrink and pruned rows stay pruned, so the live app pruning further
 * while this runs cannot create a false violation.
 */
const ORDER_SCAN_SQLITE = `SELECT receipt_id, fetched_at,
    MIN(CASE WHEN kept THEN fetched_at END) OVER (ORDER BY rowid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS min_kept
  FROM (SELECT r.rowid AS rowid, r.receipt_id, r.fetched_at,
          (r.evidence_gzip IS NOT NULL
           OR EXISTS (SELECT 1 FROM miner_receipt_pages p WHERE p.receipt_id = r.receipt_id AND p.evidence_gzip IS NOT NULL)) AS kept
        FROM miner_receipts r)`;
const ORDER_SCAN_SQLITE_NOPAGES = `SELECT receipt_id, fetched_at,
    MIN(CASE WHEN evidence_gzip IS NOT NULL THEN fetched_at END) OVER (ORDER BY rowid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS min_kept
  FROM miner_receipts`;
const ORDER_SCAN_PG = `SELECT receipt_id FROM (
    SELECT r.receipt_id, r.fetched_at COLLATE "C" AS fetched_at,
      MIN(CASE WHEN r.evidence_gzip IS NOT NULL
                 OR EXISTS (SELECT 1 FROM miner_receipt_pages p WHERE p.receipt_id = r.receipt_id AND p.evidence_gzip IS NOT NULL)
               THEN r.fetched_at COLLATE "C" END)
        OVER (ORDER BY r.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS min_kept
    FROM miner_receipts r) s
  WHERE s.receipt_id = ANY($1::text[]) AND s.min_kept <= s.fetched_at`;
const orderMsg = (side: string, id: string) =>
  `${side}: receipt ${id} pruned while an older receipt still holds evidence (prune is oldest-first)`;
const pageMsg = (side: string, id: string) => `${side}: page evidence of ${id} pruned while its receipt blob is kept`;
const mainMsg = (side: string, id: string) => `${side}: receipt ${id} blob pruned while a page still holds evidence`;

function checkPruneShapeSqlite(db: Database.Database, pruned: PrunedSet, hasPages: boolean, hasBlob: boolean): string[] {
  if (pruned.size === 0) return [];
  const out: string[] = [];
  const mainNull = hasBlob ? db.prepare("SELECT evidence_gzip IS NULL AS n FROM miner_receipts WHERE receipt_id = ?") : null;
  const pageKept = hasPages
    ? db.prepare("SELECT 1 AS x FROM miner_receipt_pages WHERE receipt_id = ? AND evidence_gzip IS NOT NULL LIMIT 1")
    : null;
  for (const [id, f] of pruned) {
    if (f.page && mainNull && !(mainNull.get(id) as { n: number }).n) out.push(pageMsg("sqlite", id));
    if (f.main && pageKept && pageKept.get(id)) out.push(mainMsg("sqlite", id));
  }
  if (hasBlob) {
    const scan = db.prepare(hasPages ? ORDER_SCAN_SQLITE : ORDER_SCAN_SQLITE_NOPAGES);
    for (const row of scan.iterate() as IterableIterator<{ receipt_id: string; fetched_at: string; min_kept: string | null }>) {
      if (row.min_kept !== null && row.min_kept <= row.fetched_at && pruned.has(row.receipt_id)) out.push(orderMsg("sqlite", row.receipt_id));
    }
  }
  return out;
}

async function checkPruneShapePg(pool: Pool, pruned: PrunedSet): Promise<string[]> {
  if (pruned.size === 0) return [];
  const out: string[] = [];
  const ids = [...pruned.keys()];
  const pages = ids.filter((id) => pruned.get(id)!.page);
  const mains = ids.filter((id) => pruned.get(id)!.main);
  const c = await pool.connect();
  try {
    // One full-table window scan: allow more than the app's 5 s cap.
    await c.query("SET statement_timeout = '120s'");
    if (pages.length) {
      const { rows } = await c.query<{ receipt_id: string }>(
        "SELECT receipt_id FROM miner_receipts WHERE receipt_id = ANY($1::text[]) AND evidence_gzip IS NOT NULL",
        [pages],
      );
      for (const r of rows) out.push(pageMsg("postgres", r.receipt_id));
    }
    if (mains.length) {
      const { rows } = await c.query<{ receipt_id: string }>(
        "SELECT DISTINCT receipt_id FROM miner_receipt_pages WHERE receipt_id = ANY($1::text[]) AND evidence_gzip IS NOT NULL",
        [mains],
      );
      for (const r of rows) out.push(mainMsg("postgres", r.receipt_id));
    }
    const { rows } = await c.query<{ receipt_id: string }>(ORDER_SCAN_PG, [ids]);
    for (const r of rows) out.push(orderMsg("postgres", r.receipt_id));
    await c.query("RESET statement_timeout");
    c.release();
  } catch (err) {
    c.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  return out;
}

function cols(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

function decodeOk(gzip: Buffer | null, bytes: number, digest: string): boolean {
  if (gzip === null) return true;
  try {
    const out = gunzipSync(gzip, { maxOutputLength: bytes + 1 });
    return out.length === bytes && sha(out) === digest;
  } catch {
    return false;
  }
}

const hasNul = (...xs: Array<string | null | undefined>) => xs.some((x) => typeof x === "string" && x.includes("\u0000"));

/**
 * How a source row compares with its Postgres copy (r2, J1 M1 / J2 H1).
 * Evidence pruning (the 50 MB budget) runs independently on BOTH stores:
 * the live SQLite app may prune a blob after the first pass copied it,
 * and the live Postgres app may prune a migrated blob. A pruned row keeps
 * every metadata column and sets evidence_gzip = NULL, evidence_bytes = 0
 * — that is policy, not corruption, so it is counted, not failed.
 */
type RowVerdict = "identical" | "pruned_source" | "pruned_target" | "mismatch";

function compareEvidence(
  baseSame: boolean,
  src: { evidence_gzip: Buffer | null; evidence_bytes: number },
  tgt: { evidence_gzip: Buffer | null; evidence_bytes: number },
): RowVerdict {
  if (!baseSame) return "mismatch";
  const a = src.evidence_gzip;
  const b = tgt.evidence_gzip;
  if (a !== null && b !== null) {
    return src.evidence_bytes === tgt.evidence_bytes && a.length === b.length && sha(a) === sha(b)
      ? "identical"
      : "mismatch";
  }
  if (a === null && b === null) return src.evidence_bytes === tgt.evidence_bytes ? "identical" : "mismatch";
  if (a === null && src.evidence_bytes === 0) return "pruned_source";
  if (b === null && tgt.evidence_bytes === 0) return "pruned_target";
  return "mismatch";
}

/**
 * Stream a table by rowid in BYTE-bounded chunks (r2, J1 M3 / J2 m4): the
 * old tool loaded every receipt + blob into memory at once (peak RSS
 * 272 MB for a 50 MB store, next to the live app on a 512 MB instance).
 * A cheap key scan (rowid + blob length, no blob bytes) plans each chunk
 * so it holds at most ~CHUNK_BYTES of evidence (or one row, if a single
 * blob is larger) and at most `maxRows` rows; only that chunk is alive.
 * All chunks read the SAME snapshot: the caller holds one read
 * transaction for the whole run.
 */
function* streamByRowid<T extends { rowid: number }>(
  db: Database.Database,
  table: string,
  sizeExpr: string, // e.g. "COALESCE(length(evidence_gzip), 0)" or "0"
  fetchSql: string, // must contain "WHERE rowid >= ? AND rowid <= ?" ... "ORDER BY rowid"
  maxRows: number,
  chunkBytes = CHUNK_BYTES,
): Generator<T[]> {
  const plan = db.prepare(`SELECT rowid AS rowid, ${sizeExpr} AS n FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
  const fetch = db.prepare(fetchSql);
  let after = -9007199254740991;
  for (;;) {
    const keys = plan.all(after, maxRows) as Array<{ rowid: number; n: number }>;
    if (keys.length === 0) return;
    let bytes = 0;
    let end = 0;
    while (end < keys.length && (end === 0 || bytes + keys[end].n <= chunkBytes)) {
      bytes += keys[end].n;
      end += 1;
    }
    const lo = keys[0].rowid;
    const hi = keys[end - 1].rowid;
    yield fetch.all(lo, hi) as T[];
    after = hi;
  }
}

/** Max rows per chunk. */
export const ROW_CHUNK = 500;
/** Max evidence bytes (gzipped) per receipt/page chunk. */
export const CHUNK_BYTES = (() => {
  const n = Number(process.env.MIGRATE_CHUNK_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4 * 1024 * 1024;
})();

export async function migrate(opts: {
  sqlitePath: string;
  databaseUrl: string;
  verifyOnly?: boolean;
  /** Test hook: override the max rows per receipt/page chunk. */
  chunkRows?: number;
}): Promise<MigrationSummary> {
  const RCH = Math.max(1, Math.floor(opts.chunkRows ?? ROW_CHUNK));
  const src = new Database(opts.sqlitePath, { readonly: true, fileMustExist: true });
  const pool = new Pool(pgPoolConfig(opts.databaseUrl));
  pool.on("error", () => undefined);
  // r3 (J1-r2 H1): a checked-out client has no pool error listener; a
  // dropped connection must reject the pass (all-or-nothing, rerunnable),
  // not crash the tool with an unhandled 'error' event.
  pool.on("connect", (client) => attachClientErrorGuard(client, opts.databaseUrl));
  const s: MigrationSummary = {
    ok: false,
    mode: opts.verifyOnly ? "verify-only" : "copy+verify",
    source: { receipts: 0, pages: 0, grid: 0, revalidate: 0 },
    inserted: { receipts: 0, pages: 0, grid: 0, revalidate: 0 },
    verified: {
      receipts_present: 0,
      receipts_identical: 0,
      evidence_rows: 0,
      evidence_sha_ok: 0,
      pages_present: 0,
      pages_identical: 0,
      grid_present: 0,
      grid_identical: 0,
      grid_superseded: 0,
      revalidate_present: 0,
    },
    evidence_pruned_source: { receipts: 0, pages: 0 },
    evidence_pruned_target: { receipts: 0, pages: 0 },
    target_extra_receipts: 0,
    mismatches: [],
    grid_missing: [],
    source_corrupt_evidence: [],
    prune_violations: [],
  };
  const prunedSrc: PrunedSet = new Map();
  const prunedTgt: PrunedSet = new Map();
  const markPruned = (set: PrunedSet, id: string, part: "main" | "page") => {
    const f = set.get(id) ?? { main: false, page: false };
    f[part] = true;
    set.set(id, f);
  };
  let inRead = false;
  let corruptCopied = 0;
  try {
    // ---- one consistent snapshot of the source for copy AND verify
    src.exec("BEGIN");
    inRead = true;
    const tables = new Set(
      (src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (t) => t.name,
      ),
    );
    const rc = cols(src, "miner_receipts");
    const receiptSql = `SELECT rowid, receipt_id, intent, upstream_url, raw_response_sha256, fetched_at,
                ${rc.has("evidence_gzip") ? "evidence_gzip" : "NULL AS evidence_gzip"},
                ${rc.has("evidence_bytes") ? "evidence_bytes" : "0 AS evidence_bytes"},
                ${rc.has("quorum_votes") ? "quorum_votes" : "NULL AS quorum_votes"}
         FROM miner_receipts WHERE rowid >= ? AND rowid <= ? ORDER BY rowid`;
    const hasPages = tables.has("miner_receipt_pages");
    const pageSql = `SELECT rowid, receipt_id, page_index, url, raw_response_sha256, evidence_gzip, evidence_bytes
         FROM miner_receipt_pages WHERE rowid >= ? AND rowid <= ? ORDER BY rowid`;
    const hasGrid = tables.has("grid_cache");
    const gc = hasGrid ? cols(src, "grid_cache") : new Set<string>();
    const gridSql = `SELECT rowid, node_or_zone, interval_start, lmp_usd_per_mwh, market,
                    ${gc.has("ingested_at") ? "ingested_at" : "'' AS ingested_at"},
                    ${gc.has("upstream_url") ? "upstream_url" : "'' AS upstream_url"}
             FROM grid_cache WHERE rowid >= ? AND rowid <= ? ORDER BY rowid`;
    const hasReval = tables.has("grid_cache_revalidate");
    const revalSql = `SELECT rowid, node_or_zone, interval_start, last_success_at, last_attempt_at
             FROM grid_cache_revalidate WHERE rowid >= ? AND rowid <= ? ORDER BY rowid`;
    const rSize = rc.has("evidence_gzip") ? "COALESCE(length(evidence_gzip), 0)" : "0";
    const recs = () => streamByRowid<R>(src, "miner_receipts", rSize, receiptSql, RCH);
    const pgs = () => streamByRowid<P>(src, "miner_receipt_pages", "COALESCE(length(evidence_gzip), 0)", pageSql, RCH);
    const grids = () => streamByRowid<G>(src, "grid_cache", "0", gridSql, CHUNK);
    const revals = () => streamByRowid<V>(src, "grid_cache_revalidate", "0", revalSql, CHUNK);
    const count = (t: string) => (src.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    s.source = {
      receipts: count("miner_receipts"),
      pages: hasPages ? count("miner_receipt_pages") : 0,
      grid: hasGrid ? count("grid_cache") : 0,
      revalidate: hasReval ? count("grid_cache_revalidate") : 0,
    };
    type R = ReceiptRow & { rowid: number };
    type P = PageRow & { rowid: number };
    type G = GridRow & { rowid: number };
    type V = RevalRow & { rowid: number };
    const nulReceipt = (r: R) => hasNul(r.receipt_id, r.intent, r.upstream_url, r.raw_response_sha256, r.fetched_at, r.quorum_votes);
    const nulPage = (p: P) => hasNul(p.receipt_id, p.url, p.raw_response_sha256);
    const nulGrid = (g: G) => hasNul(g.node_or_zone, g.interval_start, g.market, g.ingested_at, g.upstream_url);
    const nulReval = (g: V) => hasNul(g.node_or_zone, g.interval_start, g.last_success_at, g.last_attempt_at);

    // ---- copy (one Postgres transaction: all-or-nothing, chunked reads)
    if (!opts.verifyOnly) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(774921)");
        await c.query(PG_SCHEMA_SQL);
        await c.query("COMMIT");
        await c.query("BEGIN");
        for (const part of recs()) {
          for (const r of part) {
            if (nulReceipt(r)) continue; // reported by verify; Postgres TEXT cannot hold NUL
            // r2 (J1 m2): explicit conflict target — an idempotent rerun
            // skips an existing receipt_id, but a seq UNIQUE collision
            // (impossible by construction) now fails loudly.
            const res = await c.query(
              `INSERT INTO miner_receipts
               (receipt_id, intent, upstream_url, raw_response_sha256, fetched_at, evidence_gzip, evidence_bytes, quorum_votes, seq)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (receipt_id) DO NOTHING`,
              [
                r.receipt_id,
                r.intent,
                r.upstream_url,
                r.raw_response_sha256,
                r.fetched_at,
                r.evidence_gzip,
                r.evidence_bytes,
                r.quorum_votes,
                r.rowid - SEQ_OFFSET,
              ],
            );
            s.inserted.receipts += res.rowCount ?? 0;
          }
        }
        if (hasPages) {
          for (const part of pgs()) {
            for (const p of part) {
              if (nulPage(p)) continue;
              const res = await c.query(
                `INSERT INTO miner_receipt_pages
                 (receipt_id, page_index, url, raw_response_sha256, evidence_gzip, evidence_bytes)
                 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (receipt_id, page_index) DO NOTHING`,
                [p.receipt_id, p.page_index, p.url, p.raw_response_sha256, p.evidence_gzip, p.evidence_bytes],
              );
              s.inserted.pages += res.rowCount ?? 0;
            }
          }
        }
        if (hasGrid) {
          for (const raw of grids()) {
            const part = raw.filter((g) => !nulGrid(g));
            if (part.length === 0) continue;
            const res = await c.query(
              `INSERT INTO grid_cache (node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url)
               SELECT * FROM unnest($1::text[], $2::text[], $3::float8[], $4::text[], $5::text[], $6::text[])
               ON CONFLICT (node_or_zone, interval_start) DO NOTHING`,
              [
                part.map((g) => g.node_or_zone),
                part.map((g) => g.interval_start),
                part.map((g) => g.lmp_usd_per_mwh),
                part.map((g) => g.market),
                part.map((g) => g.ingested_at),
                part.map((g) => g.upstream_url),
              ],
            );
            s.inserted.grid += res.rowCount ?? 0;
          }
        }
        if (hasReval) {
          for (const raw of revals()) {
            const part = raw.filter((g) => !nulReval(g));
            if (part.length === 0) continue;
            const res = await c.query(
              `INSERT INTO grid_cache_revalidate (node_or_zone, interval_start, last_success_at, last_attempt_at)
               SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
               ON CONFLICT (node_or_zone, interval_start) DO NOTHING`,
              [
                part.map((g) => g.node_or_zone),
                part.map((g) => g.interval_start),
                part.map((g) => g.last_success_at),
                part.map((g) => g.last_attempt_at),
              ],
            );
            s.inserted.revalidate += res.rowCount ?? 0;
          }
        }
        await c.query("COMMIT");
        c.release();
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    }

    // ---- verify (re-streams the same source snapshot; reads Postgres
    // back chunk by chunk; never trusts the insert counts)
    for (const part of recs()) {
      const res = await pool.query(
        `SELECT receipt_id, intent, upstream_url, raw_response_sha256, fetched_at, evidence_gzip,
                evidence_bytes, quorum_votes, seq
         FROM miner_receipts WHERE receipt_id = ANY($1::text[])`,
        [part.filter((r) => !nulReceipt(r)).map((r) => r.receipt_id)],
      );
      const got = new Map<string, ReceiptRow>(res.rows.map((row: ReceiptRow) => [row.receipt_id, row]));
      for (const r of part) {
        const srcCorrupt = !decodeOk(r.evidence_gzip, r.evidence_bytes, r.raw_response_sha256);
        if (srcCorrupt) s.source_corrupt_evidence.push(`receipt ${r.receipt_id}`);
        if (nulReceipt(r)) {
          s.mismatches.push(`receipt ${JSON.stringify(r.receipt_id)} contains NUL; cannot be stored in postgres`);
          continue;
        }
        const t = got.get(r.receipt_id);
        if (!t) {
          s.mismatches.push(`receipt ${r.receipt_id} missing in postgres`);
          continue;
        }
        s.verified.receipts_present += 1;
        const base =
          t.intent === r.intent &&
          t.upstream_url === r.upstream_url &&
          t.raw_response_sha256 === r.raw_response_sha256 &&
          t.fetched_at === r.fetched_at &&
          (t.quorum_votes ?? null) === (r.quorum_votes ?? null);
        const v = compareEvidence(base, r, t);
        if (v === "identical") s.verified.receipts_identical += 1;
        else if (v === "pruned_source") {
          s.evidence_pruned_source.receipts += 1;
          markPruned(prunedSrc, r.receipt_id, "main");
        } else if (v === "pruned_target") {
          s.evidence_pruned_target.receipts += 1;
          markPruned(prunedTgt, r.receipt_id, "main");
        }
        else s.mismatches.push(`receipt ${r.receipt_id} differs in postgres`);
        if (t.evidence_gzip !== null) {
          s.verified.evidence_rows += 1;
          if (decodeOk(t.evidence_gzip, t.evidence_bytes, t.raw_response_sha256)) s.verified.evidence_sha_ok += 1;
          // A blob already corrupt in SQLite and copied byte-for-byte is
          // reported in source_corrupt_evidence (pre-existing; GET /raw
          // fails closed on it either way), not as a migration error.
          else if (srcCorrupt && v === "identical") corruptCopied += 1;
          else s.mismatches.push(`receipt ${r.receipt_id} postgres evidence does not decode to raw_response_sha256`);
        }
      }
    }
    const [{ n: pgTotal }] = (await pool.query("SELECT COUNT(*)::int AS n FROM miner_receipts")).rows;
    s.target_extra_receipts = pgTotal - s.verified.receipts_present;

    if (hasPages) {
      for (const part of pgs()) {
        const ok = part.filter((p) => !nulPage(p));
        const res = await pool.query(
          `SELECT t.receipt_id, t.page_index, t.url, t.raw_response_sha256, t.evidence_gzip, t.evidence_bytes
           FROM miner_receipt_pages t
           JOIN unnest($1::text[], $2::int[]) AS k(receipt_id, page_index)
             ON t.receipt_id = k.receipt_id AND t.page_index = k.page_index`,
          [ok.map((p) => p.receipt_id), ok.map((p) => p.page_index)],
        );
        const got = new Map<string, PageRow>(res.rows.map((row: PageRow) => [`${row.receipt_id}#${row.page_index}`, row]));
        for (const p of part) {
          const srcCorrupt = !decodeOk(p.evidence_gzip, p.evidence_bytes, p.raw_response_sha256);
          if (srcCorrupt) s.source_corrupt_evidence.push(`receipt ${p.receipt_id} page ${p.page_index}`);
          if (nulPage(p)) {
            s.mismatches.push(`page ${JSON.stringify(p.receipt_id)}#${p.page_index} contains NUL; cannot be stored in postgres`);
            continue;
          }
          const t = got.get(`${p.receipt_id}#${p.page_index}`);
          if (!t) {
            s.mismatches.push(`page ${p.receipt_id}#${p.page_index} missing in postgres`);
            continue;
          }
          s.verified.pages_present += 1;
          const base = t.url === p.url && t.raw_response_sha256 === p.raw_response_sha256;
          const v = compareEvidence(base, p, t);
          if (v === "identical") s.verified.pages_identical += 1;
          else if (v === "pruned_source") {
            s.evidence_pruned_source.pages += 1;
            markPruned(prunedSrc, p.receipt_id, "page");
          } else if (v === "pruned_target") {
            s.evidence_pruned_target.pages += 1;
            markPruned(prunedTgt, p.receipt_id, "page");
          }
          else s.mismatches.push(`page ${p.receipt_id}#${p.page_index} differs in postgres`);
          if (t.evidence_gzip !== null) {
            s.verified.evidence_rows += 1;
            if (decodeOk(t.evidence_gzip, t.evidence_bytes, t.raw_response_sha256)) s.verified.evidence_sha_ok += 1;
            else if (srcCorrupt && v === "identical") corruptCopied += 1;
            else s.mismatches.push(`page ${p.receipt_id}#${p.page_index} postgres evidence does not decode to raw_response_sha256`);
          }
        }
      }
    }

    if (hasGrid) {
      for (const part of grids()) {
        const ok = part.filter((g) => !nulGrid(g));
        const res = await pool.query(
          `SELECT t.node_or_zone, t.interval_start, t.lmp_usd_per_mwh, t.market, t.ingested_at, t.upstream_url
           FROM grid_cache t JOIN unnest($1::text[], $2::text[]) AS k(n, i)
             ON t.node_or_zone = k.n AND t.interval_start = k.i`,
          [ok.map((g) => g.node_or_zone), ok.map((g) => g.interval_start)],
        );
        const got = new Map<string, GridRow>(res.rows.map((row: GridRow) => [`${row.node_or_zone}|${row.interval_start}`, row]));
        for (const g of part) {
          if (nulGrid(g)) {
            s.grid_missing.push(`grid ${JSON.stringify(g.node_or_zone)} contains NUL (not copied)`);
            continue;
          }
          const t = got.get(`${g.node_or_zone}|${g.interval_start}`);
          if (!t) {
            // The live Postgres app may have purged it under the row cap;
            // that is cache policy, not data loss — but it is reported.
            s.grid_missing.push(`grid ${g.node_or_zone}|${g.interval_start}`);
            continue;
          }
          s.verified.grid_present += 1;
          const same =
            t.lmp_usd_per_mwh === g.lmp_usd_per_mwh &&
            t.market === g.market &&
            t.ingested_at === g.ingested_at &&
            t.upstream_url === g.upstream_url;
          if (same) s.verified.grid_identical += 1;
          else if (t.ingested_at > g.ingested_at) s.verified.grid_superseded += 1; // newer live write wins
          else s.mismatches.push(`grid ${g.node_or_zone}|${g.interval_start} differs in postgres`);
        }
      }
    }
    if (hasReval) {
      for (const part of revals()) {
        const ok = part.filter((g) => !nulReval(g));
        const res = await pool.query(
          `SELECT t.node_or_zone, t.interval_start FROM grid_cache_revalidate t
           JOIN unnest($1::text[], $2::text[]) AS k(n, i) ON t.node_or_zone = k.n AND t.interval_start = k.i`,
          [ok.map((g) => g.node_or_zone), ok.map((g) => g.interval_start)],
        );
        const keys = new Set(res.rows.map((r: RevalRow) => `${r.node_or_zone}|${r.interval_start}`));
        for (const r of part) {
          if (keys.has(`${r.node_or_zone}|${r.interval_start}`)) s.verified.revalidate_present += 1;
          else s.grid_missing.push(`revalidate ${r.node_or_zone}|${r.interval_start}`);
        }
      }
    }
    // r3 (J2-r2 m1): a "pruned" row must look like a real prune.
    s.prune_violations.push(...checkPruneShapeSqlite(src, prunedSrc, hasPages, rc.has("evidence_gzip")));
    s.prune_violations.push(...(await checkPruneShapePg(pool, prunedTgt)));
    prunedSrc.clear();
    prunedTgt.clear();
    s.mismatches.push(...s.prune_violations);
    src.exec("COMMIT");
    inRead = false;
    // ok = no real mismatch, and every source receipt/page is accounted
    // for as identical OR legitimately pruned on exactly one side.
    s.ok =
      s.mismatches.length === 0 &&
      s.verified.receipts_identical + s.evidence_pruned_source.receipts + s.evidence_pruned_target.receipts ===
        s.source.receipts &&
      s.verified.pages_identical + s.evidence_pruned_source.pages + s.evidence_pruned_target.pages === s.source.pages &&
      s.verified.evidence_sha_ok + corruptCopied === s.verified.evidence_rows;
    return s;
  } finally {
    try {
      if (inRead) src.exec("ROLLBACK");
    } catch {
      // read-only handle
    }
    try {
      src.close();
    } catch {
      // read-only handle
    }
    await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  const verifyOnly = process.argv.includes("--verify-only");
  const sqlitePath = process.env.SQLITE_PATH || resolve(process.cwd(), "data", "verireceipt.sqlite");
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    console.error("FATAL: DATABASE_URL is not set");
    process.exit(2);
  }
  migrate({ sqlitePath, databaseUrl, verifyOnly })
    .then((s) => {
      const out = {
        ...s,
        mismatches: s.mismatches.slice(0, 50),
        mismatch_count: s.mismatches.length,
        grid_missing: s.grid_missing.slice(0, 20),
        grid_missing_count: s.grid_missing.length,
        prune_violations: s.prune_violations.slice(0, 50),
        prune_violation_count: s.prune_violations.length,
      };
      console.log(JSON.stringify(out));
      process.exit(s.ok ? 0 : 1);
    })
    .catch((err: unknown) => {
      console.error(
        redactSecrets(`FATAL: migration failed: ${err instanceof Error ? err.message : String(err)}`, [databaseUrl]),
      );
      process.exit(1);
    });
}
