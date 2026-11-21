// Dashboard row persistence (external QA 2026-11-21, QA-01).
//
// The Dashboard's own table holds every live call it made: receipted
// answers AND refusals / health pings (which have no receipt and are
// never written to the shared /receipts ledger). Before this module those
// rows lived in React state only, so leaving /dashboard (or reloading)
// reset the table and its counter to zero.
//
// Policy: rows are kept in sessionStorage — this browser tab only, gone
// when the tab closes — and are tied to the shared ledger's clear
// generation: a Clear on /receipts (this tab or another) bumps the
// generation, and rows stamped with an older generation are not restored.
// Receipted rows are ALSO written to the shared ledger by the Dashboard's
// onRecord (persistLiveReceiptToSessionLedger), which is what /receipts
// shows; this module only restores the Dashboard's own view.
//
// Nothing here is seeded or invented: a row is restored only if it was
// written by a real call in this tab and still passes the shape check.

import { isValidReceipt, readLedgerGeneration } from "../../lib/sessionReceipts";
import type { LiveReceipt } from "./types";
import { LEDGER_CAP } from "./utils";

export const DASHBOARD_ROWS_KEY = "verireceipt.dashboard-rows.v1";

interface StoredRows {
  v: 1;
  gen: number;
  rows: LiveReceipt[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shape check for one stored row. A row that fails it is dropped, never
 *  repaired — the drawer and the export read these fields directly. */
export function isValidLiveReceiptRow(v: unknown): v is LiveReceipt {
  if (!isRecord(v)) return false;
  for (const k of ["key", "id", "ts", "intent", "query", "requestUrl"] as const) {
    if (typeof v[k] !== "string" || (v[k] as string).length === 0) {
      // query may legitimately be empty for a cleared input
      if (!(k === "query" && v[k] === "")) return false;
    }
  }
  if (typeof v.status !== "number" || !Number.isInteger(v.status) || v.status < 0 || v.status > 999) return false;
  if (typeof v.latencyMs !== "number" || !Number.isFinite(v.latencyMs) || v.latencyMs < 0) return false;
  if (v.receipt !== null && !isValidReceipt(v.receipt)) return false;
  if (v.errorCode !== undefined && typeof v.errorCode !== "string") return false;
  if (v.errorMessage !== undefined && typeof v.errorMessage !== "string") return false;
  if (v.ledgerGenAtStart !== undefined && typeof v.ledgerGenAtStart !== "number") return false;
  return true;
}

/** Rows restored for this tab: [] when absent, unreadable, or written
 *  before the shared ledger's last Clear. */
export function readDashboardRows(): LiveReceipt[] {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(DASHBOARD_ROWS_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.gen !== "number" || !Array.isArray(parsed.rows)) {
    return [];
  }
  if (parsed.gen !== readLedgerGeneration()) return [];
  return parsed.rows.filter(isValidLiveReceiptRow).slice(0, LEDGER_CAP);
}

/**
 * Store the rows for this tab. On a quota error the OLDEST rows are
 * dropped (halving) until the write fits. Returns the number of rows
 * actually stored (0 when storage is unavailable). Never throws.
 */
export function writeDashboardRows(rows: LiveReceipt[]): number {
  let keep = rows.slice(0, LEDGER_CAP);
  const gen = readLedgerGeneration();
  for (;;) {
    const value: StoredRows = { v: 1, gen, rows: keep };
    try {
      if (keep.length === 0) {
        sessionStorage.removeItem(DASHBOARD_ROWS_KEY);
      } else {
        sessionStorage.setItem(DASHBOARD_ROWS_KEY, JSON.stringify(value));
      }
      return keep.length;
    } catch {
      if (keep.length <= 1) {
        try {
          sessionStorage.removeItem(DASHBOARD_ROWS_KEY);
        } catch {
          // storage unavailable
        }
        return 0;
      }
      keep = keep.slice(0, Math.floor(keep.length / 2));
    }
  }
}
