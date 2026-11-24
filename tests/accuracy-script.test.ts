// Tests for scripts/accuracy.mjs (S2, 2026-11-22; r148 fixes).
//
// Builds a REAL sqlite store with the production miner_receipts DDL and
// known rows — including the reviewer's r148 boundary shapes (UTC-offset
// timestamps around the window edge, unsafe >2^53 quorum integers, a
// gzip of empty bytes, whitespace/NULL/empty quorum strings) — runs the
// script as a child process, and asserts exact, non-invented output.
import { execFile } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { afterAll, describe, expect, it } from "vitest";
import { gzipSync } from "zlib";
import Database from "better-sqlite3";

const SCRIPT = resolve(process.cwd(), "scripts/accuracy.mjs");
const SCRATCH = resolve(process.cwd(), "..", "accuracy-test-scratch");
mkdirSync(SCRATCH, { recursive: true });
const DIR = mkdtempSync(join(SCRATCH, "run-"));
const DB_PATH = join(DIR, "verireceipt.sqlite");
const OUT_PATH = join(DIR, "accuracy.json");

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const NOW = Date.now();

function seed(): void {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE miner_receipts (
      receipt_id TEXT PRIMARY KEY,
      intent TEXT NOT NULL,
      upstream_url TEXT NOT NULL,
      raw_response_sha256 TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      evidence_gzip BLOB,
      evidence_bytes INTEGER NOT NULL DEFAULT 0,
      quorum_votes TEXT
    );
  `);
  const ins = db.prepare(
    "INSERT INTO miner_receipts (receipt_id, intent, upstream_url, raw_response_sha256, fetched_at, evidence_gzip, evidence_bytes, quorum_votes) VALUES (?,?,?,?,?,?,?,?)",
  );
  const iso = (ms: number) => new Date(ms).toISOString();
  const blob = Buffer.from("x");
  const rows: Array<[string, string, string, string, string, Buffer | null, number, string | null]> = [
    ["rcpt_AAAAAAAAAAAAAAAAAAAAAAAAAA", "ONCHAIN_TX_LOOKUP_GENERAL", "u", "a".repeat(64), iso(NOW - 1000), blob, 1, "2/2 archive RPC legs agree"],
    ["rcpt_BBBBBBBBBBBBBBBBBBBBBBBBBB", "ONCHAIN_TX_LOOKUP_GENERAL", "u", "b".repeat(64), iso(NOW - 2000), blob, 1, "2/3 archive RPC legs agree"],
    // legacy row: no blob -> missing evidence; quorum string unparsed
    ["rcpt_CCCCCCCCCCCCCCCCCCCCCCCCCC", "ONCHAIN_TX_LOOKUP_GENERAL", "u", "c".repeat(64), iso(NOW - 3000), null, 0, "legacy row, no vote string"],
    // r148: unsafe integers must stay exact
    ["rcpt_DDDDDDDDDDDDDDDDDDDDDDDDDD", "UNSAFE", "u", "d".repeat(64), iso(NOW - 1000), blob, 1, "9007199254740993/9007199254740993"],
    // r148: gzip of EMPTY bytes still counts as stored evidence
    ["rcpt_EEEEEEEEEEEEEEEEEEEEEEEEEE", "EMPTY", "u", "e".repeat(64), iso(NOW - 1000), gzipSync(Buffer.alloc(0)), 0, "1/1"],
    // r148: UTC-offset timestamps around the 30-day window edge.
    // IN: cutoff+1h instant, written with a -03:00 offset.
    ["rcpt_FFFFFFFFFFFFFFFFFFFFFFFFFF", "BOUNDARY_IN", "u", "f".repeat(64), new Date(NOW - 30 * 86400_000 + 3600_000 - 3 * 3600_000).toISOString().replace("Z", "-03:00"), blob, 1, "1/1"],
    // OUT: cutoff-1h instant, written with a +03:00 offset.
    ["rcpt_GGGGGGGGGGGGGGGGGGGGGGGGGG", "BOUNDARY_OUT", "u", "g".repeat(64), new Date(NOW - 30 * 86400_000 - 3600_000 + 3 * 3600_000).toISOString().replace("Z", "+03:00"), blob, 1, "1/1"],
    // verbatim-retention: whitespace, NULL and empty stay three distinct entries
    ["rcpt_HHHHHHHHHHHHHHHHHHHHHHHHHH", "UNPARSED", "u", "h".repeat(64), iso(NOW - 1000), blob, 1, "  legacy value  "],
    ["rcpt_IIIIIIIIIIIIIIIIIIIIIIIIII", "UNPARSED", "u", "i".repeat(64), iso(NOW - 1000), blob, 1, null],
    ["rcpt_JJJJJJJJJJJJJJJJJJJJJJJJJJ", "UNPARSED", "u", "j".repeat(64), iso(NOW - 1000), blob, 1, ""],
    // refused-pair receipt (optimalRoute NO_ROUTE): counted as refused, not as unparsed
    ["rcpt_LLLLLLLLLLLLLLLLLLLLLLLLLL", "OPTIMAL_EXECUTION_ROUTE_GENERAL", "u", "l".repeat(64), iso(NOW - 1000), blob, 1, "no upstream quorum: no venue was queried for a refused pair"],
    // a bad timestamp is counted, never grouped
    ["rcpt_KKKKKKKKKKKKKKKKKKKKKKKKKK", "BADT", "u", "k".repeat(64), "not-a-timestamp", blob, 1, "1/1"],
  ];
  for (const r of rows) ins.run(...r);
  db.close();
}

function runScript(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: "", ...env } },
      (err, stdout, stderr) => {
        const status = err && typeof err.code === "number" ? err.code : err ? -1 : 0;
        resolvePromise({ status, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

describe("scripts/accuracy.mjs", () => {
  it("counts exactly the stored rows; BigInt sums stay exact; UTC-offset and boundary instants are honored", async () => {
    seed();
    const r = await runScript(["--db", DB_PATH, "--out", OUT_PATH]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(readFileSync(OUT_PATH, "utf8"));

    expect(doc.source).toEqual({ backend: "sqlite", table: "miner_receipts" });
    expect(doc.totals).toEqual({
      receipts: 10, // BOUNDARY_OUT is outside the window, BADT skipped
      answered: 9,
      refused: 1,
      with_evidence: 9,
      missing_evidence: 1,
      multi_source_receipts: 3, // 2/2, 2/3, unsafe k/n
      multi_source_votes_agreeing: (2n + 2n + 9007199254740993n).toString(),
      multi_source_votes_cast: (2n + 3n + 9007199254740993n).toString(),
      single_source_receipts: 2, // 1/1 (EMPTY), 1/1 (BOUNDARY_IN)
      quorum_strings_unparsed: 4, // legacy label, spaces, null, empty
    });
    // No cross-kind quorum sums anywhere in the document.
    expect(JSON.stringify(doc)).not.toContain("quorum_votes_agreeing");
    expect(JSON.stringify(doc)).not.toContain("quorum_votes_cast");
    expect(doc.notes).toContain("serve-time vote tally");
    expect(doc.notes).toContain("not a correctness rate");
    expect(doc.rows_skipped_bad_fetched_at).toBe(1);

    const intents = Object.values(doc.days as Record<string, { intents: Record<string, unknown> }>).flatMap((d) => Object.keys(d.intents));
    expect(intents).toContain("BOUNDARY_IN");
    expect(intents).not.toContain("BOUNDARY_OUT");
    expect(intents).not.toContain("BADT");

    // EMPTY: stored gzip of empty bytes counts as evidence.
    const today = new Date().toISOString().slice(0, 10);
    const allDays = doc.days as Record<string, { intents: Record<string, { with_evidence: number; receipts: number }> }>;
    const emptyBucket = Object.values(allDays).map((d) => d.intents.EMPTY).find(Boolean);
    expect(emptyBucket).toMatchObject({ receipts: 1, with_evidence: 1 });

    // Exact unsafe integers (would collapse to ...992 under Number).
    const unsafeBucket = Object.values(allDays).map((d) => d.intents.UNSAFE).find(Boolean) as unknown as Record<string, unknown>;
    expect(unsafeBucket.multi_source_votes_agreeing).toBe("9007199254740993");
    expect(unsafeBucket.multi_source_votes_cast).toBe("9007199254740993");

    // Verbatim retention: spaces kept, null distinct from "".
    expect(doc.unparsed_quorum_strings).toEqual(
      expect.arrayContaining([
        { quorum_votes: "legacy row, no vote string", count: 1 },
        { quorum_votes: "  legacy value  ", count: 1 },
        { quorum_votes: null, count: 1 },
        { quorum_votes: "", count: 1 },
      ]),
    );
    expect(doc.unparsed_quorum_strings).toHaveLength(4);
    void today;
  });

  it("explicit --db beats DATABASE_URL (r148)", async () => {
    const r = await runScript(["--db", DB_PATH, "--out", "-"], {
      DATABASE_URL: "postgresql://review@127.0.0.1:1/review",
    });
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.source.backend).toBe("sqlite");
    expect(doc.totals.receipts).toBe(10);
  });

  it("fails loudly (exit 1) when the store does not exist — never emits an empty-looking file", async () => {
    const missing = join(DIR, "does-not-exist.sqlite");
    const outMissing = join(DIR, "should-not-exist.json");
    const r = await runScript(["--db", missing, "--out", outMissing]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read sqlite store");
    expect(() => readFileSync(outMissing, "utf8")).toThrow();
  });

  it("rejects a bogus --days", async () => {
    const r = await runScript(["--db", DB_PATH, "--days", "0", "--out", "-"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--days");
  });

  it("zone-less legacy timestamps are UTC in any process timezone; explicit offsets honored (r148 tz)", async () => {
    const tzDb = join(DIR, "tz.sqlite");
    const db = new Database(tzDb);
    db.exec("CREATE TABLE miner_receipts (receipt_id TEXT PRIMARY KEY, intent TEXT, upstream_url TEXT, raw_response_sha256 TEXT, fetched_at TEXT, evidence_gzip BLOB, evidence_bytes INTEGER, quorum_votes TEXT)");
    const ins = db.prepare("INSERT INTO miner_receipts VALUES (?,?,?,?,?,?,?,?)");
    ins.run("a", "ZONELESS", "u", "x", "2026-11-20 00:15:00", Buffer.from("x"), 1, "1/1");
    ins.run("b", "OFFSET", "u", "x", "2026-11-22T00:15:00+03:00", Buffer.from("x"), 1, "1/1");
    db.close();
    for (const tz of ["UTC", "Africa/Cairo", "America/Los_Angeles"]) {
      const r = await runScript(["--db", tzDb, "--days", "366", "--out", "-"], { TZ: tz });
      expect(r.status).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(Object.keys(doc.days["2026-11-20"].intents)).toEqual(["ZONELESS"]);
      expect(Object.keys(doc.days["2026-11-21"].intents)).toEqual(["OFFSET"]);
    }
  });
});
