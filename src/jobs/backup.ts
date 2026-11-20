// VeriReceipt — on-disk snapshots + daily off-service backup.
//
// (b) Hourly on-disk snapshots of the SQLite DB (VACUUM INTO) with
//     24-file retention, all under <db-dir>/backups (derived from
//     SQLITE_PATH, never hardcoded to /var/data).
// (c) Daily off-service backup: yesterday's COMPLETE day of receipts as
//     JSONL, uploaded once (append-only, idempotent) to a private GitHub
//     repo via the Contents API. Only 5 fields per row, no secrets, no
//     evidence bodies. The token comes from BACKUP_GITHUB_TOKEN in the
//     environment only and is never logged.
//
// This module has NO side effects on import: timers start only when
// startBackupJobs() is called (the coordinator wires it at boot, after
// getDb() works). Every failure path logs and never throws, so a backup
// problem can never crash the server.

import { mkdirSync, readdirSync, rmSync, statSync, lstatSync } from "fs";
import { dirname, join } from "path";
import { getDb, isValidFetchedAt, redactSecrets, resolveDbPath } from "../core/db";

// Secret redaction lives in src/core/db.ts (redactSecrets) so the DB
// guard's own log line and thrown messages can use it without a circular
// import; this module re-exports it so existing imports keep working.
export { redactSecrets };

export const BACKUP_REPO_DEFAULT = "mohamedwael201193/verireceipt-backups";
export const GITHUB_API_BASE = "https://api.github.com";
export const SNAPSHOT_RETENTION = 24;
export const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
export const DAILY_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SNAPSHOT_NAME_RE = /^verireceipt-(\d{8})-(\d{4})\.sqlite$/;

/**
 * Redaction audit (R3/B1): EVERY console.* call in this module routes its
 * string through redactSecrets() — all 25+ sites, log/warn/error alike —
 * so the §11 claim "every error string logged by backup.ts passes through
 * redactSecrets()" is literally true (it was false in round 2: the GET-
 * and PUT-status failures and the static BACKUP_REPO failure were
 * unwrapped). The redactor itself (patterns, >= 16-char rule,
 * case-insensitive matching, newline-split rejoining) is documented on
 * redactSecrets in src/core/db.ts. Static strings are wrapped too: the
 * wrap is the identity for them, and wrapping everything makes the
 * audit one grep instead of a per-site judgement call.
 */

/** UTC timestamp for a snapshot filename: YYYYMMDD-HHMM. */
export function snapshotFileName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `verireceipt-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}.sqlite`
  );
}

/** Snapshot directory: <directory of SQLITE_PATH>/backups. */
export function snapshotDir(): string {
  return join(dirname(resolveDbPath()), "backups");
}

/**
 * Take one on-disk snapshot now (VACUUM INTO). Returns the snapshot path
 * on success, or null on failure (logged, never thrown). Pruning runs
 * regardless of snapshot success (F5): a failed snapshot used to skip
 * pruning entirely, so under persistent snapshot failure the backups
 * directory grew unboundedly. Pruning has its own error handling and
 * never throws, so it cannot mask the snapshot result.
 *
 * R5/O2 — RETURN-VALUE CONTRACT, READ THIS BEFORE LOGGING THE RESULT:
 * the returned path is the RAW, unredacted filesystem path. It is raw
 * on purpose: callers use it for fs operations (the tests open /
 * stat / existsSync it, and any future caller may too), so returning
 * the redacted form would hand back a path that does not exist. The
 * path is derived from SQLITE_PATH, which is user-configured and may
 * contain a token-shaped substring (e.g. a directory named after a
 * token) — so the return value may itself contain a token. NEVER LOG
 * THE RETURN VALUE. The log line inside this function already uses
 * the redacted form; log that line (or nothing at all), never this
 * return. The only production caller (startBackupJobs()) discards the
 * return value entirely. A future caller that only needs the path for
 * display must pass it through redactSecrets() first.
 */
export function snapshotNow(now: Date = new Date()): string | null {
  const dir = snapshotDir();
  const file = join(dir, snapshotFileName(now));
  try {
    mkdirSync(dir, { recursive: true });
    // VACUUM INTO takes a literal filename; escape embedded single quotes
    // by doubling them (the path is derived from SQLITE_PATH, not user input).
    const escaped = file.replace(/'/g, "''");
    getDb().exec(`VACUUM INTO '${escaped}'`);
    const bytes = statSync(file).size;
    console.log(redactSecrets(`verireceipt: snapshot ${file} (${bytes} bytes)`));
    return file;
  } catch (err) {
    // The whole line (including the file path) goes through redactSecrets:
    // a secret-shaped substring in SQLITE_PATH would otherwise leak via
    // the unredacted prefix (F3 — this is the mutant-C site).
    console.error(
      redactSecrets(
        `verireceipt: snapshot failed for ${file}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return null;
  } finally {
    try {
      pruneSnapshots(dir);
    } catch {
      // pruneSnapshots() never throws by design; belt-and-braces so a
      // prune failure can never mask the snapshot result.
    }
  }
}

/**
 * Delete snapshot files older than the newest SNAPSHOT_RETENTION in `dir`
 * (default: snapshotDir()). Only files matching the snapshot name pattern
 * are considered; anything else in the directory is left alone. Returns
 * the number of files deleted. Never throws for a missing directory.
 */
export function pruneSnapshots(dir: string = snapshotDir()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    // F1: a missing directory used to return 0 in complete silence. A
    // deleted backups directory is exactly the state an operator would
    // want logged, so it gets its own line (still returns 0). Any other
    // read failure (e.g. the path is a file) is an error line instead.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      // R3/F1: a broken symlink also surfaces as ENOENT from readdirSync,
      // but the path EXISTS — "directory missing" would be the wrong
      // diagnosis. lstat (which does not follow the link) tells them
      // apart: if lstat succeeds, something is there and it cannot be
      // read (broken symlink / unreadable directory); only a failed
      // lstat means the directory is really missing.
      let pathExists = false;
      try {
        lstatSync(dir);
        pathExists = true;
      } catch {
        pathExists = false;
      }
      if (pathExists) {
        console.log(
          redactSecrets(
            `verireceipt: prune: path exists but cannot be read ` +
              `(broken symlink or unreadable directory), nothing pruned in ${dir}`,
          ),
        );
      } else {
        console.log(
          redactSecrets(`verireceipt: prune: directory missing, nothing pruned in ${dir}`),
        );
      }
    } else {
      console.error(
        redactSecrets(
          `verireceipt: prune: cannot read directory ${dir}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    return 0;
  }
  // R3/F5: a snapshot-named DIRECTORY can never be pruned (rmSync throws
  // EISDIR every run) — it used to stick retention at 25 with a perpetual
  // error log. Directory entries are skipped distinctly: they are never
  // deleted, never counted as kept files, and warned about once per
  // prune. Only real files count toward the 24-file retention.
  const dirEntries: string[] = [];
  const snapshots = names
    .filter((n) => SNAPSHOT_NAME_RE.test(n))
    .filter((n) => {
      try {
        if (statSync(join(dir, n)).isDirectory()) {
          dirEntries.push(n);
          return false;
        }
      } catch {
        // stat failed: treat as a file; rmSync reports the real error.
      }
      return true;
    })
    .sort(); // fixed-width UTC timestamps sort chronologically
  if (dirEntries.length > 0) {
    console.warn(
      redactSecrets(
        `verireceipt: prune: skipping ${dirEntries.length} snapshot-named ` +
          `director(ies) (not files, left alone) in ${dir}: ${dirEntries.join(", ")}`,
      ),
    );
  }
  const excess = snapshots.length - SNAPSHOT_RETENTION;
  if (excess <= 0) {
    // Log every prune, including a no-op, so a silent retention run is
    // distinguishable from a prune that never ran.
    console.log(
      redactSecrets(`verireceipt: prune: 0 deleted, ${snapshots.length} kept in ${dir}`),
    );
    return 0;
  }
  let deleted = 0;
  for (const name of snapshots.slice(0, excess)) {
    try {
      rmSync(join(dir, name));
      deleted++;
    } catch (err) {
      console.error(
        redactSecrets(
          `verireceipt: failed to prune snapshot ${join(dir, name)}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
  console.log(
    redactSecrets(
      `verireceipt: prune: ${deleted} deleted, ${snapshots.length - deleted} kept in ${dir}`,
    ),
  );
  return deleted;
}

// ---------------------------------------------------------------------------
// Daily off-service backup (JSONL to GitHub)
// ---------------------------------------------------------------------------

/** The 5 exported fields, in order. Nothing else is ever exported. */
export const JSONL_FIELDS = [
  "receipt_id",
  "intent",
  "upstream_url",
  "raw_response_sha256",
  "fetched_at",
] as const;

export interface ReceiptRow {
  receipt_id: string;
  intent: string;
  upstream_url: string;
  raw_response_sha256: string;
  fetched_at: string;
}

/** UTC date string YYYYMMDD for the day before `now` (the last complete day). */
export function yesterdayDateStr(now: Date = new Date()): string {
  const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  y.setUTCDate(y.getUTCDate() - 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y.getUTCFullYear()}${p(y.getUTCMonth() + 1)}${p(y.getUTCDate())}`;
}

export interface JsonlExport {
  /** Yesterday's date, UTC, as YYYYMMDD. */
  dateStr: string;
  /** One JSON object per line (5 fields each), trailing newline per line; "" when empty. */
  jsonl: string;
  count: number;
}

/**
 * Build the JSONL export for one UTC day (YYYYMMDD) from miner_receipts.
 * Pure DB read — no network, no secrets. Rows are ordered by fetched_at,
 * then receipt_id, so the output is deterministic.
 *
 * F4(a): rows whose fetched_at does not parse are NEVER dropped silently.
 * Two cases, both warned about (count + receipt_ids, never row contents):
 * (1) `date(fetched_at)` is NULL (garbage, empty, slash dates, epoch
 * numbers, out-of-range times) — such a row matches no day at all, so it
 * is excluded from every export and named in a warning; (2) a row that
 * DOES match this day but fails strict ISO validation — the only such
 * shape is an impossible calendar date SQLite normalizes, e.g.
 * `2026-02-30` lands in the 2026-03-02 export via date() — it is
 * excluded from the export and named in a warning instead of being
 * shipped under the wrong day. Write-time validation in saveReceipt()
 * rejects both shapes for new rows; these warnings cover rows that got
 * in by direct DB tampering or predate that validation. Decision:
 * dropped-but-logged, never silently dropped, never exported under a
 * normalized/wrong day.
 */
export function exportReceiptsJsonlForDay(dateStr: string): JsonlExport {
  const isoDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  // Day boundary is the parsed UTC date, NOT a string prefix of fetched_at:
  // SQLite's date() converts an offset timestamp to UTC first, so
  // "2026-11-20T00:30:00+02:00" (= 2026-11-19 22:30 UTC) belongs to
  // 2026-11-19, while "2026-11-19T23:30:00-05:00" (= 2026-11-20 04:30 UTC)
  // does not. A substr(fetched_at, 1, 10) comparison gets both backwards.
  const db = getDb();
  const unparseable = db
    .prepare(
      `SELECT receipt_id FROM miner_receipts
       WHERE date(fetched_at) IS NULL
       ORDER BY receipt_id ASC`,
    )
    .all() as Array<{ receipt_id: string }>;
  if (unparseable.length > 0) {
    console.warn(
      redactSecrets(
        `verireceipt: export warning: ${unparseable.length} receipt(s) with ` +
          `unparseable fetched_at excluded from every daily export: ` +
          unparseable.map((r) => r.receipt_id).join(", "),
      ),
    );
  }
  const rows = db
    .prepare(
      `SELECT receipt_id, intent, upstream_url, raw_response_sha256, fetched_at
       FROM miner_receipts
       WHERE date(fetched_at) = ?
       ORDER BY fetched_at ASC, receipt_id ASC`,
    )
    .all(isoDate) as ReceiptRow[];
  const invalidInDay = rows.filter((r) => !isValidFetchedAt(r.fetched_at));
  if (invalidInDay.length > 0) {
    console.warn(
      redactSecrets(
        `verireceipt: export warning: ${invalidInDay.length} receipt(s) with ` +
          `invalid fetched_at excluded from the ${dateStr} export: ` +
          invalidInDay.map((r) => r.receipt_id).join(", "),
      ),
    );
  }
  const lines = rows
    .filter((r) => isValidFetchedAt(r.fetched_at))
    .map((r) =>
      JSON.stringify({
        receipt_id: r.receipt_id,
        intent: r.intent,
        upstream_url: r.upstream_url,
        raw_response_sha256: r.raw_response_sha256,
        fetched_at: r.fetched_at,
      }),
    );
  return { dateStr, jsonl: lines.length > 0 ? lines.join("\n") + "\n" : "", count: lines.length };
}

/**
 * Build the JSONL export for yesterday (UTC, last complete day only).
 * Thin wrapper over exportReceiptsJsonlForDay() (see it for the
 * unparseable-fetched_at warning behaviour).
 */
export function exportReceiptsJsonl(now: Date = new Date()): JsonlExport {
  return exportReceiptsJsonlForDay(yesterdayDateStr(now));
}

/** UTC date string YYYYMMDD for `daysAgo` days before `now`. */
export function dateStrForDaysAgo(now: Date, daysAgo: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

export type DailyBackupResult =
  | "created"
  | "skipped-exists"
  | "skipped-empty"
  | "skipped-no-token"
  | "failed"
  | "created-with-dropped"
  | "skipped-with-dropped";

/** One receipt-bearing day that fell out of the 7-day backfill window. */
export interface AgedOutDay {
  /** UTC date as YYYYMMDD. */
  dateStr: string;
  /** Receipts on that day. They stay in the local DB — never deleted. */
  count: number;
}

/** Aggregate outcome of one pushDailyBackup run. */
export interface DailyBackupSummary {
  result: DailyBackupResult;
  /**
   * Receipt-bearing days older than the window, each with its receipt
   * count. [] when none. A non-empty list means real receipts will
   * NEVER be backed up by the daily job unless the window grows or the
   * days are uploaded by hand — the result is never a clean "created"
   * / "skipped-exists" / "skipped-empty" while this list is non-empty.
   */
  dropped_days: AgedOutDay[];
}

/**
 * How many days back a daily run looks for missed uploads (yesterday
 * plus the 6 days before it). Bounded: a transient GitHub failure must
 * not leave a day un-backed-up forever, but an unbounded backfill could
 * re-upload weeks of history on the first run after a long outage.
 */
export const DAILY_BACKUP_WINDOW_DAYS = 7;

/**
 * Upload one day's JSONL (see pushDailyBackup for the rules). Returns the
 * per-day outcome. `isYesterday` selects the strict failure reporting
 * for the GET-exists probe: yesterday's own GET failure fails the run.
 *
 * R3/B3: a backfill day's GET that answers with anything other than
 * 200/404 (e.g. a transient HTTP 500 on the existence check) used to
 * return "skipped-empty" — which is indistinguishable from "this day has
 * no receipts", so a receipt-bearing day could be silently skipped while
 * the run reported success. It now returns "failed" (and still logs a
 * warning naming the day): the run fails loudly, and the next daily run
 * retries the day inside the window. This reverses the round-2
 * rationale ("failing the whole run over a backfill probe would mask
 * yesterday's outcome"): yesterday's per-day outcome is still visible
 * in the logs, and a silent skip of real receipts is the worse failure.
 *
 * `fetchImpl` is injectable so tests can stub fetch; production passes the
 * global fetch. Never throws: every failure returns "failed".
 */
async function pushOneDayBackup(
  fetchImpl: typeof fetch,
  token: string,
  repo: string,
  dateStr: string,
  isYesterday: boolean,
): Promise<DailyBackupResult> {
  let exp: JsonlExport;
  try {
    exp = exportReceiptsJsonlForDay(dateStr);
  } catch (err) {
    console.error(
      redactSecrets(
        `verireceipt: daily backup failed to export receipts for ${dateStr}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        [token],
      ),
    );
    return "failed";
  }
  if (exp.count === 0) {
    if (isYesterday) {
      console.log(
        redactSecrets(`verireceipt: no receipts for ${exp.dateStr}, skipping daily backup`),
      );
    }
    return "skipped-empty";
  }

  const filename = `receipts-${exp.dateStr}.jsonl`;
  const url = `${GITHUB_API_BASE}/repos/${repo}/contents/${filename}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "verireceipt-backup",
  };

  try {
    const existing = await fetchImpl(url, { method: "GET", headers });
    if (existing.status === 200) {
      console.log(
        redactSecrets(`verireceipt: daily backup ${filename} already exists, skipping`),
      );
      return "skipped-exists";
    }
    if (existing.status !== 404) {
      // R3/B1: these two lines were the unwrapped console.error sites
      // behind the false §11 sentence (J1 B3); both now go through
      // redactSecrets() like every other log line in this module.
      // R3/B3: a non-200/404 GET for a receipt-bearing day is a failure,
      // never "skipped-empty" — see the docstring above.
      if (isYesterday) {
        console.error(
          redactSecrets(
            `verireceipt: daily backup failed: GET ${filename} returned HTTP ${existing.status}`,
            [token],
          ),
        );
        return "failed";
      }
      console.warn(
        redactSecrets(
          `verireceipt: daily backup backfill: GET ${filename} returned HTTP ` +
            `${existing.status}, skipping ${exp.dateStr} for this run; ` +
            `the day will be retried on the next run`,
          [token],
        ),
      );
      return "failed";
    }
    const put = await fetchImpl(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `backup receipts ${exp.dateStr}`,
        content: Buffer.from(exp.jsonl, "utf8").toString("base64"),
        branch: "main",
      }),
    });
    if (put.status === 201 || put.status === 200) {
      console.log(
        redactSecrets(
          `verireceipt: daily backup ${filename} created (${exp.count} receipts)`,
        ),
      );
      return "created";
    }
    console.error(
      redactSecrets(
        `verireceipt: daily backup failed: PUT ${filename} returned HTTP ${put.status}`,
        [token],
      ),
    );
    return "failed";
  } catch (err) {
    console.error(
      redactSecrets(
        `verireceipt: daily backup failed for ${filename}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        [token],
      ),
    );
    return "failed";
  }
}

/**
 * Receipt-bearing days older than the backfill window, oldest first.
 * A day counts when `date(fetched_at)` parses to a UTC date strictly
 * older than the window's oldest day (now − DAILY_BACKUP_WINDOW_DAYS);
 * rows whose fetched_at does not parse at all have no day and are not
 * counted here (the export already warns about them). Pure DB read.
 */
export function findAgedOutDays(now: Date = new Date()): AgedOutDay[] {
  const oldest = dateStrForDaysAgo(now, DAILY_BACKUP_WINDOW_DAYS);
  const oldestIso = `${oldest.slice(0, 4)}-${oldest.slice(4, 6)}-${oldest.slice(6, 8)}`;
  const rows = getDb()
    .prepare(
      `SELECT date(fetched_at) AS day, COUNT(*) AS n FROM miner_receipts
       WHERE date(fetched_at) IS NOT NULL AND date(fetched_at) < ?
       GROUP BY day ORDER BY day ASC`,
    )
    .all(oldestIso) as Array<{ day: string; n: number }>;
  return rows.map((r) => ({ dateStr: r.day.replace(/-/g, ""), count: r.n }));
}

/**
 * Upload yesterday's JSONL to GitHub (Contents API), append-only and
 * idempotent: if receipts-YYYYMMDD.jsonl already exists (GET 200) the
 * upload is skipped entirely and the remote file is never modified. Only
 * creates (PUT) when the file is absent (GET 404). Zero receipts for
 * yesterday uploads nothing. A missing BACKUP_GITHUB_TOKEN logs a warning
 * and skips (never throws). The token is never logged, in whole or in part.
 *
 * F6 backfill: each run also attempts any prior day inside the last
 * DAILY_BACKUP_WINDOW_DAYS (7) days whose backup file does not yet exist
 * (same GET-first idempotency), so a day lost to a transient GitHub
 * failure is picked up by the next run instead of never being backed up.
 * A backfill day's GET that answers with anything other than 200/404
 * fails the run (warned, named, retried next run) — it is never reported
 * as "skipped-empty".
 *
 * R3/B3 aged-out days: the 7-day window is bounded by design, so a day
 * older than the window is NEVER attempted — but it used to be dropped
 * silently while the run reported a clean "created". Every run now
 * detects receipt-bearing days older than the window, logs one warning
 * per day naming the day and its receipt count, logs an aggregate
 * warning, and returns them in `dropped_days`; the result is never a
 * clean "created" / "skipped-exists" / "skipped-empty" while any exist
 * ("created-with-dropped" / "skipped-with-dropped"). The receipts stay
 * in the local DB — there is no local loss, only a missed off-service
 * copy. The window itself is NOT silently extended: growing it is a
 * coordinator decision. R4/MINOR-2: the detection runs BEFORE the
 * no-token / bad-repo early returns (it needs only the DB, not the
 * token), so a run that backs up NOTHING still discloses the days
 * aging out — the old order returned `dropped_days: []` on those
 * paths while days aged out unreported, which is when the disclosure
 * matters most. A no-token run reports `skipped-no-token` and a
 * bad-repo run reports `failed`, both with the aged-out days listed;
 * neither is a clean result, so the "never clean while days are
 * dropped" clause still holds.
 *
 * R3/B3 concurrency: overlapping runs are coalesced in-process — a
 * second call while a run is in flight waits for (and returns) the same
 * run instead of double-PUTing every day. This is the same pattern as
 * the filings tickers coalescing. It is an in-process guard only: a
 * cross-process lock is out of scope, and the production scheduler
 * (one 24 h timer) never overlaps runs. Coalescing is by in-flight
 * run, not by arguments: a concurrent second call with DIFFERENT
 * arguments (e.g. a different `now`) still receives the first run's
 * summary, and only the first window's PUTs happen — production has a
 * single no-arg caller, so this is unobservable there.
 *
 * Aggregate result precedence: "failed" if yesterday or any backfilled
 * day failed; else "created-with-dropped" / "skipped-with-dropped" if
 * any day aged out; else "created" if any day was uploaded; else
 * "skipped-exists" if any day already existed; else "skipped-empty".
 * Returns a summary object (not a bare string): the result alone cannot
 * name the dropped days, and the old bare-string return is what let the
 * silent drop hide. The HTTP API is untouched — this is internal job
 * code; the only caller besides tests is startBackupJobs(), which
 * discards the summary.
 */

/** In-flight daily-backup run, if any (concurrency coalescing, R3/B3). */
let dailyBackupInFlight: Promise<DailyBackupSummary> | null = null;

export function pushDailyBackup(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<DailyBackupSummary> {
  if (dailyBackupInFlight) return dailyBackupInFlight;
  const run = runDailyBackup(fetchImpl, now).finally(() => {
    if (dailyBackupInFlight === run) dailyBackupInFlight = null;
  });
  dailyBackupInFlight = run;
  return run;
}

async function runDailyBackup(
  fetchImpl: typeof fetch,
  now: Date,
): Promise<DailyBackupSummary> {
  const token = process.env.BACKUP_GITHUB_TOKEN || "";
  const repo = process.env.BACKUP_REPO || BACKUP_REPO_DEFAULT;

  // R4/MINOR-2: aged-out detection runs BEFORE the token/repo early
  // returns — it needs only the DB, not the token — so a run that
  // backs up NOTHING still discloses the days aging out (that is when
  // the disclosure matters most). The old order returned
  // dropped_days: [] on the no-token / bad-repo paths while days aged
  // out unreported. The result strings are unchanged
  // (skipped-no-token / failed); only dropped_days is now populated
  // on those paths too.
  let droppedDays: AgedOutDay[] = [];
  try {
    droppedDays = findAgedOutDays(now);
  } catch (err) {
    // A DB failure here must not mask the backup loop: log it and
    // continue with no aged-out list (the loop's own export reads will
    // surface a real DB problem as per-day failures).
    console.error(
      redactSecrets(
        `verireceipt: daily backup failed to list aged-out days: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        [token],
      ),
    );
    droppedDays = [];
  }
  for (const d of droppedDays) {
    const iso = `${d.dateStr.slice(0, 4)}-${d.dateStr.slice(4, 6)}-${d.dateStr.slice(6, 8)}`;
    console.warn(
      redactSecrets(
        `verireceipt: daily backup: day ${iso} has ${d.count} receipts ` +
          `but is outside the 7-day window, NOT backed up`,
        [token],
      ),
    );
  }
  if (droppedDays.length > 0) {
    console.warn(
      redactSecrets(
        `verireceipt: daily backup: ${droppedDays.length} day(s) with receipts ` +
          `outside the 7-day window were NOT backed up: ` +
          droppedDays.map((d) => d.dateStr).join(", ") +
          ` — receipts remain in the local DB only`,
        [token],
      ),
    );
  }

  if (!token) {
    console.warn(
      redactSecrets("verireceipt: BACKUP_GITHUB_TOKEN is not set; daily backup skipped"),
    );
    return { result: "skipped-no-token", dropped_days: droppedDays };
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.error(
      redactSecrets("verireceipt: daily backup failed: BACKUP_REPO is not owner/repo"),
    );
    return { result: "failed", dropped_days: droppedDays };
  }

  let anyFailed = false;
  let anyCreated = false;
  let anyExists = false;
  for (let daysAgo = 1; daysAgo <= DAILY_BACKUP_WINDOW_DAYS; daysAgo++) {
    const result = await pushOneDayBackup(
      fetchImpl,
      token,
      repo,
      dateStrForDaysAgo(now, daysAgo),
      daysAgo === 1,
    );
    if (result === "failed") anyFailed = true;
    if (result === "created") anyCreated = true;
    if (result === "skipped-exists") anyExists = true;
  }
  if (anyFailed) return { result: "failed", dropped_days: droppedDays };
  if (droppedDays.length > 0) {
    return {
      result: anyCreated ? "created-with-dropped" : "skipped-with-dropped",
      dropped_days: droppedDays,
    };
  }
  if (anyCreated) return { result: "created", dropped_days: droppedDays };
  if (anyExists) return { result: "skipped-exists", dropped_days: droppedDays };
  return { result: "skipped-empty", dropped_days: droppedDays };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface BackupJobs {
  snapshotTimer: NodeJS.Timeout;
  dailyTimer: NodeJS.Timeout;
}

let startedJobs: BackupJobs | null = null;

/**
 * Start the backup jobs. Safe to call any time after getDb() works; never
 * throws (every failure is logged). Takes one snapshot immediately, then
 * every 60 minutes; runs the daily GitHub backup once at boot, then every
 * 24 hours. The timers are deliberately ref'd: this is a long-lived server
 * process and the timers are part of it — an unref'd timer that silently
 * stopped would kill backups. Calling twice returns the existing timers.
 */
export function startBackupJobs(): BackupJobs {
  if (startedJobs) {
    console.log(redactSecrets("verireceipt: backup jobs already started"));
    return startedJobs;
  }
  try {
    snapshotNow();
  } catch (err) {
    // snapshotNow() already never throws; this is belt-and-braces.
    console.error(
      redactSecrets(
        `verireceipt: boot snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
  const snapshotTimer = setInterval(() => {
    try {
      snapshotNow();
    } catch (err) {
      console.error(
        redactSecrets(
          `verireceipt: scheduled snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }, SNAPSHOT_INTERVAL_MS);
  const dailyTimer = setInterval(() => {
    void pushDailyBackup().catch((err: unknown) => {
      console.error(
        redactSecrets(
          `verireceipt: scheduled daily backup failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });
  }, DAILY_BACKUP_INTERVAL_MS);
  void pushDailyBackup().catch((err: unknown) => {
    console.error(
      redactSecrets(
        `verireceipt: boot daily backup failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  });
  startedJobs = { snapshotTimer, dailyTimer };
  console.log(
    redactSecrets("verireceipt: backup jobs started (hourly snapshot, daily GitHub backup)"),
  );
  return startedJobs;
}
