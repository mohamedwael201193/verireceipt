// Tests for GET /accuracy.json (src/core/accuracy.ts, S2 2026-11-22).
//
// The route and scripts/accuracy.mjs are two implementations of one
// contract; the equality control below runs BOTH over the same seeded
// store and requires identical documents (minus generated_at/source
// flavor), so the two cannot drift apart unnoticed.
import { execFile } from "child_process";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join, resolve } from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gzipSync } from "zlib";
import Database from "better-sqlite3";

const SCRATCH = resolve(process.cwd(), "..", "accuracy-route-test-scratch");
mkdirSync(SCRATCH, { recursive: true });
const DIR = mkdtempSync(join(SCRATCH, "run-"));
const DB_PATH = join(DIR, "verireceipt.sqlite");
process.env.SQLITE_PATH = DB_PATH;
delete process.env.DATABASE_URL;
const SCRIPT = resolve(process.cwd(), "scripts/accuracy.mjs");

import { buildServer } from "../src/server";
import { __setStorageBackendForTests } from "../src/core/storage";
import { __resetAccuracyCacheForTests, computeAccuracyDoc } from "../src/core/accuracy";
__setStorageBackendForTests("sqlite");

const NOW = Date.now();

afterAll(() => rmSync(DIR, { recursive: true, force: true }));
beforeEach(() => __resetAccuracyCacheForTests());

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
  const blob = gzipSync(Buffer.from("x"));
  const rows: Array<[string, string, string, string, string, Buffer | null, number, string | null]> = [
    ["rcpt_AAAAAAAAAAAAAAAAAAAAAAAAAA", "TVL_LOOKUP_GENERAL", "u", "a".repeat(64), new Date(NOW - 1000).toISOString(), blob, 1, "1/1 primary source"],
    ["rcpt_BBBBBBBBBBBBBBBBBBBBBBBBBB", "ONCHAIN_TX_LOOKUP_GENERAL", "u", "b".repeat(64), new Date(NOW - 2000).toISOString(), blob, 1, "9007199254740993/9007199254740993"],
    ["rcpt_CCCCCCCCCCCCCCCCCCCCCCCCCC", "ONCHAIN_TX_LOOKUP_GENERAL", "u", "c".repeat(64), new Date(NOW - 3000).toISOString(), null, 0, null],
    ["rcpt_DDDDDDDDDDDDDDDDDDDDDDDDDD", "OFFSET", "u", "d".repeat(64), "2026-11-22T00:15:00+03:00", blob, 1, ""],
  ];
  for (const r of rows) ins.run(...r);
  db.close();
}

function runCli(): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [SCRIPT, "--db", DB_PATH, "--days", "366", "--out", "-"],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr))) : resolvePromise(JSON.parse(stdout))),
    );
  });
}

describe("GET /accuracy.json", () => {
  it("serves the exact accuracy document and matches the CLI producer over the same store", async () => {
    seed();
    const app = buildServer();
    try {
      const res = await app.inject("/accuracy.json?days=366");
      expect(res.statusCode).toBe(200);
      const doc = res.json();
      expect(doc.source.backend).toBe("sqlite");
      expect(doc.totals).toEqual({
        receipts: 4,
        answered: 4,
        refused: 0,
        with_evidence: 3,
        missing_evidence: 1,
        multi_source_receipts: 1,
        multi_source_votes_agreeing: "9007199254740993",
        multi_source_votes_cast: "9007199254740993",
        single_source_receipts: 1,
        quorum_strings_unparsed: 2,
      });
      // UTC day of the offset timestamp is Nov 21, not Nov 22 (the other
      // seed rows use the current instant, so Nov 22 legitimately exists).
      expect(Object.keys(doc.days["2026-11-21"].intents)).toEqual(["OFFSET"]);
      // NULL and "" stay distinct in the verbatim unparsed list.
      expect(doc.unparsed_quorum_strings).toEqual(
        expect.arrayContaining([
          { quorum_votes: null, count: 1 },
          { quorum_votes: "", count: 1 },
        ]),
      );

      // Cross-implementation equality: route vs CLI, same store.
      const cli = await runCli();
      const strip = (d: Record<string, unknown>) => {
        const { generated_at, producer, source, window, ...rest } = d as Record<string, unknown>;
        // window.cutoff is derived from each side's own "now" (ms apart);
        // the day-granularity fields must match exactly.
        const { cutoff, ...windowRest } = window as Record<string, unknown>;
        return { ...rest, window: windowRest };
      };
      expect(strip(doc)).toEqual(strip(cli));
    } finally {
      await app.close();
    }
  });

  it("rejects a bogus days parameter with 400 INVALID_DAYS", async () => {
    const app = buildServer();
    try {
      for (const bad of ["0", "367", "1.5", "abc"]) {
        const res = await app.inject(`/accuracy.json?days=${bad}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("INVALID_DAYS");
      }
    } finally {
      await app.close();
    }
  });

  it("answers 502 ACCURACY_UNAVAILABLE when the store is missing — never an empty document", async () => {
    const saved = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = join(DIR, "missing.sqlite");
    __resetAccuracyCacheForTests();
    const app = buildServer();
    try {
      const res = await app.inject("/accuracy.json");
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe("ACCURACY_UNAVAILABLE");
      // generic body: no store path / driver detail leaks publicly
      expect(res.body).not.toContain("missing.sqlite");
      expect(res.body).not.toContain(DIR);
    } finally {
      process.env.SQLITE_PATH = saved;
      await app.close();
    }
  });

  it("computeAccuracyDoc reads zone-less timestamps as UTC under a non-UTC process timezone", () => {
    const savedTz = process.env.TZ;
    try {
      for (const tz of ["Africa/Cairo", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = tz;
        const doc = computeAccuracyDoc(
          [{ fetched_at: "2026-11-22 00:15:00", intent: "Z", quorum_votes: "1/1", has_evidence: 1 }],
          { days: 366, nowMs: Date.parse("2026-11-22T12:00:00Z"), source: {} },
        ) as { days: Record<string, unknown> };
        expect(Object.keys(doc.days)).toEqual(["2026-11-22"]);
      }
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  it("cache is not reused across a UTC day change", async () => {
    const app = buildServer();
    const realNow = Date.now;
    try {
      Date.now = () => Date.parse("2026-11-22T23:59:30Z");
      __resetAccuracyCacheForTests();
      const a = await app.inject("/accuracy.json?days=366");
      Date.now = () => Date.parse("2026-11-23T00:00:10Z");
      const b = await app.inject("/accuracy.json?days=366");
      expect(a.json().generated_at).not.toBe(b.json().generated_at);
    } finally {
      Date.now = realNow;
      await app.close();
    }
  });
});
