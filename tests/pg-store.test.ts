// PG-MIGRATE (2026-11-21): storage contract, asserted IDENTICALLY on both
// backends (SQLite file and Postgres), plus the SQLite -> Postgres
// migration tool. The Postgres half needs DATABASE_URL (the suite's
// per-file schema comes from tests/helpers/pgSchemaSetup.ts); without it
// those cases are skipped and say so.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync } from "fs";
import { createServer, connect, type Socket } from "net";
import { join, resolve } from "path";
import { randomBytes } from "crypto";
import { gzipSync } from "zlib";
import Database from "better-sqlite3";

const SCRATCH = resolve(process.cwd(), "..", "tmp", "pg-store-test");
mkdirSync(SCRATCH, { recursive: true });
process.env.SQLITE_PATH = join(mkdtempSync(join(SCRATCH, "db-")), "verireceipt.sqlite");
process.env.SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? "verireceipt-test test@example.invalid";

import * as store from "../src/core/storage";
import { getDb, MAX_EVIDENCE_TOTAL_BYTES, selectGridEvictions, saveReceipt as saveReceiptSqlite } from "../src/core/db";
import { closePg, pgQueryForTests } from "../src/core/pgStore";
import { makeReceipt, sha256Hex, type Receipt } from "../src/core/receipt";
import { writeGridPriceBatch, type GridPriceRow } from "../src/jobs/gridIngester";
import { buildServer } from "../src/server";
import { migrate, SEQ_OFFSET } from "../src/tools/migrateSqliteToPg";

const HAS_PG = !!(process.env.DATABASE_URL ?? "").trim();
const PG_URL = process.env.DATABASE_URL ?? "";
const BACKENDS: store.StorageBackend[] = HAS_PG ? ["sqlite", "postgres"] : ["sqlite"];
if (!HAS_PG) console.warn("pg-store.test: DATABASE_URL not set — Postgres cases SKIPPED");

async function raw(backend: store.StorageBackend, sqliteSql: string, pgSql: string, params: unknown[]) {
  if (backend === "sqlite") return getDb().prepare(sqliteSql).run(...(params as never[]));
  return pgQueryForTests(pgSql, params);
}

function receiptFor(body: Buffer | string, fetchedAt?: string): Receipt {
  const r = makeReceipt("TX_LOOKUP_GENERAL", "https://example.invalid/rpc", body, "2/2 sources agreed");
  if (fetchedAt) r.fetched_at = fetchedAt;
  return r;
}

afterAll(async () => {
  store.__setStorageBackendForTests(null);
  await store.closeStorage();
});

describe.each(BACKENDS)("storage contract on %s", (backend) => {
  beforeAll(() => store.__setStorageBackendForTests(backend));

  it("stores evidence bytes EXACTLY (binary, non-UTF-8) and serves the same sha", async () => {
    store.__setStorageBackendForTests(backend);
    const body = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80]), randomBytes(4096)]);
    const pageBody = Buffer.from("page \u00e9 \u{1F600} bytes", "utf8");
    const r = receiptFor(body);
    await store.saveReceipt(r, body, [{ url: "https://example.invalid/p0", body: pageBody }]);
    const ev = await store.getReceiptEvidence(r.receipt_id);
    expect(ev.found).toBe(true);
    expect(Buffer.compare(ev.evidence as Buffer, body)).toBe(0);
    expect(ev.sha256).toBe(sha256Hex(body));
    expect(ev.evidenceBytes).toBe(body.length);
    const meta = await store.getReceiptMeta(r.receipt_id);
    expect(meta).toEqual({
      receipt_id: r.receipt_id,
      intent: r.intent,
      upstream_url: r.upstream_url,
      raw_response_sha256: r.raw_response_sha256,
      fetched_at: r.fetched_at,
      quorum_votes: "2/2 sources agreed",
      evidence_available: true,
      evidence_bytes: body.length,
    });
    expect(await store.getReceiptPages(r.receipt_id)).toEqual([
      {
        page_index: 0,
        url: "https://example.invalid/p0",
        raw_response_sha256: sha256Hex(pageBody),
        evidence_available: true,
        evidence_bytes: pageBody.length,
      },
    ]);
    const pe = await store.getReceiptPageEvidence(r.receipt_id, 0);
    expect(Buffer.compare(pe.evidence as Buffer, pageBody)).toBe(0);
    const blob = await store.getEvidenceBlob(r.receipt_id, null);
    expect(blob?.sha256).toBe(r.raw_response_sha256);
    expect(Buffer.compare(blob?.gzip as Buffer, gzipSync(body))).toBe(0);
    expect(await store.getReceiptMeta("rcpt_DOESNOTEXIST00000000000000")).toBeNull();
    expect((await store.getReceiptEvidence("rcpt_DOESNOTEXIST00000000000000")).found).toBe(false);
  });

  it("receipts are immutable: a colliding id never rewrites the row or gains pages", async () => {
    store.__setStorageBackendForTests(backend);
    const a = Buffer.from("first answer");
    const r = receiptFor(a);
    await store.saveReceipt(r, a);
    const b = Buffer.from("second, different answer");
    const r2: Receipt = { ...r, raw_response_sha256: sha256Hex(b), upstream_url: "https://evil.invalid" };
    await store.saveReceipt(r2, b, [{ url: "https://evil.invalid/p", body: "x" }]);
    const ev = await store.getReceiptEvidence(r.receipt_id);
    expect(ev.evidence?.toString()).toBe("first answer");
    expect((await store.getReceiptMeta(r.receipt_id))?.upstream_url).toBe("https://example.invalid/rpc");
    expect(await store.getReceiptPages(r.receipt_id)).toEqual([]);
  });

  it("refuses evidence that does not hash to the receipt, writing nothing", async () => {
    store.__setStorageBackendForTests(backend);
    const r = receiptFor("real");
    await expect(store.saveReceipt(r, "tampered")).rejects.toThrow(/do not hash to raw_response_sha256/);
    await expect(
      store.saveReceipt(r, "real", [{ url: "u", body: "p", raw_response_sha256: "00".repeat(32) }]),
    ).rejects.toThrow(/upstream page 0 bytes do not hash/);
    expect(await store.getReceiptMeta(r.receipt_id)).toBeNull();
  });

  it("a corrupt stored blob fails closed: getter throws, /raw is 500 EVIDENCE_CORRUPT, meta says corrupt", async () => {
    store.__setStorageBackendForTests(backend);
    const body = Buffer.from("will be corrupted");
    const r = receiptFor(body);
    await store.saveReceipt(r, body);
    const bad = gzipSync(Buffer.from("will be CORRUPTED"));
    await raw(
      backend,
      "UPDATE miner_receipts SET evidence_gzip = ? WHERE receipt_id = ?",
      "UPDATE miner_receipts SET evidence_gzip = $1 WHERE receipt_id = $2",
      [bad, r.receipt_id],
    );
    await expect(store.getReceiptEvidence(r.receipt_id)).rejects.toThrow(/corrupt evidence blob/);
    const app = buildServer();
    try {
      const rawRes = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/raw` });
      expect(rawRes.statusCode).toBe(500);
      expect(rawRes.json().code).toBe("EVIDENCE_CORRUPT");
      const metaRes = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}` });
      expect(metaRes.statusCode).toBe(200);
      expect(metaRes.json()).toMatchObject({ evidence_available: false, evidence_status: "corrupt", evidence_bytes: 0 });
    } finally {
      await app.close();
    }
  });

  it("HTTP: /receipts/:id and /raw serve the stored bytes; re-hash equals raw_response_sha256", async () => {
    store.__setStorageBackendForTests(backend);
    const body = Buffer.from(JSON.stringify({ hello: "world", n: 1 }));
    const r = receiptFor(body);
    await store.saveReceipt(r, body);
    const app = buildServer();
    try {
      const m = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}` });
      expect(m.statusCode).toBe(200);
      expect(m.json().raw_response_sha256).toBe(r.raw_response_sha256);
      expect(m.json().evidence_available).toBe(true);
      const x = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/raw` });
      expect(x.statusCode).toBe(200);
      expect(sha256Hex(x.rawPayload)).toBe(r.raw_response_sha256);
      const h = await app.inject({ method: "GET", url: "/health" });
      expect(h.statusCode).toBe(200);
      expect(h.json().storage.backend).toBe(backend);
    } finally {
      await app.close();
    }
  });

  it("evidence budget prunes the OLDEST blob first, insertion order breaking fetched_at ties; metadata stays", async () => {
    store.__setStorageBackendForTests(backend);
    const T = "2026-01-01T00:00:00.000Z";
    const size = Math.floor(MAX_EVIDENCE_TOTAL_BYTES / 2.5); // 3 blobs > budget, 2 fit
    const bodies = [randomBytes(size), randomBytes(size), randomBytes(size)]; // incompressible
    const rs = bodies.map((b) => receiptFor(b, T));
    store.__resetPruneEstimateForTests(); // r3: measure, do not trust an estimate from earlier cases
    for (let i = 0; i < 3; i++) await store.saveReceipt(rs[i], bodies[i]);
    // r3: on Postgres the prune runs after the save (not under the write
    // deadline); wait for it. No-op on SQLite (prune is inside the save).
    await store.settleStoragePrunes();
    const metas = await Promise.all(rs.map((r) => store.getReceiptMeta(r.receipt_id)));
    expect(metas.map((m) => m?.evidence_available)).toEqual([false, true, true]);
    expect(metas.every((m) => m !== null)).toBe(true);
    // clean up the big blobs so later cases are unaffected
    for (const r of rs) {
      await raw(
        backend,
        "UPDATE miner_receipts SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = ?",
        "UPDATE miner_receipts SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = $1",
        [r.receipt_id],
      );
    }
  }, 60_000);

  it("grid: float values round-trip exactly; revalidation success/attempt semantics", async () => {
    store.__setStorageBackendForTests(backend);
    const vals = [0.1 + 0.2, 36.79695, -12.5, 1e-300, 123456789.123456789, 0];
    const at = "2026-11-21T10:00:00.000Z";
    for (let i = 0; i < vals.length; i++) {
      const k = new Date(Date.UTC(2026, 10, 1, i)).toISOString();
      await store.saveGridPrice("ZONE_J", k, vals[i], "NYISO", at, "https://mis.nyiso.com/x.csv");
      const row = await store.getGridPrice("ZONE_J", k);
      expect(row).toEqual({ lmp_usd_per_mwh: vals[i], market: "NYISO", ingested_at: at, upstream_url: "https://mis.nyiso.com/x.csv" });
      expect(await store.getGridRevalidate("ZONE_J", k)).toEqual({ last_success_at: at, last_attempt_at: at });
    }
    const k0 = new Date(Date.UTC(2026, 10, 1, 0)).toISOString();
    await store.markGridRevalidateAttempt("ZONE_J", k0, "2026-11-21T11:00:00.000Z");
    expect(await store.getGridRevalidate("ZONE_J", k0)).toEqual({
      last_success_at: at,
      last_attempt_at: "2026-11-21T11:00:00.000Z",
    });
    await expect(store.saveGridPrice("", k0, 1, "NYISO")).rejects.toThrow(/refuses empty/);
    await expect(store.saveGridPrice("ZONE_J", k0, Infinity, "NYISO")).rejects.toThrow(/non-finite/);
    await expect(store.saveGridPrice("ZONE_J", "2026-11-01 00:00", 1, "NYISO")).rejects.toThrow(/interval_start/);
    expect(await store.getGridPrice("ZONE_J", "2026-01-01T00:00:00.000Z")).toBeNull();
  });

  it("grid batch: a duplicate key in one batch ends with the LAST row; a bad row stores nothing", async () => {
    store.__setStorageBackendForTests(backend);
    const k = "2026-11-02T05:00:00.000Z";
    const rows: GridPriceRow[] = [
      { node: "EE", intervalStart: k, lmp: 10, market: "Elering", ingestedAt: "2026-11-21T00:00:00.000Z", upstreamUrl: "u1" },
      { node: "FI", intervalStart: k, lmp: 11, market: "Elering", ingestedAt: "2026-11-21T00:00:00.000Z", upstreamUrl: "u1" },
      { node: "EE", intervalStart: k, lmp: 12.25, market: "Elering", ingestedAt: "2026-11-21T00:00:01.000Z", upstreamUrl: "u2" },
    ];
    await writeGridPriceBatch(rows);
    expect(await store.getGridPrice("EE", k)).toEqual({ lmp_usd_per_mwh: 12.25, market: "Elering", ingested_at: "2026-11-21T00:00:01.000Z", upstream_url: "u2" });
    expect((await store.getGridRevalidate("EE", k))?.last_success_at).toBe("2026-11-21T00:00:01.000Z");
    const k2 = "2026-11-02T06:00:00.000Z";
    await expect(
      writeGridPriceBatch([
        { node: "LV", intervalStart: k2, lmp: 1, market: "Elering", ingestedAt: "x", upstreamUrl: "u" },
        { node: "LT", intervalStart: k2, lmp: NaN, market: "Elering", ingestedAt: "x", upstreamUrl: "u" },
      ]),
    ).rejects.toThrow(/refuses row 1/);
    expect(await store.getGridPrice("LV", k2)).toBeNull();
  });

  it("NUL (U+0000) in any stored text field is refused identically on both stores (r2, J2 m3)", async () => {
    store.__setStorageBackendForTests(backend);
    const body = Buffer.from("nul-test " + randomBytes(8).toString("hex"));
    const r = receiptFor(body);
    const bad = { ...r, upstream_url: "https://example.invalid/a\u0000b" };
    await expect(store.saveReceipt(bad, body)).rejects.toThrow(/NUL/);
    expect(await store.getReceiptMeta(r.receipt_id)).toBeNull();
    await expect(store.saveReceipt(r, body, [{ url: "https://x.invalid/\u0000", body: "p" }])).rejects.toThrow(/NUL/);
    expect(await store.getReceiptMeta(r.receipt_id)).toBeNull();
    await expect(store.saveGridPrice("NODE\u0000X", "2026-01-01T00:00:00Z", 1, "DAM")).rejects.toThrow(/NUL/);
    await expect(
      writeGridPriceBatch([
        { node: "N1", intervalStart: "2026-01-01T00:00:00Z", lmp: 1, market: "DA\u0000M", ingestedAt: new Date().toISOString(), upstreamUrl: "u" } as GridPriceRow,
      ]),
    ).rejects.toThrow(/NUL/);
    // Reads with a NUL key are a clean miss on both (never a 500).
    expect(await store.getReceiptMeta("vr_\u0000")).toBeNull();
    expect((await store.getReceiptEvidence("vr_\u0000")).found).toBe(false);
    expect(await store.getGridPrice("N\u0000", "2026-01-01T00:00:00Z")).toBeNull();
    // A clean save of the same receipt still works afterwards.
    await store.saveReceipt(r, body);
    expect((await store.getReceiptMeta(r.receipt_id))?.evidence_available).toBe(true);
  });

  it("grid purge evicts exactly the keys selectGridEvictions picks (same function, both backends)", async () => {
    store.__setStorageBackendForTests(backend);
    const nowMs = Date.parse("2026-11-21T12:00:00.000Z");
    const all = [];
    for (let d = 0; d < 40; d++) {
      const k = new Date(Date.UTC(2026, 6, 1, d)).toISOString();
      all.push({ node_or_zone: "PURGE_Z", interval_start: k, market: "NYISO" });
      await store.saveGridPrice("PURGE_Z", k, d, "NYISO", "2026-11-21T00:00:00.000Z", "u");
    }
    const totalBefore = Number(
      backend === "sqlite"
        ? (getDb().prepare("SELECT COUNT(*) AS n FROM grid_cache").get() as { n: number }).n
        : (await pgQueryForTests<{ n: string }>("SELECT COUNT(*) AS n FROM grid_cache"))[0].n,
    );
    const everything =
      backend === "sqlite"
        ? (getDb().prepare("SELECT node_or_zone, interval_start, market FROM grid_cache").all() as typeof all)
        : await pgQueryForTests<(typeof all)[number]>("SELECT node_or_zone, interval_start, market FROM grid_cache");
    const cap = totalBefore - 15;
    const expected = selectGridEvictions(everything, totalBefore, cap, nowMs);
    const deleted = await store.purgeGridCacheOverflow(cap, nowMs);
    expect(deleted).toBe(expected.length);
    expect(deleted).toBeGreaterThanOrEqual(15);
    for (const v of expected) expect(await store.getGridPrice(v.node_or_zone, v.interval_start)).toBeNull();
  });
});

describe.skipIf(!HAS_PG)("postgres specifics", () => {
  it("/health never awaits the database: a dead DB reports storage.ok=false and /health stays 200 and fast", async () => {
    store.__setStorageBackendForTests("postgres");
    expect((await store.pingStorageOnce()).ok).toBe(true);
    await closePg();
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://nobody:x@127.0.0.1:1/none";
    try {
      const h = await store.pingStorageOnce();
      expect(h.ok).toBe(false);
      expect(h.last_error ?? "").not.toContain("x@127");
      // r2 (J1 m3): a fixed code, never the driver message (host/port/user).
      expect(h.last_error).toBe("connection_refused");
      const app = buildServer();
      try {
        const t0 = Date.now();
        const res = await app.inject({ method: "GET", url: "/health" });
        expect(Date.now() - t0).toBeLessThan(500);
        expect(res.statusCode).toBe(200);
        expect(res.json().storage.ok).toBe(false);
      } finally {
        await app.close();
      }
    } finally {
      await closePg();
      process.env.DATABASE_URL = saved;
    }
    expect((await store.pingStorageOnce()).ok).toBe(true);
  });

  it("migration: copies every SQLite row byte-exactly, verifies, is idempotent, and detects tampering", async () => {
    // Source: the SQLite file this test file already wrote (contract cases
    // above) plus fresh receipts with pages and a tied fetched_at.
    store.__setStorageBackendForTests("sqlite");
    const T = "2025-06-01T00:00:00.000Z";
    const src: Array<{ r: Receipt; body: Buffer }> = [];
    for (let i = 0; i < 25; i++) {
      const body = randomBytes(200 + i);
      const r = receiptFor(body, T);
      saveReceiptSqlite(r, body, i % 5 === 0 ? [{ url: `https://example.invalid/p${i}`, body: `page ${i}` }] : []);
      src.push({ r, body });
    }
    const legacy = receiptFor("legacy-no-evidence");
    saveReceiptSqlite(legacy); // NULL evidence row
    const sqlitePath = process.env.SQLITE_PATH as string;
    const target = PG_URL;

    const s1 = await migrate({ sqlitePath, databaseUrl: target });
    expect(s1.mismatches).toEqual([]);
    expect(s1.ok).toBe(true);
    const ro = new Database(sqlitePath, { readonly: true });
    const n = (ro.prepare("SELECT COUNT(*) AS n FROM miner_receipts").get() as { n: number }).n;
    const np = (ro.prepare("SELECT COUNT(*) AS n FROM miner_receipt_pages").get() as { n: number }).n;
    const ng = (ro.prepare("SELECT COUNT(*) AS n FROM grid_cache").get() as { n: number }).n;
    ro.close();
    expect(s1.source.receipts).toBe(n);
    expect(s1.verified.receipts_identical).toBe(n);
    expect(s1.verified.pages_identical).toBe(np);
    expect(s1.source.grid).toBe(ng);
    expect(s1.verified.evidence_sha_ok).toBe(s1.verified.evidence_rows - s1.source_corrupt_evidence.length);

    // Served from Postgres, byte-exact, same sha.
    store.__setStorageBackendForTests("postgres");
    for (const { r, body } of src) {
      const ev = await store.getReceiptEvidence(r.receipt_id);
      expect(Buffer.compare(ev.evidence as Buffer, body)).toBe(0);
      expect(ev.sha256).toBe(r.raw_response_sha256);
    }
    expect((await store.getReceiptMeta(legacy.receipt_id))?.evidence_available).toBe(false);
    // Insertion order preserved below any live seq.
    const seqs = await pgQueryForTests<{ receipt_id: string; seq: string }>(
      "SELECT receipt_id, seq FROM miner_receipts WHERE receipt_id = ANY($1::text[])",
      [src.map((x) => x.r.receipt_id)],
    );
    const bySeq = new Map(seqs.map((x) => [x.receipt_id, Number(x.seq)]));
    for (let i = 1; i < src.length; i++) {
      expect(bySeq.get(src[i].r.receipt_id)!).toBeGreaterThan(bySeq.get(src[i - 1].r.receipt_id)!);
      expect(bySeq.get(src[i].r.receipt_id)!).toBeLessThan(0);
    }
    expect(SEQ_OFFSET).toBeGreaterThan(1e9);

    // Idempotent rerun: nothing new inserted, still ok.
    const s2 = await migrate({ sqlitePath, databaseUrl: target });
    expect(s2.inserted).toEqual({ receipts: 0, pages: 0, grid: 0, revalidate: 0 });
    expect(s2.ok).toBe(true);

    // Tamper one migrated blob in Postgres: verify-only must fail and name it.
    await pgQueryForTests("UPDATE miner_receipts SET evidence_gzip = $1 WHERE receipt_id = $2", [
      gzipSync(Buffer.from("not the bytes")),
      src[3].r.receipt_id,
    ]);
    const s3 = await migrate({ sqlitePath, databaseUrl: target, verifyOnly: true });
    expect(s3.ok).toBe(false);
    expect(s3.mismatches).toContain(`receipt ${src[3].r.receipt_id} differs in postgres`);
    // A rerun never overwrites an existing row (immutability), so it stays failed.
    const s4 = await migrate({ sqlitePath, databaseUrl: target });
    expect(s4.ok).toBe(false);
  }, 60_000);

  it("migration: a blob pruned on ONE side is reported as pruned, not a mismatch; chunked streaming gives the same verdict (r2, J1 M1/M3, J2 H1)", async () => {
    store.__setStorageBackendForTests("sqlite");
    // r3 (J2-r2 m1): the oldest fetched_at in the file, so pruning these
    // rows oldest-first is what the real budget prune would do.
    const T = "2000-01-01T00:00:00.000Z";
    const rows: Receipt[] = [];
    for (let i = 0; i < 12; i++) {
      const body = randomBytes(300 + i);
      const r = receiptFor(body, T);
      saveReceiptSqlite(r, body, [{ url: `https://example.invalid/q${i}`, body: `qpage ${i}` }]);
      rows.push(r);
    }
    const sqlitePath = process.env.SQLITE_PATH as string;
    // Start from an empty target (the previous case left a tampered row).
    await pgQueryForTests("DELETE FROM miner_receipt_pages", []);
    await pgQueryForTests("DELETE FROM miner_receipts", []);
    const base = await migrate({ sqlitePath, databaseUrl: PG_URL });
    expect(base.mismatches).toEqual([]);
    expect(base.ok).toBe(true);

    // Both stores prune oldest-first, receipt + pages together, so the
    // pruned sets are prefixes of the same order: one side is ahead.
    const pruneSqlite = (r: Receipt) => {
      const rw = new Database(sqlitePath);
      rw.prepare("UPDATE miner_receipts SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = ?").run(r.receipt_id);
      rw.prepare("UPDATE miner_receipt_pages SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = ?").run(r.receipt_id);
      rw.close();
    };
    const prunePg = async (r: Receipt) => {
      await pgQueryForTests("UPDATE miner_receipts SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = $1", [r.receipt_id]);
      await pgQueryForTests("UPDATE miner_receipt_pages SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = $1", [r.receipt_id]);
    };
    // SQLite ahead (the live SQLite app's budget ran after pass 1): rows 0-1
    // pruned there, row 0 also pruned by the Postgres app.
    pruneSqlite(rows[0]);
    pruneSqlite(rows[1]);
    await prunePg(rows[0]);
    for (const chunkRows of [undefined, 1, 5]) {
      const v = await migrate({ sqlitePath, databaseUrl: PG_URL, verifyOnly: true, chunkRows });
      expect(v.mismatches).toEqual([]);
      expect(v.prune_violations).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.evidence_pruned_source).toEqual({ receipts: 1, pages: 1 });
      expect(v.evidence_pruned_target).toEqual({ receipts: 0, pages: 0 });
      expect(v.verified.receipts_identical + 1).toBe(v.source.receipts);
    }
    // Postgres ahead: its budget pruned rows 0-3.
    for (const r of rows.slice(1, 4)) await prunePg(r);
    for (const chunkRows of [undefined, 1, 5]) {
      const v = await migrate({ sqlitePath, databaseUrl: PG_URL, verifyOnly: true, chunkRows });
      expect(v.mismatches).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.evidence_pruned_source).toEqual({ receipts: 0, pages: 0 });
      expect(v.evidence_pruned_target).toEqual({ receipts: 2, pages: 2 });
      expect(v.verified.receipts_identical + 2).toBe(v.source.receipts);
    }
    // A copy rerun is still ok (nothing rewritten, pruned stays pruned).
    const again = await migrate({ sqlitePath, databaseUrl: PG_URL, chunkRows: 4 });
    expect(again.inserted.receipts).toBe(0);
    expect(again.ok).toBe(true);

    // NOT pruning: a NULL blob with evidence_bytes != 0, or a metadata
    // change next to a NULL blob, is still a real mismatch (exit 1).
    await pgQueryForTests("UPDATE miner_receipts SET evidence_gzip = NULL WHERE receipt_id = $1", [rows[7].receipt_id]);
    await pgQueryForTests(
      "UPDATE miner_receipts SET evidence_gzip = NULL, evidence_bytes = 0, intent = 'X' WHERE receipt_id = $1",
      [rows[8].receipt_id],
    );
    const bad = await migrate({ sqlitePath, databaseUrl: PG_URL, verifyOnly: true, chunkRows: 3 });
    expect(bad.ok).toBe(false);
    expect(bad.mismatches).toEqual([
      `receipt ${rows[7].receipt_id} differs in postgres`,
      `receipt ${rows[8].receipt_id} differs in postgres`,
    ]);
  }, 60_000);

  it("migration: a NULLed blob that no real prune could produce fails verify (r3, J2-r2 m1: order + receipt/page coupling)", async () => {
    store.__setStorageBackendForTests("sqlite");
    const T = "1999-01-01T00:00:00.000Z"; // oldest in the file
    const rows: Receipt[] = [];
    for (let i = 0; i < 6; i++) {
      const body = randomBytes(300 + i);
      const r = receiptFor(body, T);
      saveReceiptSqlite(r, body, [{ url: `https://example.invalid/m${i}`, body: `mpage ${i}` }]);
      rows.push(r);
    }
    const sqlitePath = process.env.SQLITE_PATH as string;
    await pgQueryForTests("DELETE FROM miner_receipt_pages", []);
    await pgQueryForTests("DELETE FROM miner_receipts", []);
    const base = await migrate({ sqlitePath, databaseUrl: PG_URL });
    expect(base.ok).toBe(true);
    const nullMain = (id: string) =>
      pgQueryForTests("UPDATE miner_receipts SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = $1", [id]);
    const nullPages = (id: string) =>
      pgQueryForTests("UPDATE miner_receipt_pages SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = $1", [id]);

    // C2: a lone page nulled while its receipt keeps its main blob
    // (row 0 is the oldest, so only the coupling rule can catch it).
    await nullPages(rows[0].receipt_id);
    const c2 = await migrate({ sqlitePath, databaseUrl: PG_URL, verifyOnly: true });
    expect(c2.ok).toBe(false);
    expect(c2.prune_violations).toEqual([`postgres: page evidence of ${rows[0].receipt_id} pruned while its receipt blob is kept`]);
    // ...and a main blob nulled while its page keeps evidence.
    await pgQueryForTests(
      "UPDATE miner_receipt_pages t SET evidence_gzip = s.evidence_gzip, evidence_bytes = s.evidence_bytes FROM (SELECT $2::bytea AS evidence_gzip, $3::int AS evidence_bytes) s WHERE t.receipt_id = $1",
      [rows[0].receipt_id, ...(await (async () => {
        const ro = new Database(sqlitePath, { readonly: true });
        const pg0 = ro.prepare("SELECT evidence_gzip, evidence_bytes FROM miner_receipt_pages WHERE receipt_id = ?").get(rows[0].receipt_id) as { evidence_gzip: Buffer; evidence_bytes: number };
        ro.close();
        return [pg0.evidence_gzip, pg0.evidence_bytes];
      })())],
    );
    await nullMain(rows[0].receipt_id);
    const c2b = await migrate({ sqlitePath, databaseUrl: PG_URL, verifyOnly: true });
    expect(c2b.ok).toBe(false);
    expect(c2b.prune_violations).toEqual([`postgres: receipt ${rows[0].receipt_id} blob pruned while a page still holds evidence`]);
    // Completing it (pages too) is a real prune: accepted.
    await nullPages(rows[0].receipt_id);
    const ok0 = await migrate({ sqlitePath, databaseUrl: PG_URL, verifyOnly: true });
    expect(ok0.mismatches).toEqual([]);
    expect(ok0.ok).toBe(true);
    expect(ok0.evidence_pruned_target).toEqual({ receipts: 1, pages: 1 });

    // C1: the NEWEST row's blob + pages nulled while older rows keep evidence.
    await nullMain(rows[5].receipt_id);
    await nullPages(rows[5].receipt_id);
    const c1 = await migrate({ sqlitePath, databaseUrl: PG_URL, verifyOnly: true });
    expect(c1.ok).toBe(false);
    expect(c1.prune_violations).toEqual([`postgres: receipt ${rows[5].receipt_id} pruned while an older receipt still holds evidence (prune is oldest-first)`]);
    expect(c1.mismatches).toEqual(c1.prune_violations);

    // The real order (rows 1..4 next) is accepted again.
    for (const r of rows.slice(1, 5)) {
      await nullMain(r.receipt_id);
      await nullPages(r.receipt_id);
    }
    const okAll = await migrate({ sqlitePath, databaseUrl: PG_URL, verifyOnly: true });
    expect(okAll.mismatches).toEqual([]);
    expect(okAll.ok).toBe(true);
    expect(okAll.evidence_pruned_target).toEqual({ receipts: 6, pages: 6 });

    // Same rule on the SQLite side: a row nulled there while OLDER rows
    // (rows 0-5, still holding evidence in SQLite) were never pruned.
    store.__setStorageBackendForTests("sqlite");
    const lateBody = randomBytes(345);
    const late = receiptFor(lateBody, "1999-06-01T00:00:00.000Z");
    saveReceiptSqlite(late, lateBody, [{ url: "https://example.invalid/late", body: "late page" }]);
    expect((await migrate({ sqlitePath, databaseUrl: PG_URL })).ok).toBe(true);
    const rw = new Database(sqlitePath);
    rw.prepare("UPDATE miner_receipts SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = ?").run(late.receipt_id);
    rw.prepare("UPDATE miner_receipt_pages SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = ?").run(late.receipt_id);
    rw.close();
    const c3 = await migrate({ sqlitePath, databaseUrl: PG_URL, verifyOnly: true });
    expect(c3.ok).toBe(false);
    expect(c3.evidence_pruned_source).toEqual({ receipts: 1, pages: 1 });
    expect(c3.prune_violations).toEqual([`sqlite: receipt ${late.receipt_id} pruned while an older receipt still holds evidence (prune is oldest-first)`]);
  }, 60_000);

  it("a stalled database cannot hold a request: saveReceipt rejects at the write deadline, the stalled client is discarded, and the next save works (r2, J1 M2 / J2 m2)", async () => {
    store.__setStorageBackendForTests("postgres");
    const target = new URL(PG_URL);
    let stalled = false;
    const held: Socket[] = [];
    const proxy = createServer((cli) => {
      const up = connect(Number(target.port || 5432), target.hostname);
      held.push(cli, up);
      const pipe = (a: Socket, b: Socket) =>
        a.on("data", (d) => {
          if (!stalled) b.write(d); // blackhole: bytes are swallowed while stalled
        });
      pipe(cli, up);
      pipe(up, cli);
      const end = () => {
        cli.destroy();
        up.destroy();
      };
      cli.on("error", end).on("close", end);
      up.on("error", end).on("close", end);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const via = new URL(PG_URL);
    via.hostname = "127.0.0.1";
    via.port = String((proxy.address() as { port: number }).port);
    await closePg();
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = via.toString();
    try {
      const b1 = Buffer.from("warm " + randomBytes(6).toString("hex"));
      const r1 = receiptFor(b1);
      await store.saveReceipt(r1, b1);
      expect((await store.getReceiptMeta(r1.receipt_id))?.evidence_available).toBe(true);

      stalled = true;
      const b2 = Buffer.from("stalled " + randomBytes(6).toString("hex"));
      const r2 = receiptFor(b2);
      const t0 = Date.now();
      const err = await store.saveReceipt(r2, b2).then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
      const took = Date.now() - t0;
      expect(err?.code).toBe("STORAGE_TIMEOUT");
      expect(took).toBeGreaterThanOrEqual(store.STORAGE_WRITE_DEADLINE_MS - 50);
      expect(took).toBeLessThan(store.STORAGE_WRITE_DEADLINE_MS + 1_000);

      // Recovery: the stalled client hits its query timeout and is
      // DESTROYED (not returned to the pool); fresh saves succeed.
      stalled = false;
      await new Promise((r) => setTimeout(r, 7_000));
      const b3 = Buffer.from("after " + randomBytes(6).toString("hex"));
      const r3 = receiptFor(b3);
      const t1 = Date.now();
      await store.saveReceipt(r3, b3);
      expect(Date.now() - t1).toBeLessThan(store.STORAGE_WRITE_DEADLINE_MS);
      expect((await store.getReceiptMeta(r3.receipt_id))?.evidence_available).toBe(true);
    } finally {
      stalled = false;
      await closePg();
      process.env.DATABASE_URL = saved;
      for (const s of held) s.destroy();
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  }, 40_000);
});
