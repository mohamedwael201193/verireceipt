// PG-MIGRATE (2026-11-21): backend-agnostic read-backs for tests that
// assert what a handler persisted. The active backend is the app's own
// choice (core/storage.ts: DATABASE_URL -> Postgres, else SQLite), so the
// same assertion runs against whichever store the suite is pointed at.
import Database from "better-sqlite3";
import { storageBackend } from "../../src/core/storage";
import { pgQueryForTests } from "../../src/core/pgStore";

export interface StoredReceiptRow {
  receipt_id: string;
  intent: string;
  upstream_url: string;
  raw_response_sha256: string;
  evidence_bytes: number;
}

function sqliteRead<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(process.env.SQLITE_PATH as string, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export async function countReceipts(intent?: string): Promise<number> {
  if (storageBackend() === "postgres") {
    const rows = await pgQueryForTests<{ n: number }>(
      intent === undefined
        ? "SELECT COUNT(*)::int AS n FROM miner_receipts"
        : "SELECT COUNT(*)::int AS n FROM miner_receipts WHERE intent = $1",
      intent === undefined ? [] : [intent],
    );
    return rows[0].n;
  }
  return sqliteRead((db) =>
    intent === undefined
      ? (db.prepare("SELECT COUNT(*) AS n FROM miner_receipts").get() as { n: number }).n
      : (db.prepare("SELECT COUNT(*) AS n FROM miner_receipts WHERE intent = ?").get(intent) as { n: number }).n,
  );
}

export async function storedReceiptRow(id: string): Promise<StoredReceiptRow | undefined> {
  const sql = "SELECT receipt_id, intent, upstream_url, raw_response_sha256, evidence_bytes FROM miner_receipts WHERE receipt_id = ";
  if (storageBackend() === "postgres") {
    const rows = await pgQueryForTests<StoredReceiptRow>(sql + "$1", [id]);
    return rows[0];
  }
  return sqliteRead((db) => db.prepare(sql + "?").get(id) as StoredReceiptRow | undefined);
}
