// GET /accuracy.json — in-process producer of the daily accuracy document
// (S2, 2026-11-22). Same contract as scripts/accuracy.mjs (the standalone
// CLI producer): exact counts over the stored miner_receipts table, UTC
// day grouping of parsed fetched_at, BigInt-exact k/n quorum sums as
// decimal strings, verbatim unparsed quorum strings (NULL distinct from
// ""), evidence = stored blob even when it is a gzip of empty bytes.
// tests/accuracy-route.test.ts pins this implementation and the CLI to
// identical output over the same seeded store, so the two cannot drift.
//
// Serving shape: computed on demand and cached 60 s, keyed by (days, UTC
// day of generation) so a report generated before midnight UTC is never
// served after it. No parameters beyond ?days=N (1..366, default 30).
// A store failure answers 502 ACCURACY_UNAVAILABLE, never an empty doc.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Client as PgClient } from "pg";
import Database from "better-sqlite3";
import { ApiError } from "./errors";

export const ACCURACY_SELECT_SQL =
  "SELECT fetched_at, intent, quorum_votes, " +
  "CASE WHEN evidence_gzip IS NOT NULL THEN 1 ELSE 0 END AS has_evidence " +
  "FROM miner_receipts";

const REFUSED_PREFIX = "no upstream quorum:";
const KN_RE = /^(\d+)\s*\/\s*(\d+)/;
const CACHE_MS = 60_000;

interface AccuracyRow {
  fetched_at: string;
  intent: string;
  quorum_votes: string | null;
  has_evidence: number;
}

interface Bucket {
  receipts: number;
  answered: number;
  refused: number;
  with_evidence: number;
  missing_evidence: number;
  multi_source_receipts: number;
  multi_source_votes_agreeing: bigint;
  multi_source_votes_cast: bigint;
  single_source_receipts: number;
  quorum_strings_unparsed: number;
}

const TS_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Same rule as scripts/accuracy.mjs parseFetchedAtMs: zone-less = UTC. */
export function parseFetchedAtMs(value: unknown): number {
  const v = String(value ?? "");
  const m = TS_RE.exec(v);
  if (!m) return NaN;
  let iso = v.replace(" ", "T");
  if (iso.includes("T") && !m[1]) iso += "Z";
  return Date.parse(iso);
}

function blankBucket(): Bucket {
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

function serializeBucket(b: Bucket): Record<string, unknown> {
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

export function computeAccuracyDoc(
  rows: AccuracyRow[],
  opts: { days: number; nowMs: number; source: Record<string, unknown> },
): Record<string, unknown> {
  const { days, nowMs } = opts;
  const cutoffMs = nowMs - days * 86400_000;
  const totals = blankBucket();
  const byDay = new Map<string, { bucket: Bucket; intents: Map<string, Bucket> }>();
  const unparsed = new Map<string | null, number>();
  let skippedBadTimestamp = 0;

  for (const row of rows) {
    const ts = parseFetchedAtMs(row.fetched_at);
    if (Number.isNaN(ts)) {
      skippedBadTimestamp++;
      continue;
    }
    if (ts < cutoffMs) continue;
    const day = new Date(ts).toISOString().slice(0, 10);

    if (!byDay.has(day)) byDay.set(day, { bucket: blankBucket(), intents: new Map() });
    const dayEntry = byDay.get(day)!;
    const intent = String(row.intent ?? "");
    if (!dayEntry.intents.has(intent)) dayEntry.intents.set(intent, blankBucket());
    const buckets = [totals, dayEntry.bucket, dayEntry.intents.get(intent)!];

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
  const daysOut: Record<string, unknown> = {};
  for (const day of daysSorted) {
    const { bucket, intents } = byDay.get(day)!;
    const intentsOut: Record<string, unknown> = {};
    for (const intent of [...intents.keys()].sort()) {
      intentsOut[intent] = serializeBucket(intents.get(intent)!);
    }
    daysOut[day] = { ...serializeBucket(bucket), intents: intentsOut };
  }

  return {
    generated_at: new Date(nowMs).toISOString(),
    producer: "scripts/accuracy.mjs",
    source: opts.source,
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

async function loadRows(): Promise<{ backend: string; rows: AccuracyRow[] }> {
  if (process.env.DATABASE_URL) {
    const client = new PgClient({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000, query_timeout: 10_000, statement_timeout: 10_000 });
    await client.connect();
    try {
      const res = await client.query(ACCURACY_SELECT_SQL);
      return { backend: "postgres", rows: res.rows as AccuracyRow[] };
    } finally {
      await client.end();
    }
  }
  const dbPath = process.env.SQLITE_PATH || "data/verireceipt.sqlite";
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return { backend: "sqlite", rows: db.prepare(ACCURACY_SELECT_SQL).all() as AccuracyRow[] };
  } finally {
    db.close();
  }
}

let cache: { days: number; utcDay: string; at: number; doc: Record<string, unknown> } | null = null;

/** Test hook: drop the 60 s document cache. */
export function __resetAccuracyCacheForTests(): void {
  cache = null;
}

export function registerAccuracyRoute(app: FastifyInstance): void {
  app.get("/accuracy.json", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawDays = (request.query as { days?: unknown } | undefined)?.days;
    let days = 30;
    if (rawDays !== undefined) {
      days = Number(rawDays);
      if (!Number.isInteger(days) || days < 1 || days > 366) {
        throw new ApiError(400, "INVALID_DAYS", "days must be an integer 1..366");
      }
    }
    const now = Date.now();
    const utcDay = new Date(now).toISOString().slice(0, 10);
    if (cache && cache.days === days && cache.utcDay === utcDay && now - cache.at < CACHE_MS) {
      return reply
        .header("cache-control", "public, max-age=60")
        .header("access-control-allow-origin", "*")
        .send(cache.doc);
    }
    let loaded: { backend: string; rows: AccuracyRow[] };
    try {
      loaded = await loadRows();
    } catch (err) {
      // Detail stays server-side (redacted of anything URL-like); the
      // public body is generic.
      const detail = String((err as Error)?.message ?? err).replace(/\S*:\/\/\S*/g, "[redacted-url]").slice(0, 200);
      console.error(`verireceipt: accuracy store read failed: ${detail}`);
      throw new ApiError(502, "ACCURACY_UNAVAILABLE", "accuracy store is temporarily unavailable");
    }
    const doc = computeAccuracyDoc(loaded.rows, {
      days,
      nowMs: now,
      source: { backend: loaded.backend, table: "miner_receipts", served_by: "GET /accuracy.json" },
    });
    cache = { days, utcDay, at: now, doc };
    return reply
      .header("cache-control", "public, max-age=60")
      .header("access-control-allow-origin", "*")
      .send(doc);
  });
}
