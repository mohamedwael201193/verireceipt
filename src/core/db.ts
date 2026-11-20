import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import Database from "better-sqlite3";
import type { Receipt } from "./receipt";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = process.env.SQLITE_PATH || resolve(process.cwd(), "data", "verireceipt.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const instance = new Database(dbPath);
  instance.pragma("journal_mode = WAL");
  instance.exec(`
    CREATE TABLE IF NOT EXISTS miner_receipts (
      receipt_id TEXT PRIMARY KEY,
      intent TEXT NOT NULL,
      upstream_url TEXT NOT NULL,
      raw_response_sha256 TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grid_cache (
      node_or_zone TEXT NOT NULL,
      interval_start TEXT NOT NULL,
      lmp_usd_per_mwh REAL NOT NULL,
      market TEXT NOT NULL,
      ingested_at TEXT NOT NULL DEFAULT '',
      upstream_url TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (node_or_zone, interval_start)
    );
  `);
  // Migrate pre-existing grid_cache tables (created before ingested_at /
  // upstream_url existed): ADD COLUMN is idempotent via the PRAGMA check.
  // Legacy rows keep '' for both columns and are treated as stale by the
  // handler (GRID_CACHE_STALE) until the ingester overwrites them.
  const gridCols = instance.prepare("PRAGMA table_info(grid_cache)").all() as Array<{
    name: string;
  }>;
  const gridColNames = new Set(gridCols.map((c) => c.name));
  if (!gridColNames.has("ingested_at")) {
    instance.exec("ALTER TABLE grid_cache ADD COLUMN ingested_at TEXT NOT NULL DEFAULT ''");
  }
  if (!gridColNames.has("upstream_url")) {
    instance.exec("ALTER TABLE grid_cache ADD COLUMN upstream_url TEXT NOT NULL DEFAULT ''");
  }
  db = instance;
  return instance;
}

export function saveReceipt(r: Receipt): void {
  const database = getDb();
  // INSERT OR IGNORE: receipts are immutable audit records — a colliding
  // receipt_id must never silently rewrite an existing row. (OR REPLACE
  // stays correct for grid_cache, which is a cache, not an audit record.)
  database
    .prepare(
      `INSERT OR IGNORE INTO miner_receipts
       (receipt_id, intent, upstream_url, raw_response_sha256, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(r.receipt_id, r.intent, r.upstream_url, r.raw_response_sha256, r.fetched_at);
}

export function getGridPrice(
  nodeOrZone: string,
  intervalStart: string,
): {
  lmp_usd_per_mwh: number;
  market: string;
  ingested_at: string;
  upstream_url: string;
} | null {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT lmp_usd_per_mwh, market, ingested_at, upstream_url FROM grid_cache
       WHERE node_or_zone = ? AND interval_start = ?`,
    )
    .get(nodeOrZone, intervalStart) as
    | { lmp_usd_per_mwh: number; market: string; ingested_at: string; upstream_url: string }
    | undefined;
  if (!row) return null;
  return {
    lmp_usd_per_mwh: row.lmp_usd_per_mwh,
    market: row.market,
    ingested_at: row.ingested_at ?? "",
    upstream_url: row.upstream_url ?? "",
  };
}

export function saveGridPrice(
  nodeOrZone: string,
  intervalStart: string,
  lmp: number,
  market: string,
  ingestedAt?: string,
  upstreamUrl?: string,
): void {
  const database = getDb();
  database
    .prepare(
      `INSERT OR REPLACE INTO grid_cache
       (node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nodeOrZone,
      intervalStart,
      lmp,
      market,
      ingestedAt ?? new Date().toISOString(),
      upstreamUrl ?? "",
    );
}
