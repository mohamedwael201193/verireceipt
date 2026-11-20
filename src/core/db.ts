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
      PRIMARY KEY (node_or_zone, interval_start)
    );
  `);
  db = instance;
  return instance;
}

export function saveReceipt(r: Receipt): void {
  const database = getDb();
  database
    .prepare(
      `INSERT OR REPLACE INTO miner_receipts
       (receipt_id, intent, upstream_url, raw_response_sha256, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(r.receipt_id, r.intent, r.upstream_url, r.raw_response_sha256, r.fetched_at);
}

export function getGridPrice(
  nodeOrZone: string,
  intervalStart: string,
): { lmp_usd_per_mwh: number; market: string } | null {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT lmp_usd_per_mwh, market FROM grid_cache
       WHERE node_or_zone = ? AND interval_start = ?`,
    )
    .get(nodeOrZone, intervalStart) as
    | { lmp_usd_per_mwh: number; market: string }
    | undefined;
  if (!row) return null;
  return { lmp_usd_per_mwh: row.lmp_usd_per_mwh, market: row.market };
}

export function saveGridPrice(
  nodeOrZone: string,
  intervalStart: string,
  lmp: number,
  market: string,
): void {
  const database = getDb();
  database
    .prepare(
      `INSERT OR REPLACE INTO grid_cache
       (node_or_zone, interval_start, lmp_usd_per_mwh, market)
       VALUES (?, ?, ?, ?)`,
    )
    .run(nodeOrZone, intervalStart, lmp, market);
}
