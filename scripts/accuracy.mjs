#!/usr/bin/env node
// accuracy.mjs — daily accuracy.json producer for VeriReceipt (S2).
//
// Reads ONLY real stored checks (the miner_receipts table this service
// wrote while answering) and emits an accuracy.json. No number in the
// output is estimated, sampled, or invented:
//
//   - receipts / with_evidence / missing_evidence are exact row counts.
//     A receipt counts as with_evidence when its blob is stored (even a
//     gzip of empty bytes); only a NULL blob counts as missing.
//   - quorum_votes_agreeing / quorum_votes_cast are EXACT decimal strings
//     summed with BigInt from stored quorum_votes strings that literally
//     begin "k/n" — no floating-point or 2^53 rounding. Every other
//     value is counted under quorum_strings_unparsed and listed in
//     unparsed_quorum_strings with its EXACT stored value (no trimming;
//     SQL NULL stays null and never merges with "").
//   - day grouping parses fetched_at as a timestamp and uses its UTC
//     calendar day, so "2026-11-22T00:15:00+03:00" counts under
//     2026-11-21. Rows whose fetched_at does not parse are counted in
//     rows_skipped_bad_fetched_at, never grouped.
//
// What this is NOT: it cannot judge answer correctness (there is no
// ground truth in the store). It reports what was issued and retained.
//
// Usage:
//   node scripts/accuracy.mjs [--db PATH] [--database-url URL]
//                             [--days N] [--out PATH | -]
// Backend precedence: explicit --db wins over everything; then explicit
// --database-url; then DATABASE_URL env; then SQLITE_PATH env; then
// data/verireceipt.sqlite. --days defaults 30 (1..366), --out defaults
// accuracy.json ("-" = stdout). Exit 1 with a message when the store is
// unreachable — a missing store never produces an empty-looking file.
//
// GET /accuracy.json (src/core/accuracy.ts) implements the SAME contract
// in-process; tests/accuracy-route.test.ts pins the two implementations
// to identical output over the same store.

import { writeFileSync } from "node:fs";

export const ACCURACY_SELECT_SQL =
  "SELECT fetched_at, intent, quorum_votes, " +
  "CASE WHEN evidence_gzip IS NOT NULL THEN 1 ELSE 0 END AS has_evidence " +
  "FROM miner_receipts";

/** k/n must LITERALLY begin the stored string (no trimming anywhere). */
const REFUSED_PREFIX = "no upstream quorum:";
const KN_RE = /^(\d+)\s*\/\s*(\d+)/;

export function resolveAccuracyBackend(opts, env = process.env) {
  const dbPath = opts?.dbPath ?? null;
  const databaseUrl = opts?.databaseUrl ?? null;
  if (dbPath) return { backend: "sqlite", dbPath };
  if (databaseUrl || env.DATABASE_URL) return { backend: "postgres", databaseUrl: databaseUrl || env.DATABASE_URL };
  return { backend: "sqlite", dbPath: env.SQLITE_PATH || "data/verireceipt.sqlite" };
}

export async function loadAccuracyRows(sel) {
  if (sel.backend === "postgres") {
    const { Client } = (await import("pg")).default ?? (await import("pg"));
    const client = new Client({ connectionString: sel.databaseUrl, connectionTimeoutMillis: 10_000, query_timeout: 30_000, statement_timeout: 30_000 });
    await client.connect();
    try {
      const res = await client.query(ACCURACY_SELECT_SQL);
      return res.rows;
    } finally {
      await client.end();
    }
  }
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(sel.dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(ACCURACY_SELECT_SQL).all();
  } finally {
    db.close();
  }
}

const TS_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Parse a stored fetched_at to epoch ms. Zone-less date-times (legacy
 * rows; db.ts documents them as UTC) are read as UTC regardless of the
 * process timezone; explicit Z / +-HH:MM offsets are honored. NaN when
 * the value is not an accepted ISO form.
 */
export function parseFetchedAtMs(value) {
  const v = String(value ?? "");
  const m = TS_RE.exec(v);
  if (!m) return NaN;
  let iso = v.replace(" ", "T");
  if (iso.includes("T") && !m[1]) iso += "Z";
  return Date.parse(iso);
}

function blankBucket() {
  return {
    receipts: 0,
    answered: 0,
    refused: 0,
    with_evidence: 0,
    missing_evidence: 0,
    multi_source_receipts: 0,
    // BigInt during aggregation; serialized as exact decimal strings.
    multi_source_votes_agreeing: 0n,
    multi_source_votes_cast: 0n,
    single_source_receipts: 0,
    quorum_strings_unparsed: 0,
  };
}

function serializeBucket(b) {
  return {
    receipts: b.receipts,
    answered: b.answered,
    refused: b.refused,
    with_evidence: b.with_evidence,
    missing_evidence: b.missing_evidence,
    multi_source_receipts: b.multi_source_receipts,
    multi_source_votes_agreeing: b.multi_source_votes_agreeing.toString(),
    multi_source_votes_cast: b.multi_source_votes_cast.toString(),
    single_source_receipts: b.single_source_receipts,
    quorum_strings_unparsed: b.quorum_strings_unparsed,
  };
}

/**
 * Pure aggregation over loadAccuracyRows() output. nowMs injectable for
 * tests. Window: rows whose parsed fetched_at is within the last `days`
 * days; grouping is by UTC calendar day of the parsed timestamp.
 */
export function computeAccuracyDoc(rows, { days, nowMs, source }) {
  const cutoffMs = nowMs - days * 86400_000;
  const totals = blankBucket();
  const byDay = new Map(); // utcDay -> { bucket, intents: Map }
  const unparsed = new Map(); // EXACT stored value (string | null) -> count
  let skippedBadTimestamp = 0;

  for (const row of rows) {
    const ts = parseFetchedAtMs(row.fetched_at);
    if (Number.isNaN(ts)) {
      skippedBadTimestamp++;
      continue;
    }
    if (ts < cutoffMs) continue; // outside the requested window
    const day = new Date(ts).toISOString().slice(0, 10);

    if (!byDay.has(day)) byDay.set(day, { bucket: blankBucket(), intents: new Map() });
    const dayEntry = byDay.get(day);
    const intent = String(row.intent ?? "");
    if (!dayEntry.intents.has(intent)) dayEntry.intents.set(intent, blankBucket());
    const buckets = [totals, dayEntry.bucket, dayEntry.intents.get(intent)];

    const hasEvidence = Number(row.has_evidence) === 1;
    const rawVotes = row.quorum_votes === undefined || row.quorum_votes === null ? null : String(row.quorum_votes);
    const m = rawVotes === null ? null : KN_RE.exec(rawVotes);

    // refusal receipts (optimalRoute): no source was queried, exact prefix only
    const refused = rawVotes !== null && rawVotes.startsWith(REFUSED_PREFIX);
    for (const b of buckets) {
      b.receipts++;
      if (refused) b.refused++;
      else b.answered++;
      if (hasEvidence) b.with_evidence++;
      else b.missing_evidence++;
      if (refused) continue;
      if (m) {
        if (BigInt(m[2]) >= 2n) {
          b.multi_source_receipts++;
          b.multi_source_votes_agreeing += BigInt(m[1]);
          b.multi_source_votes_cast += BigInt(m[2]);
        } else {
          b.single_source_receipts++;
        }
      } else {
        b.quorum_strings_unparsed++;
      }
    }
    if (!m && !refused) unparsed.set(rawVotes, (unparsed.get(rawVotes) ?? 0) + 1);
  }

  const daysSorted = [...byDay.keys()].sort();
  const daysOut = {};
  for (const day of daysSorted) {
    const { bucket, intents } = byDay.get(day);
    const intentsOut = {};
    for (const intent of [...intents.keys()].sort()) {
      intentsOut[intent] = serializeBucket(intents.get(intent));
    }
    daysOut[day] = { ...serializeBucket(bucket), intents: intentsOut };
  }

  return {
    generated_at: new Date(nowMs).toISOString(),
    producer: "scripts/accuracy.mjs",
    source,
    window: {
      days,
      cutoff: new Date(cutoffMs).toISOString(),
      from_day: daysSorted[0] ?? null,
      to_day: daysSorted[daysSorted.length - 1] ?? null,
    },
    totals: serializeBucket(totals),
    days: daysOut,
    unparsed_quorum_strings: [...unparsed.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([quorum_votes, count]) => ({ quorum_votes, count })),
    rows_skipped_bad_fetched_at: skippedBadTimestamp,
    notes:
      "Exact counts of receipts this service issued and stored. Days are the UTC " +
      "calendar day of the parsed fetched_at (offsets honored). answered + refused = " +
      "receipts; refused are refusal receipts whose stored quorum label is exactly of " +
      "the form 'no upstream quorum: ...' (no source was queried). with_evidence means " +
      "a stored blob, even a gzip of empty bytes. Quorum figures are a serve-time vote " +
      "tally, not a correctness rate: multi_source_* covers stored labels that begin " +
      "'k/n' with n >= 2, with votes agreeing/cast as exact decimal strings (BigInt); " +
      "single_source_receipts counts labels with n = 1, which attest one source and are " +
      "never summed with multi-source votes. Every other non-refusal value is counted " +
      "in quorum_strings_unparsed and listed verbatim in unparsed_quorum_strings (stored " +
      "NULL stays null, never merged with ''). No estimated, sampled, or invented " +
      "numbers, and no answer-correctness claim.",
  };
}

// --- CLI ---------------------------------------------------------------------
function fail(msg) {
  console.error(`accuracy.mjs: ${msg}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  let dbPath = null;
  let databaseUrl = null;
  let days = 30;
  let out = "accuracy.json";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db") dbPath = args[++i] ?? fail("--db needs a value");
    else if (a === "--database-url") databaseUrl = args[++i] ?? fail("--database-url needs a value");
    else if (a === "--days") days = Number(args[++i]);
    else if (a === "--out") out = args[++i] ?? fail("--out needs a value");
    else fail(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(days) || days < 1 || days > 366) fail("--days must be an integer 1..366");

  const sel = resolveAccuracyBackend({ dbPath, databaseUrl });
  let rows;
  try {
    rows = await loadAccuracyRows(sel);
  } catch (err) {
    fail(`cannot read ${sel.backend} store${sel.backend === "sqlite" ? ` at ${sel.dbPath}` : ""}: ${err.message}`);
  }
  const doc = computeAccuracyDoc(rows, {
    days,
    nowMs: Date.now(),
    source: { backend: sel.backend, table: "miner_receipts" },
  });
  const json = JSON.stringify(doc, null, 2) + "\n";
  if (out === "-") {
    process.stdout.write(json);
  } else {
    writeFileSync(out, json);
    console.error(
      `accuracy.mjs: wrote ${out} (${doc.totals.receipts} receipts, backend ${sel.backend})`,
    );
  }
}

const invokedAs = process.argv[1] ? new URL(import.meta.url).pathname : "";
if (process.argv[1] && invokedAs === new URL(`file://${process.argv[1]}`).pathname) {
  await main();
}
