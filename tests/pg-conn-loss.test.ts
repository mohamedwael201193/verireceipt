// PG-MIGRATE r3 (J1-r2 H1): losing a Postgres connection while a client is
// CHECKED OUT (write transaction, boot schema setup) must fail only that
// operation. Before r3 the pg Client emitted an unhandled 'error' event
// and Node exited 1 (J1: 20 parallel /v1/tx + pg_terminate_backend -> the
// server died, 19/20 requests got no response).
//
// In-process cases: a terminated backend mid-transaction / mid-schema-setup
// rejects that call, other concurrent saves succeed, the failed save left
// NO row (fails closed), and the next call works. vitest fails the file on
// any unhandled error, so "the process stays alive" is asserted too.
// Child-process case: a separate Node process (the built dist/ code) runs
// a save storm while backends are terminated repeatedly; it must exit 0.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, existsSync } from "fs";
import { join, resolve } from "path";
import { randomBytes } from "crypto";
import { execFileSync, spawnSync } from "child_process";
import { Client } from "pg";

const SCRATCH = resolve(process.cwd(), "..", "tmp", "pg-conn-loss-test");
mkdirSync(SCRATCH, { recursive: true });
process.env.SQLITE_PATH = join(mkdtempSync(join(SCRATCH, "db-")), "verireceipt.sqlite");

import * as store from "../src/core/storage";
import { __setPgTxPauseForTests, closePg, pgPoolConfig, pgQueryForTests } from "../src/core/pgStore";
import { MAX_EVIDENCE_TOTAL_BYTES } from "../src/core/db";
import { makeReceipt, type Receipt } from "../src/core/receipt";

const HAS_PG = !!(process.env.DATABASE_URL ?? "").trim();
const BASE = (process.env.VR_TEST_BASE_URL ?? process.env.DATABASE_URL ?? "").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const receipt = (tag: string): { r: Receipt; body: Buffer } => {
  const body = Buffer.from(`${tag} ${randomBytes(8).toString("hex")}`);
  return { r: makeReceipt("TX_LOOKUP_GENERAL", "https://example.invalid/rpc", body, "2/2"), body };
};

async function terminate(pids: number[]): Promise<number> {
  const c = new Client({ connectionString: BASE });
  c.on("error", () => undefined);
  await c.connect();
  try {
    const res = await c.query("SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(p) FROM unnest($1::int[]) AS p) t", [pids]);
    return res.rows[0].n as number;
  } finally {
    await c.end().catch(() => undefined);
  }
}

afterAll(async () => {
  __setPgTxPauseForTests(null);
  store.__setStorageBackendForTests(null);
  await store.closeStorage();
});

describe.skipIf(!HAS_PG)("postgres connection loss while a client is checked out (r3, J1-r2 H1)", () => {
  it("backend terminated mid-transaction: that save rejects and stores nothing; concurrent saves and the next save succeed; process alive", async () => {
    store.__setStorageBackendForTests("postgres");
    await store.initStorage();
    let victimPid = -1;
    __setPgTxPauseForTests(async (where, pid) => {
      if (where !== "tx" || victimPid !== -1) return;
      victimPid = pid;
      expect(await terminate([pid])).toBe(1);
      await sleep(300); // the socket closes -> Client emits 'error' while checked out
    });
    const victim = receipt("victim");
    const others = Array.from({ length: 6 }, (_, i) => receipt("other" + i));
    const victimSave = store.saveReceipt(victim.r, victim.body);
    await sleep(20);
    const otherSaves = others.map((o) => store.saveReceipt(o.r, o.body));
    await expect(victimSave).rejects.toThrow();
    await Promise.all(otherSaves);
    __setPgTxPauseForTests(null);
    expect(victimPid).toBeGreaterThan(0);
    // Fails closed: no partial row for the victim.
    expect(await store.getReceiptMeta(victim.r.receipt_id)).toBeNull();
    for (const o of others) expect((await store.getReceiptMeta(o.r.receipt_id))?.evidence_available).toBe(true);
    const next = receipt("next");
    await store.saveReceipt(next.r, next.body);
    expect((await store.getReceiptMeta(next.r.receipt_id))?.evidence_available).toBe(true);
    await store.settleStoragePrunes();
  }, 30_000);

  it("backend terminated during boot schema setup: initStorage rejects, the process stays up, the retry succeeds", async () => {
    store.__setStorageBackendForTests("postgres");
    await closePg(); // forget the memoised schema promise
    let hit = 0;
    __setPgTxPauseForTests(async (where, pid) => {
      if (where !== "schema" || hit++ > 0) return;
      expect(await terminate([pid])).toBe(1);
      await sleep(300);
    });
    await expect(store.initStorage()).rejects.toThrow();
    expect(hit).toBe(1);
    __setPgTxPauseForTests(null);
    await store.initStorage();
    const r = receipt("after-boot");
    await store.saveReceipt(r.r, r.body);
    expect((await store.getReceiptMeta(r.r.receipt_id))?.evidence_available).toBe(true);
  }, 30_000);

  it("save storm with repeated backend terminations: no crash, every save either commits whole or leaves no row, then recovery", async () => {
    store.__setStorageBackendForTests("postgres");
    await store.initStorage();
    const seen = new Set<number>();
    __setPgTxPauseForTests(async (_w, pid) => {
      seen.add(pid);
      await sleep(5 + Math.floor(Math.random() * 20)); // hold the transaction open so kills land mid-transaction
    });
    const items = Array.from({ length: 120 }, (_, i) => receipt("storm" + i));
    let stop = false;
    let killed = 0;
    const killer = (async () => {
      while (!stop) {
        await sleep(40);
        if (seen.size) killed += await terminate([...seen]);
      }
    })();
    const results = await Promise.allSettled(items.map((it) => store.saveReceipt(it.r, it.body)));
    stop = true;
    await killer;
    __setPgTxPauseForTests(null);
    await store.settleStoragePrunes();
    const failed = results.filter((x) => x.status === "rejected").length;
    // Every save is all-or-nothing: committed -> full row; rejected -> row absent OR fully committed (COMMIT reached the server before the reset).
    for (let i = 0; i < items.length; i++) {
      const meta = await store.getReceiptMeta(items[i].r.receipt_id);
      if (results[i].status === "fulfilled") expect(meta?.evidence_available).toBe(true);
      else if (meta) expect((await store.getReceiptEvidence(items[i].r.receipt_id)).sha256).toBe(items[i].r.raw_response_sha256);
    }
    const after = receipt("after-storm");
    await store.saveReceipt(after.r, after.body);
    expect((await store.getReceiptMeta(after.r.receipt_id))?.evidence_available).toBe(true);
    console.log(`pg-conn-loss storm: ${items.length} saves, ${failed} rejected, ${killed} backends terminated`);
    expect(killed).toBeGreaterThan(0);
    expect(failed).toBeGreaterThan(0); // terminations really hit open transactions
  }, 60_000);

  it("a separate Node process (built dist/) survives a terminate storm and exits 0", () => {
    execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { stdio: "ignore" });
    const dist = resolve(process.cwd(), "dist", "core", "storage.js");
    expect(existsSync(dist)).toBe(true);
    const script = `
      const { Client } = require("pg");
      const store = require(${JSON.stringify(dist)});
      const pgs = require(${JSON.stringify(resolve(process.cwd(), "dist", "core", "pgStore.js"))});
      const { makeReceipt } = require(${JSON.stringify(resolve(process.cwd(), "dist", "core", "receipt.js"))});
      const { randomBytes } = require("crypto");
      (async () => {
        await store.initStorage();
        const pids = new Set();
        pgs.__setPgTxPauseForTests(async (_w, pid) => { pids.add(pid); await new Promise(r => setTimeout(r, 5 + Math.floor(Math.random() * 20))); });
        let stop = false, killed = 0;
        const admin = new Client({ connectionString: process.env.VR_ADMIN_URL });
        admin.on("error", () => {});
        await admin.connect();
        const killer = (async () => { while (!stop) { await new Promise(r => setTimeout(r, 30));
          if (pids.size) killed += (await admin.query("SELECT count(*)::int n FROM (SELECT pg_terminate_backend(p) FROM unnest($1::int[]) p) t", [[...pids]])).rows[0].n; } })();
        let ok = 0, fail = 0;
        for (let w = 0; w < 6; w++) {
          const rs = await Promise.allSettled(Array.from({ length: 40 }, () => {
            const b = randomBytes(2048); return store.saveReceipt(makeReceipt("TX_LOOKUP_GENERAL", "https://e.invalid", b, "2/2"), b); }));
          for (const r of rs) r.status === "fulfilled" ? ok++ : fail++;
        }
        stop = true; await killer; await admin.end();
        pgs.__setPgTxPauseForTests(null);
        const b = randomBytes(64); await store.saveReceipt(makeReceipt("TX_LOOKUP_GENERAL", "https://e.invalid", b, "2/2"), b);
        console.log(JSON.stringify({ ok, fail, killed }));
        await store.closeStorage();
        process.exit(0);
      })().catch((e) => { console.error("SCRIPT_ERROR", e && e.message); process.exit(3); });
    `;
    const out = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, VR_ADMIN_URL: BASE },
      encoding: "utf8",
      timeout: 90_000,
    });
    if (out.status !== 0) console.error(out.stdout, out.stderr);
    else console.log("pg-conn-loss child:", out.stdout.trim().split("\n").pop());
    expect(out.stderr).not.toContain("Unhandled 'error' event");
    expect(out.status).toBe(0);
    const line = JSON.parse(out.stdout.trim().split("\n").pop() as string);
    expect(line.killed).toBeGreaterThan(0);
    expect(line.ok).toBeGreaterThan(0);
    expect(line.fail).toBeGreaterThan(0);
  }, 120_000);
});

// r3 (J2-r2 H1 / m3): the evidence prune must never delay or fail a save.
describe.skipIf(!HAS_PG)("prune can neither delay nor fail a save (r3, J2-r2 H1/m3)", () => {
  it("pool sessions carry idle_in_transaction_session_timeout = 15s", async () => {
    store.__setStorageBackendForTests("postgres");
    await store.initStorage();
    const [row] = await pgQueryForTests<{ v: string }>("SELECT current_setting('idle_in_transaction_session_timeout') AS v");
    expect(row.v).toBe("15s");
  });

  it("STALE prune-lock holder: saves resolve fast and committed (no STORAGE_TIMEOUT), reads unaffected, prune skipped then resumes", async () => {
    store.__setStorageBackendForTests("postgres");
    await store.initStorage();
    const holder = new Client({ connectionString: process.env.DATABASE_URL }); // no idle-in-tx timeout: holds forever
    holder.on("error", () => undefined);
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(774922, hashtext(current_schema()))"); // the prune lock, same schema as the store
    try {
      store.__resetPruneEstimateForTests();
      const busy0 = store.pruneStats.skippedBusy;
      const seed = receipt("seed");
      await store.saveReceipt(seed.r, seed.body);
      const items = Array.from({ length: 10 }, (_, i) => receipt("stale" + i));
      const t0 = Date.now();
      const saves = items.map((it) => {
        const t = Date.now();
        return store.saveReceipt(it.r, it.body).then(() => Date.now() - t);
      });
      const reads = Array.from({ length: 10 }, () => {
        const t = Date.now();
        return store.getReceiptMeta(seed.r.receipt_id).then((m) => (m ? Date.now() - t : -1));
      });
      const saveMs = await Promise.all(saves); // any STORAGE_TIMEOUT rejects here
      const readMs = await Promise.all(reads);
      expect(Math.max(...saveMs)).toBeLessThan(1_000);
      expect(Math.min(...readMs)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...readMs)).toBeLessThan(1_000);
      for (const it of items) expect((await store.getReceiptMeta(it.r.receipt_id))?.evidence_available).toBe(true);
      // Sequential saves while the lock is still held: each fast.
      for (let i = 0; i < 4; i++) {
        const it = receipt("stale-seq" + i);
        const t = Date.now();
        await store.saveReceipt(it.r, it.body);
        expect(Date.now() - t).toBeLessThan(1_000);
      }
      await store.settleStoragePrunes();
      expect(store.pruneStats.skippedBusy).toBeGreaterThan(busy0);
      console.log(`stale-lock: saves max ${Math.max(...saveMs)} ms, reads max ${Math.max(...readMs)} ms, wall ${Date.now() - t0} ms`);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
    const ran0 = store.pruneStats.ran;
    store.__resetPruneEstimateForTests();
    const after = receipt("after-unlock");
    await store.saveReceipt(after.r, after.body);
    await store.settleStoragePrunes();
    expect(store.pruneStats.ran).toBe(ran0 + 1);
  }, 30_000);

  it("a session with the app's pool config left idle in a transaction holding an advisory lock is ended by the server after 15 s", async () => {
    const c = new Client(pgPoolConfig(process.env.DATABASE_URL as string));
    c.on("error", () => undefined);
    await c.connect();
    const [{ pid }] = (await c.query("SELECT pg_backend_pid() AS pid")).rows;
    await c.query("BEGIN");
    // A different key than the prune lock (774922) so parallel test files are not starved for 16 s;
    // the server-side timeout ends the session whatever lock it holds.
    await c.query("SELECT pg_advisory_xact_lock(774999)");
    const held = async () =>
      (await pgQueryForTests<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 774999 AND granted AND pid = $1",
        [pid],
      ))[0].n;
    expect(await held()).toBe(1);
    await sleep(16_500);
    expect(await held()).toBe(0);
    await c.end().catch(() => undefined);
  }, 30_000);

  it("20k rows at the evidence budget + 100 concurrent saves: none rejected, latency well under the deadline, budget restored by the background prune", async () => {
    store.__setStorageBackendForTests("postgres");
    await store.initStorage();
    // Seed 20,000 receipts with 2,600 B of (opaque) evidence each = ~49.6 MiB, just under the 50 MiB cap.
    await pgQueryForTests(
      `INSERT INTO miner_receipts (receipt_id, intent, upstream_url, raw_response_sha256, fetched_at, evidence_gzip, evidence_bytes, quorum_votes)
       SELECT 'seed' || g, 'TX_LOOKUP_GENERAL', 'https://x', repeat('a', 64),
              to_char(timestamp '2025-01-01' + g * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              (SELECT string_agg(decode(md5(g::text || k::text), 'hex'), ''::bytea) FROM generate_series(1, 2600 / 16) k),
              2600, '2/2'
       FROM generate_series(1, 20000) g`,
    );
    store.__resetPruneEstimateForTests();
    const items = Array.from({ length: 100 }, () => {
      const body = randomBytes(20_000);
      return { r: makeReceipt("TX_LOOKUP_GENERAL", "https://example.invalid/rpc", body, "2/2"), body };
    });
    const t0 = Date.now();
    const res = await Promise.allSettled(
      items.map((it) => {
        const t = Date.now();
        return store.saveReceipt(it.r, it.body).then(() => Date.now() - t);
      }),
    );
    const wall = Date.now() - t0;
    const rejected = res.filter((x) => x.status === "rejected");
    expect(rejected.map((x) => (x as PromiseRejectedResult).reason?.code ?? String((x as PromiseRejectedResult).reason))).toEqual([]);
    const ms = res.map((x) => (x as PromiseFulfilledResult<number>).value).sort((a, b) => a - b);
    const p50 = ms[49];
    const max = ms[99];
    expect(max).toBeLessThan(1_500);
    await store.settleStoragePrunes();
    const [tot] = await pgQueryForTests<{ total: string }>(
      `SELECT (SELECT COALESCE(SUM(octet_length(evidence_gzip)), 0) FROM miner_receipts)
            + (SELECT COALESCE(SUM(octet_length(evidence_gzip)), 0) FROM miner_receipt_pages) AS total`,
    );
    expect(Number(tot.total)).toBeLessThanOrEqual(MAX_EVIDENCE_TOTAL_BYTES);
    for (const it of items.slice(-5)) expect((await store.getReceiptMeta(it.r.receipt_id))?.evidence_available).toBe(true);
    console.log(`20k+100: p50 ${p50} ms, max ${max} ms, wall ${wall} ms, total after prune ${tot.total} B, stats ${JSON.stringify(store.pruneStats)}`);
  }, 120_000);
});
