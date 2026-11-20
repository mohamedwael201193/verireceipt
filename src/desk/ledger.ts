// VeriReceipt Desk — SQLite ledger (desk_runs).
//
// Every ranked Telegraph call the Desk buys is logged here with its
// signal_hash, receipt_hash, miner, cost, verdict, and verification
// status. The table lives in the same SQLite database as the miner
// receipts (src/core/db.ts) and is created idempotently on first use.
// Append-only audit log: rows are never updated in place except for the
// verification_status column, which moves pending -> verified/failed
// when the signal is checked against the node.

import { getDb } from "../core/db";

export interface DeskRunRow {
  id: number;
  run_id: string;
  mission: "M13" | "M12";
  scenario_id: string;
  intent: string;
  miner_id: string | null;
  miner_name: string | null;
  signal_hash: string | null;
  receipt_hash: string | null;
  /**
   * JSON of every receipt identifier the ask response provided:
   * { payments: [{miner, intent, amount_uusdc, receipt_hash}...],
   *   receipt: {receipt_hash, rail, payer, miner, intent,
   *   amount_uusdc, epoch_id, settlement, chain, timestamp} | null }.
   * A Desk call carries receipt_hash (payment proof), NOT a miner
   * receipt id (rcpt_…) and NO raw_response_sha256 — those exist only
   * on receipts OUR miner issued. See README §Desk for which
   * verification path applies to which evidence.
   */
  receipt_json: string;
  cost_uusdc: number;
  rail: string;
  verdict: string | null;
  related_party: number;
  fetched_at: string;
  verification_status: string;
  verification_json: string;
}

export interface DeskRunInput {
  run_id: string;
  mission: "M13" | "M12";
  scenario_id: string;
  intent: string;
  miner_id?: string | null;
  miner_name?: string | null;
  signal_hash?: string | null;
  receipt_hash?: string | null;
  /** JSON string of { payments, receipt } — see DeskRunRow.receipt_json. */
  receipt_json?: string;
  cost_uusdc: number;
  rail: string;
  verdict?: string | null;
  /** 1 = related-party / internal test traffic (Desk + Miner, same team). */
  related_party: number;
  fetched_at: string;
  verification_status?: string;
  verification_json?: string;
}

export function ensureDeskTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS desk_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      mission TEXT NOT NULL,
      scenario_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      miner_id TEXT,
      miner_name TEXT,
      signal_hash TEXT,
      receipt_hash TEXT,
      receipt_json TEXT NOT NULL DEFAULT '{}',
      cost_uusdc INTEGER NOT NULL DEFAULT 0,
      rail TEXT NOT NULL DEFAULT 'escrow',
      verdict TEXT,
      related_party INTEGER NOT NULL DEFAULT 1,
      fetched_at TEXT NOT NULL,
      verification_status TEXT NOT NULL DEFAULT 'pending',
      verification_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_desk_runs_signal_hash ON desk_runs(signal_hash);
    CREATE INDEX IF NOT EXISTS idx_desk_runs_fetched_at ON desk_runs(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_desk_runs_mission ON desk_runs(mission);
  `);
  // Pre-fix databases were created without receipt_json; add it in place.
  const cols = db.prepare(`PRAGMA table_info(desk_runs)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "receipt_json")) {
    db.exec(`ALTER TABLE desk_runs ADD COLUMN receipt_json TEXT NOT NULL DEFAULT '{}'`);
  }
}

export function logDeskRun(entry: DeskRunInput): number {
  ensureDeskTables();
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO desk_runs
       (run_id, mission, scenario_id, intent, miner_id, miner_name,
        signal_hash, receipt_hash, receipt_json, cost_uusdc, rail, verdict,
        related_party, fetched_at, verification_status, verification_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.run_id,
      entry.mission,
      entry.scenario_id,
      entry.intent,
      entry.miner_id ?? null,
      entry.miner_name ?? null,
      entry.signal_hash ?? null,
      entry.receipt_hash ?? null,
      entry.receipt_json ?? "{}",
      entry.cost_uusdc,
      entry.rail,
      entry.verdict ?? null,
      entry.related_party,
      entry.fetched_at,
      entry.verification_status ?? "pending",
      entry.verification_json ?? "{}",
    );
  return Number(info.lastInsertRowid);
}

/** Fill in the verdict on every row of a run once its policy has decided. */
export function updateDeskRunVerdict(runId: string, verdict: string): void {
  ensureDeskTables();
  getDb()
    .prepare(`UPDATE desk_runs SET verdict = ? WHERE run_id = ?`)
    .run(verdict, runId);
}

export function markDeskRunVerified(
  signalHash: string,
  status: "verified" | "failed",
  verificationJson: string,
): void {
  ensureDeskTables();
  getDb()
    .prepare(
      `UPDATE desk_runs SET verification_status = ?, verification_json = ?
       WHERE signal_hash = ?`,
    )
    .run(status, verificationJson, signalHash);
}

export function listDeskRuns(limit: number, offset: number): DeskRunRow[] {
  ensureDeskTables();
  const rows = getDb()
    .prepare(
      `SELECT * FROM desk_runs ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as DeskRunRow[];
  return rows;
}

export function countDeskRuns(): number {
  ensureDeskTables();
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM desk_runs`).get() as { n: number };
  return row.n;
}

export function getDeskRunBySignalHash(signalHash: string): DeskRunRow | null {
  ensureDeskTables();
  const row = getDb()
    .prepare(`SELECT * FROM desk_runs WHERE signal_hash = ? ORDER BY id DESC LIMIT 1`)
    .get(signalHash) as DeskRunRow | undefined;
  return row ?? null;
}

export interface DeskSpendTotals {
  total_calls: number;
  total_cost_uusdc: number;
  m13_calls: number;
  m12_calls: number;
  m13_cost_uusdc: number;
  m12_cost_uusdc: number;
  verified_calls: number;
  distinct_miners: number;
  distinct_scenarios: number;
}

export function deskSpendTotals(): DeskSpendTotals {
  ensureDeskTables();
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total_calls,
         COALESCE(SUM(cost_uusdc), 0) AS total_cost_uusdc,
         COALESCE(SUM(CASE WHEN mission = 'M13' THEN 1 ELSE 0 END), 0) AS m13_calls,
         COALESCE(SUM(CASE WHEN mission = 'M12' THEN 1 ELSE 0 END), 0) AS m12_calls,
         COALESCE(SUM(CASE WHEN mission = 'M13' THEN cost_uusdc ELSE 0 END), 0) AS m13_cost_uusdc,
         COALESCE(SUM(CASE WHEN mission = 'M12' THEN cost_uusdc ELSE 0 END), 0) AS m12_cost_uusdc,
         COALESCE(SUM(CASE WHEN verification_status = 'verified' THEN 1 ELSE 0 END), 0) AS verified_calls,
         COUNT(DISTINCT miner_id) AS distinct_miners,
         COUNT(DISTINCT scenario_id) AS distinct_scenarios
       FROM desk_runs`,
    )
    .get() as DeskSpendTotals;
  return row;
}

/** Spend (µUSDC) logged since the given UTC date prefix (YYYY-MM-DD). */
export function deskSpendSinceUtcDay(dayPrefix: string): { calls: number; cost_uusdc: number } {
  ensureDeskTables();
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(cost_uusdc), 0) AS cost_uusdc
       FROM desk_runs WHERE substr(fetched_at, 1, 10) = ?`,
    )
    .get(dayPrefix) as { calls: number; cost_uusdc: number };
  return row;
}

/** Public ledger row shape: adds the clickable devnode signal URL. */
export function deskRunToPublic(row: DeskRunRow): Record<string, unknown> {
  let receipt: unknown = null;
  try {
    receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null;
  } catch {
    receipt = null;
  }
  return {
    id: row.id,
    run_id: row.run_id,
    mission: row.mission,
    scenario_id: row.scenario_id,
    intent: row.intent,
    miner_id: row.miner_id,
    miner_name: row.miner_name,
    signal_hash: row.signal_hash,
    signal_url: row.signal_hash
      ? `https://devnode.telegraphprotocol.com/engine/v1/signal/${row.signal_hash}`
      : null,
    receipt_hash: row.receipt_hash,
    receipt,
    cost_uusdc: row.cost_uusdc,
    cost_usd: row.cost_uusdc / 1_000_000,
    rail: row.rail,
    verdict: row.verdict,
    related_party: row.related_party === 1,
    fetched_at: row.fetched_at,
    verification_status: row.verification_status,
  };
}
