// Backup tests (vitest) — startup guard, snapshots, daily GitHub backup.
//
// All GitHub behaviour is verified with a STUBBED fetch, never a live call
// (a 401 against the real API would still be a network call we do not
// need). The token used here is a stub literal, never a real credential.
// The DB is a temp file; SQLITE_PATH is set before any getDb() call, so
// snapshots land in <tempdir>/backups.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { mkdtempSync } from "fs";
import Database from "better-sqlite3";

const tmpDir = mkdtempSync(join(tmpdir(), "backup-test-"));
const tmpDb = join(tmpDir, "test.sqlite");
process.env.SQLITE_PATH = tmpDb;

import {
  assertDiskReady,
  assertWalValid,
  getDb,
  isValidFetchedAt,
  MIN_DISK_FREE_MB,
  saveReceipt,
  validateWalBuffer,
} from "../src/core/db";
import {
  BACKUP_REPO_DEFAULT,
  DAILY_BACKUP_WINDOW_DAYS,
  dateStrForDaysAgo,
  exportReceiptsJsonl,
  exportReceiptsJsonlForDay,
  findAgedOutDays,
  JSONL_FIELDS,
  pruneSnapshots,
  pushDailyBackup,
  redactSecrets,
  snapshotDir,
  snapshotFileName,
  snapshotNow,
  startBackupJobs,
  yesterdayDateStr,
} from "../src/jobs/backup";
import type { Receipt } from "../src/core/receipt";

const STUB_TOKEN = "stub-token-for-tests-only";

function utcDayIso(daysAgo: number, hourUtc: number): string {
  const d = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

function seedReceipt(id: string, fetchedAt: string, intent = "ONCHAIN_TX"): void {
  const r: Receipt = {
    receipt_id: id,
    intent,
    upstream_url: "https://example.invalid/upstream/" + id,
    raw_response_sha256: "ab".repeat(32),
    quorum_votes: "2/3 sources agreed",
    fetched_at: fetchedAt,
    audit_url: "https://example.invalid/receipts/" + id,
  };
  saveReceipt(r);
}

interface StubCall {
  url: string;
  init: RequestInit | undefined;
}

/** Minimal stub fetch: responds with the given statuses in call order. */
function makeStubFetch(statuses: number[]): {
  calls: StubCall[];
  fetchImpl: typeof fetch;
} {
  const calls: StubCall[] = [];
  let n = 0;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { status: statuses[Math.min(n++, statuses.length - 1)] } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("startup guard (a)", () => {
  it("importing backup.ts starts no timers and creates no snapshot", () => {
    expect(existsSync(snapshotDir())).toBe(false);
  });

  it("getDb succeeds on a temp path and logs a line containing the path", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const db = getDb();
      expect(db).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    const line = logs.find((l) => l.includes(tmpDb));
    expect(line).toBeTruthy();
    expect(line as string).toContain("free_mb=");
  });

  it("assertDiskReady on a temp path: not mounted, free space reported", () => {
    const ready = assertDiskReady(join(tmpDir, "other.sqlite"));
    expect(ready.dbPath).toBe(join(tmpDir, "other.sqlite"));
    expect(ready.mounted).toBe(false);
    expect(ready.freeMb).toBeGreaterThan(0);
  });

  it("assertDiskReady throws for a /var/data path when /var/data is not a mount", () => {
    expect(() => assertDiskReady("/var/data/verireceipt.sqlite")).toThrow(/not a mount point/);
    expect(() => assertDiskReady("/var/data/verireceipt.sqlite")).toThrow(/\/var\/data/);
  });

  it("assertDiskReady throws when the parent path is a file (uncreatable/unwritable)", () => {
    const blocker = join(tmpDir, "not-a-dir");
    writeFileSync(blocker, "x");
    // FIX 4: the guard's own format, naming the path — never a raw Node
    // "EEXIST: file already exists, mkdir ..." error.
    expect(() => assertDiskReady(join(blocker, "test.sqlite"))).toThrow(
      /verireceipt: refusing to open SQLite DB at .*cannot create parent directory/,
    );
    expect(() => assertDiskReady(join(blocker, "test.sqlite"))).toThrow(
      new RegExp(join(blocker, "test.sqlite").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("assertDiskReady throws in guard format for a nested path under a file parent", () => {
    const blocker = join(tmpDir, "not-a-dir-2");
    writeFileSync(blocker, "x");
    let message = "";
    try {
      assertDiskReady(join(blocker, "sub", "deep.sqlite"));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/verireceipt: refusing to open SQLite DB at/);
    expect(message).toContain(join(blocker, "sub", "deep.sqlite"));
    expect(message).not.toContain("EEXIST");
    expect(message).not.toContain("mkdir");
  });

  it("assertDiskReady refuses a disk below the 10 MB free-space floor (FIX 3)", () => {
    expect(MIN_DISK_FREE_MB).toBe(10);
    // Test seam: an explicit floor above the real free space proves the
    // threshold throws. Stubbing statfs is impossible here (the fs module
    // namespace is frozen — vi.spyOn(fs, "statfsSync") throws) and /tmp is
    // not full, so the floor parameter is the deterministic probe.
    expect(() => assertDiskReady(join(tmpDir, "floor.sqlite"), 10 ** 9)).toThrow(
      /verireceipt: refusing to open SQLite DB at .*below the minimum 1000000000 MB/,
    );
    // The default 10 MB floor still lets a healthy temp disk through.
    expect(() => assertDiskReady(join(tmpDir, "floor-ok.sqlite"))).not.toThrow();
  });

  it.skipIf(process.geteuid?.() === 0)(
    "assertDiskReady throws for a read-only directory (non-root only; root bypasses perms)",
    () => {
      const ro = join(tmpDir, "readonly");
      mkdirSync(ro, { recursive: true });
      chmodSync(ro, 0o555);
      try {
        expect(() => assertDiskReady(join(ro, "test.sqlite"))).toThrow(/not writable/);
      } finally {
        chmodSync(ro, 0o755);
      }
    },
  );
});

describe("hourly snapshots (b)", () => {
  let realSnapshotName = "";

  it("snapshotNow round-trips rows into a snapshot file", () => {
    seedReceipt("rcpt_SNAP00000000000000000001", utcDayIso(0, 10));
    seedReceipt("rcpt_SNAP00000000000000000002", utcDayIso(0, 11));
    seedReceipt("rcpt_SNAP00000000000000000003", utcDayIso(0, 12));
    const file = snapshotNow();
    expect(file).not.toBeNull();
    expect(file as string).toContain(join(tmpDir, "backups"));
    expect(basename(file as string)).toMatch(/^verireceipt-\d{8}-\d{4}\.sqlite$/);
    realSnapshotName = basename(file as string);
    expect(existsSync(file as string)).toBe(true);
    expect(statSync(file as string).size).toBeGreaterThan(0);
    const snap = new Database(file as string, { readonly: true });
    try {
      const rows = snap
        .prepare("SELECT receipt_id FROM miner_receipts ORDER BY receipt_id")
        .all() as Array<{ receipt_id: string }>;
      expect(rows.map((r) => r.receipt_id)).toEqual([
        "rcpt_SNAP00000000000000000001",
        "rcpt_SNAP00000000000000000002",
        "rcpt_SNAP00000000000000000003",
      ]);
    } finally {
      snap.close();
    }
  });

  it("same-minute snapshot collision is logged, not thrown (VACUUM INTO refuses overwrite)", () => {
    const fixed = new Date("2026-11-20T06:00:00Z");
    expect(snapshotNow(fixed)).not.toBeNull();
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      expect(() => snapshotNow(fixed)).not.toThrow();
      expect(snapshotNow(fixed)).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(errors.some((e) => e.includes("snapshot failed"))).toBe(true);
  });

  it("pruneSnapshots keeps exactly the 24 newest", () => {
    const dir = snapshotDir();
    const before = readdirSync(dir).filter((n) => n.startsWith("verireceipt-"));
    expect(before.length).toBe(2); // round-trip snapshot + fixed-minute snapshot above
    for (let day = 1; day <= 26; day++) {
      const dd = String(day).padStart(2, "0");
      writeFileSync(join(dir, `verireceipt-202601${dd}-0000.sqlite`), "fake");
    }
    const deleted = pruneSnapshots(dir);
    expect(deleted).toBe(before.length + 26 - 24);
    const after = readdirSync(dir).filter((n) => n.startsWith("verireceipt-"));
    expect(after.length).toBe(24);
    expect(existsSync(join(dir, "verireceipt-20260101-0000.sqlite"))).toBe(false);
    expect(existsSync(join(dir, "verireceipt-20260102-0000.sqlite"))).toBe(false);
    expect(existsSync(join(dir, "verireceipt-20260103-0000.sqlite"))).toBe(false);
    expect(existsSync(join(dir, "verireceipt-20260104-0000.sqlite"))).toBe(false);
    expect(existsSync(join(dir, "verireceipt-20260126-0000.sqlite"))).toBe(true);
    expect(after).toContain(realSnapshotName);
  });

  it("pruneSnapshots logs every prune, including a no-op (FIX 5)", () => {
    const dir = join(tmpDir, "prune-log");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "verireceipt-20260101-0000.sqlite"), "fake");
    writeFileSync(join(dir, "verireceipt-20260102-0000.sqlite"), "fake");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      expect(pruneSnapshots(dir)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(logs.some((l) => /prune: 0 deleted, 2 kept/.test(l))).toBe(true);
  });

  it("pruneSnapshots logs the deletion count when it deletes", () => {
    const dir = join(tmpDir, "prune-log-del");
    mkdirSync(dir, { recursive: true });
    for (let day = 1; day <= 25; day++) {
      const dd = String(day).padStart(2, "0");
      writeFileSync(join(dir, `verireceipt-202601${dd}-0000.sqlite`), "fake");
    }
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      expect(pruneSnapshots(dir)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(logs.some((l) => /prune: 1 deleted, 24 kept/.test(l))).toBe(true);
  });

  it("snapshot failure is logged, not thrown (backups path blocked by a file)", () => {
    const dir = snapshotDir();
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "blocking file");
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      expect(() => snapshotNow()).not.toThrow();
      expect(snapshotNow()).toBeNull();
    } finally {
      spy.mockRestore();
      rmSync(dir, { force: true });
    }
    expect(errors.some((e) => e.includes("snapshot failed"))).toBe(true);
  });
});

describe("daily off-service backup (c)", () => {
  it("exportReceiptsJsonl: exactly the 5 fields, in order, yesterday only", () => {
    seedReceipt("rcpt_YDAY0000000000000000001", utcDayIso(1, 8), "ONCHAIN_TX");
    seedReceipt("rcpt_YDAY0000000000000000002", utcDayIso(1, 20), "REGULATORY_FILING");
    seedReceipt("rcpt_TODAY000000000000000001", utcDayIso(0, 9), "ONCHAIN_TX");
    seedReceipt("rcpt_OLD00000000000000000001", utcDayIso(2, 9), "ONCHAIN_TX");
    const exp = exportReceiptsJsonl();
    expect(exp.dateStr).toBe(yesterdayDateStr());
    expect(exp.count).toBe(2);
    const lines = exp.jsonl.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(obj)).toEqual([...JSONL_FIELDS]);
      expect(obj).not.toHaveProperty("quorum_votes");
      expect(obj).not.toHaveProperty("audit_url");
    }
    expect(exp.jsonl).toContain("rcpt_YDAY0000000000000000001");
    expect(exp.jsonl).toContain("rcpt_YDAY0000000000000000002");
    expect(exp.jsonl).not.toContain("rcpt_TODAY000000000000000001");
    expect(exp.jsonl).not.toContain("rcpt_OLD00000000000000000001");
    // No secret material in the export: the stub token never appears.
    process.env.BACKUP_GITHUB_TOKEN = STUB_TOKEN;
    expect(exp.jsonl).not.toContain(STUB_TOKEN);
    expect(exp.jsonl).not.toContain("BACKUP_GITHUB_TOKEN");
  });

  it("pushDailyBackup skips when the file already exists (GET 200 -> no PUT)", async () => {
    process.env.BACKUP_GITHUB_TOKEN = STUB_TOKEN;
    delete process.env.BACKUP_REPO;
    const { calls, fetchImpl } = makeStubFetch([200]);
    const summary = await pushDailyBackup(fetchImpl);
    expect(summary.result).toBe("skipped-exists");
    expect(summary.dropped_days).toEqual([]);
    // R2/F6: yesterday's GET plus one backfill GET for the day before
    // (the OLD seed from the export test); both answer 200, so no PUT.
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      `https://api.github.com/repos/${BACKUP_REPO_DEFAULT}/contents/receipts-${yesterdayDateStr()}.jsonl`,
    );
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[1].init?.method).toBe("GET");
    expect(calls[1].url).toContain("receipts-");
    expect(calls[1].url).not.toBe(calls[0].url);
    expect(calls.some((c) => c.init?.method === "PUT")).toBe(false);
  });

  it("pushDailyBackup creates when absent (GET 404 -> one PUT, base64 JSONL)", async () => {
    process.env.BACKUP_GITHUB_TOKEN = STUB_TOKEN;
    delete process.env.BACKUP_REPO;
    // R3/B3: the backfill day's GET must answer 404 here (then PUT 201):
    // a non-200/404 GET for a receipt-bearing day is now a failure, not
    // a warn-and-skip — the old [404, 201] stub answered the backfill GET
    // with 201 and the run would now (correctly) report "failed".
    const { calls, fetchImpl } = makeStubFetch([404, 201, 404, 201]);
    const summary = await pushDailyBackup(fetchImpl);
    expect(summary.result).toBe("created");
    expect(summary.dropped_days).toEqual([]);
    // R2/F6: GET + PUT for yesterday, plus GET + PUT for the backfill day
    // before (the OLD seed); both days are uploaded.
    expect(calls).toHaveLength(4);
    expect(calls[0].init?.method).toBe("GET");
    const put = calls[1];
    expect(put.init?.method).toBe("PUT");
    expect(put.url).toContain(`receipts-${yesterdayDateStr()}.jsonl`);
    const headers = put.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${STUB_TOKEN}`);
    const body = JSON.parse(String(put.init?.body)) as {
      message: string;
      content: string;
      branch: string;
    };
    expect(body.message).toBe(`backup receipts ${yesterdayDateStr()}`);
    expect(body.branch).toBe("main");
    const decoded = Buffer.from(body.content, "base64").toString("utf8");
    expect(decoded).toBe(exportReceiptsJsonl().jsonl);
    expect(decoded).toContain("rcpt_YDAY0000000000000000001");
    expect(calls[2].init?.method).toBe("GET");
    expect(calls[2].url).toContain("receipts-");
    expect(calls[3].init?.method).toBe("PUT");
    const backfillDecoded = Buffer.from(
      JSON.parse(String(calls[3].init?.body)).content,
      "base64",
    ).toString("utf8");
    expect(backfillDecoded).toContain("rcpt_OLD00000000000000000001");
  });

  it("pushDailyBackup uploads nothing when yesterday has zero receipts", async () => {
    process.env.BACKUP_GITHUB_TOKEN = STUB_TOKEN;
    const { calls, fetchImpl } = makeStubFetch([404, 201]);
    const farFuture = new Date("2031-01-05T12:00:00Z");
    const summary = await pushDailyBackup(fetchImpl, farFuture);
    // R3/B3: no PUT (no in-window day has receipts), but the Nov-2026
    // seeds are all older than the 2031 window, so they are aged-out —
    // the run must NOT report a clean "skipped-empty".
    expect(summary.result).toBe("skipped-with-dropped");
    expect(calls).toHaveLength(0);
    const realNow = new Date();
    expect(summary.dropped_days.map((d) => d.dateStr).sort()).toEqual(
      [
        dateStrForDaysAgo(realNow, 2),
        dateStrForDaysAgo(realNow, 1),
        dateStrForDaysAgo(realNow, 0),
      ].sort(),
    );
    expect(summary.dropped_days.reduce((n, d) => n + d.count, 0)).toBe(7);
  });

  it("pushDailyBackup with no token warns, makes no call, never throws", async () => {
    delete process.env.BACKUP_GITHUB_TOKEN;
    const { calls, fetchImpl } = makeStubFetch([404, 201]);
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    try {
      const summary = await pushDailyBackup(fetchImpl);
      expect(summary.result).toBe("skipped-no-token");
      expect(summary.dropped_days).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toHaveLength(0);
    expect(warns.some((w) => w.includes("BACKUP_GITHUB_TOKEN"))).toBe(true);
    expect(warns.join(" ")).not.toContain(STUB_TOKEN);
  });

  it("startBackupJobs starts timers, snapshots at boot, and is idempotent", () => {
    delete process.env.BACKUP_GITHUB_TOKEN; // boot daily run must skip without network
    const jobs = startBackupJobs();
    expect(jobs.snapshotTimer).toBeTruthy();
    expect(jobs.dailyTimer).toBeTruthy();
    const snaps = readdirSync(snapshotDir()).filter((n) => n.startsWith("verireceipt-"));
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(startBackupJobs()).toBe(jobs);
    clearInterval(jobs.snapshotTimer);
    clearInterval(jobs.dailyTimer);
  });

  it("exportReceiptsJsonl: day boundary is the UTC date, not the string prefix (FIX 1)", () => {
    // Yesterday (UTC) at 22:30 UTC, written with a +02:00 offset so its
    // string prefix is TODAY's date — it must still be exported as
    // yesterday. And yesterday 23:30 with a -05:00 offset is 04:30 UTC
    // today — its string prefix is yesterday's date, but it must NOT be
    // exported. Under the old substr(fetched_at, 1, 10) both were wrong.
    const now = new Date();
    const y = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    y.setUTCDate(y.getUTCDate() - 1);
    const next = new Date(y);
    next.setUTCDate(next.getUTCDate() + 1);
    const p = (n: number) => String(n).padStart(2, "0");
    const ymd = (d: Date) =>
      `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    const offsetYesterday = `${ymd(next)}T00:30:00+02:00`; // = yesterday 22:30 UTC
    const offsetToday = `${ymd(y)}T23:30:00-05:00`; // = today 04:30 UTC
    seedReceipt("rcpt_OFFINC000000000000000001", offsetYesterday, "ONCHAIN_TX");
    seedReceipt("rcpt_OFFEXC000000000000000001", offsetToday, "ONCHAIN_TX");
    seedReceipt("rcpt_OFFZINC00000000000000001", utcDayIso(1, 10), "ONCHAIN_TX");
    seedReceipt("rcpt_OFFZTOD00000000000000001", utcDayIso(0, 9), "ONCHAIN_TX");
    const exp = exportReceiptsJsonl();
    expect(exp.jsonl).toContain("rcpt_OFFINC000000000000000001");
    expect(exp.jsonl).toContain("rcpt_OFFZINC00000000000000001");
    expect(exp.jsonl).not.toContain("rcpt_OFFEXC000000000000000001");
    expect(exp.jsonl).not.toContain("rcpt_OFFZTOD00000000000000001");
  });

  it("redactSecrets strips Bearer tokens and listed secrets", () => {
    expect(redactSecrets("boom Bearer abc123-def end")).toBe("boom Bearer [REDACTED] end");
    expect(redactSecrets("auth: Bearer XYZ", [])).not.toContain("XYZ");
    expect(redactSecrets(`token=${STUB_TOKEN} here`, [STUB_TOKEN])).not.toContain(STUB_TOKEN);
    expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
  });

  it("pushDailyBackup never logs a Bearer token echoed in a fetch error (FIX 2)", async () => {
    process.env.BACKUP_GITHUB_TOKEN = STUB_TOKEN;
    delete process.env.BACKUP_REPO;
    const FAKE_TOKEN = "ghp_FAKELEAKEDTOKEN1234567890";
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        throw new Error(
          `PUT failed: upstream echoed Authorization: Bearer ${FAKE_TOKEN} in the error`,
        );
      }
      return { status: 404 } as Response;
    }) as unknown as typeof fetch;
    const out: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    let result: string;
    let droppedDays: Array<{ dateStr: string; count: number }> = [];
    try {
      const summary = await pushDailyBackup(fetchImpl);
      result = summary.result;
      droppedDays = summary.dropped_days;
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
    expect(result).toBe("failed");
    expect(droppedDays).toEqual([]);
    const joined = out.join("\n");
    expect(joined).toContain("daily backup failed"); // the error path was hit
    expect(joined).toContain("Bearer [REDACTED]");
    expect(joined).not.toContain(FAKE_TOKEN);
    expect(joined).not.toContain(STUB_TOKEN);
  });
});

describe("guard log placement (FIX 6)", () => {
  it("a direct assertDiskReady() call logs exactly one disk-ready line and NO db-ready line (R5/MINOR-3)", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      assertDiskReady(join(tmpDir, "logplace.sqlite"));
    } finally {
      spy.mockRestore();
    }
    // R5/MINOR-3: assertDiskReady() logs "disk ready" now; "db ready"
    // is printed by getDb() only after the WAL validation and
    // integrity_check pass. The exactly-one-line-per-call property is
    // unchanged — only the wording moved.
    const lines = logs.filter((l) => l.includes("disk ready"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(join(tmpDir, "logplace.sqlite"));
    expect(lines[0]).toContain("free_mb=");
    expect(logs.some((l) => l.includes("db ready"))).toBe(false);
  });

  it("getDb() logs exactly one db-ready line (fresh module, fresh DB)", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "backup-test-freshdb-"));
    const freshDb = join(freshDir, "fresh.sqlite");
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = freshDb;
    vi.resetModules();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const fresh = await import("../src/core/db");
      fresh.getDb();
      const lines = logs.filter((l) => l.includes("db ready"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(freshDb);
      expect(lines[0]).toContain("free_mb=");
    } finally {
      spy.mockRestore();
      process.env.SQLITE_PATH = prev;
    }
  });
});

describe("DB round-2 fixes (F1–F8)", () => {
  // Fresh-module tests use scratch under ~/workspace/db-r2-scratch (NOT
  // /tmp) and remove their own dirs when done.
  const R2_SCRATCH = join(process.env.HOME || tmpdir(), "workspace", "db-r2-scratch", "vitest-tmp");
  function mkR2Dir(name: string): string {
    mkdirSync(R2_SCRATCH, { recursive: true });
    return mkdtempSync(join(R2_SCRATCH, `${name}-`));
  }

  const FAKE_GHP = "ghp_FAKELEAKEDTOKEN1234567890";

  it("F1: pruneSnapshots logs a line for a missing directory (still returns 0)", () => {
    const missing = join(tmpDir, "r2-does-not-exist");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      expect(pruneSnapshots(missing)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(
      logs.some(
        (l) =>
          l.includes("prune: directory missing, nothing pruned in") && l.includes(missing),
      ),
    ).toBe(true);
  });

  it("F2: 3x getDb() in one process logs exactly one db-ready line (cached calls log nothing)", async () => {
    const freshDir = mkR2Dir("f2");
    const freshDb = join(freshDir, "f2.sqlite");
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = freshDb;
    vi.resetModules();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const fresh = await import("../src/core/db");
      fresh.getDb();
      fresh.getDb();
      fresh.getDb();
      const lines = logs.filter((l) => l.includes("db ready"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(freshDb);
    } finally {
      spy.mockRestore();
      process.env.SQLITE_PATH = prev;
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("F3: redactSecrets strips bare ghp_/gho_/github_pat_/rnd_ tokens with no extraSecrets", () => {
    expect(redactSecrets(`token=${FAKE_GHP} leaked`)).not.toContain(FAKE_GHP);
    expect(redactSecrets(`GET https://x.invalid/?access_token=${FAKE_GHP} failed`)).not.toContain(
      FAKE_GHP,
    );
    expect(redactSecrets("Basic gho_FAKELEAKEDTOKEN1234567890 here")).not.toContain("gho_FAKE");
    expect(redactSecrets("key github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ here")).not.toContain(
      "github_pat_",
    );
    expect(redactSecrets("render rnd_FAKELEAKEDTOKEN1234567890 here")).not.toContain("rnd_FAKE");
    expect(redactSecrets("token=ghp_fakeleakedtoken1234567890 lower")).not.toContain("ghp_fake");
    // No over-match: innocent strings pass through untouched.
    expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
    expect(redactSecrets("hex ab12cd34ef56")).toBe("hex ab12cd34ef56");
    expect(redactSecrets("Bearer abc123-def end")).toBe("Bearer [REDACTED] end");
  });

  it("F3: snapshotNow error redacts a bare token (mutant C: dropping redactSecrets here must fail this test)", async () => {
    const base = mkR2Dir("f3-snap");
    // SQLITE_PATH is this existing directory, whose NAME is the token:
    // the guard error names the path, and the snapshot-failed prefix
    // names the file under it — both must come out redacted.
    const tokenDir = join(base, FAKE_GHP);
    mkdirSync(tokenDir, { recursive: true });
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = tokenDir;
    vi.resetModules();
    const out: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    try {
      const bk = await import("../src/jobs/backup");
      expect(bk.snapshotNow(new Date("2026-11-20T06:00:00Z"))).toBeNull();
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
    const joined = out.join("\n");
    expect(joined).toContain("snapshot failed");
    expect(joined).toContain("[REDACTED]");
    expect(joined).not.toContain(FAKE_GHP);
  });

  it("F3: startBackupJobs boot-snapshot error redacts a bare token", async () => {
    const base = mkR2Dir("f3-jobs");
    const tokenDir = join(base, FAKE_GHP);
    mkdirSync(tokenDir, { recursive: true });
    const prev = process.env.SQLITE_PATH;
    const prevToken = process.env.BACKUP_GITHUB_TOKEN;
    process.env.SQLITE_PATH = tokenDir;
    delete process.env.BACKUP_GITHUB_TOKEN; // boot daily run must skip without network
    vi.resetModules();
    const out: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    let jobs: { snapshotTimer: NodeJS.Timeout; dailyTimer: NodeJS.Timeout } | null = null;
    try {
      const bk = await import("../src/jobs/backup");
      jobs = bk.startBackupJobs();
      expect(jobs.snapshotTimer).toBeTruthy();
      expect(jobs.dailyTimer).toBeTruthy();
    } finally {
      if (jobs) {
        clearInterval(jobs.snapshotTimer);
        clearInterval(jobs.dailyTimer);
      }
      errSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      process.env.SQLITE_PATH = prev;
      if (prevToken === undefined) delete process.env.BACKUP_GITHUB_TOKEN;
      else process.env.BACKUP_GITHUB_TOKEN = prevToken;
      rmSync(base, { recursive: true, force: true });
    }
    const joined = out.join("\n");
    expect(joined).toContain("snapshot failed");
    expect(joined).toContain("[REDACTED]");
    expect(joined).not.toContain(FAKE_GHP);
  });

  it("F4: saveReceipt rejects malformed fetched_at; legitimate ISO forms still save", () => {
    const bad = [
      "garbage",
      "",
      "1763592000",
      "2026/11/19",
      "2026-11-20T00:30:00+0200",
      "2026-11-20T00:30:00+02",
      "2026-11-19T25:00:00Z",
      "2026-02-30T10:00:00Z",
    ];
    for (const fetchedAt of bad) {
      expect(() =>
        saveReceipt({
          receipt_id: "rcpt_R2F4BAD00000000000000001",
          intent: "ONCHAIN_TX",
          upstream_url: "https://example.invalid/u",
          raw_response_sha256: "ab".repeat(32),
          quorum_votes: "2/3",
          fetched_at: fetchedAt,
          audit_url: "",
        }),
      ).toThrow(/not a valid ISO-8601 timestamp/);
    }
    expect(isValidFetchedAt("2026-02-30T10:00:00Z")).toBe(false);
    expect(isValidFetchedAt("2026-11-19T25:00:00Z")).toBe(false);
    expect(isValidFetchedAt("2026-11-20T00:30:00+02:00")).toBe(true);
    // Legitimate forms (far-past dates, so they cannot disturb the
    // Nov-19/20 export assertions elsewhere in this file).
    const good: Array<[string, string]> = [
      ["rcpt_R2F4GOOD0000000000000001", "2026-01-15T10:00:00Z"],
      ["rcpt_R2F4GOOD0000000000000002", "2026-01-15"],
      ["rcpt_R2F4GOOD0000000000000003", "2026-01-15T10:00:00"],
      ["rcpt_R2F4GOOD0000000000000004", "2026-01-15 10:00:00"],
      ["rcpt_R2F4GOOD0000000000000005", "2026-01-16T00:30:00+02:00"],
      ["rcpt_R2F4GOOD0000000000000006", "2026-01-15T23:59:59.999Z"],
    ];
    for (const [id, fetchedAt] of good) {
      expect(() =>
        saveReceipt({
          receipt_id: id,
          intent: "ONCHAIN_TX",
          upstream_url: "https://example.invalid/u",
          raw_response_sha256: "ab".repeat(32),
          quorum_votes: "2/3",
          fetched_at: fetchedAt,
          audit_url: "",
        }),
      ).not.toThrow();
    }
  });

  it("F4: unparseable fetched_at rows warn (count + ids) and are excluded; Feb-30 is excluded from the normalized-day export", () => {
    const db = getDb();
    const insert = db.prepare(
      "INSERT OR IGNORE INTO miner_receipts (receipt_id, intent, upstream_url, raw_response_sha256, fetched_at) VALUES (?,?,?,?,?)",
    );
    // Raw SQL: saveReceipt() now refuses these, so only direct DB
    // tampering (or pre-validation rows) can still produce them.
    const bad: Array<[string, string]> = [
      ["rcpt_R2F4GARBAGE0000000000001", "garbage"],
      ["rcpt_R2F4EMPTY00000000000001", ""],
      ["rcpt_R2F4EPOCH00000000000001", "1763592000"],
      ["rcpt_R2F4SLASH00000000000001", "2026/11/19"],
      ["rcpt_R2F4HOUR2500000000000001", "2026-11-19T25:00:00Z"],
    ];
    for (const [id, v] of bad) {
      insert.run(id, "ONCHAIN_TX", "https://example.invalid/u", "ab".repeat(32), v);
    }
    insert.run(
      "rcpt_R2F4FEB3000000000000001",
      "ONCHAIN_TX",
      "https://example.invalid/u",
      "ab".repeat(32),
      "2026-02-30T10:00:00Z",
    );
    insert.run(
      "rcpt_R2F4OK00000000000000001",
      "ONCHAIN_TX",
      "https://example.invalid/u",
      "ab".repeat(32),
      "2026-11-19T10:00:00Z",
    );
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    let exp19: { jsonl: string; count: number };
    let expMar: { jsonl: string; count: number };
    try {
      exp19 = exportReceiptsJsonl(new Date("2026-11-20T12:00:00Z"));
      expMar = exportReceiptsJsonl(new Date("2026-03-03T12:00:00Z"));
    } finally {
      spy.mockRestore();
    }
    expect(exp19.jsonl).toContain("rcpt_R2F4OK00000000000000001");
    for (const [id] of bad) expect(exp19.jsonl).not.toContain(id);
    // Feb-30 must NOT ride SQLite's normalization into the Mar-2 export.
    expect(expMar.jsonl).not.toContain("rcpt_R2F4FEB3000000000000001");
    const joined = warns.join("\n");
    for (const [id] of bad) expect(joined).toContain(id);
    expect(joined).toContain("rcpt_R2F4FEB3000000000000001");
    expect(joined).toMatch(/unparseable fetched_at/);
    expect(joined).toMatch(/invalid fetched_at/);
  });

  it("F5: a failed snapshot still prunes (30 fakes + collision -> exactly 24 files)", () => {
    const dir = snapshotDir();
    mkdirSync(dir, { recursive: true });
    const fixed = new Date("2026-11-20T06:00:00Z");
    for (let day = 1; day <= 30; day++) {
      writeFileSync(join(dir, `verireceipt-202601${String(day).padStart(2, "0")}-0000.sqlite`), "fake");
    }
    writeFileSync(join(dir, snapshotFileName(fixed)), "pre-existing"); // force VACUUM INTO collision
    const before = readdirSync(dir).filter((n) => n.startsWith("verireceipt-")).length;
    expect(before).toBeGreaterThan(24);
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    let result: string | null;
    try {
      result = snapshotNow(fixed);
    } finally {
      spy.mockRestore();
    }
    expect(result).toBeNull();
    expect(errors.some((e) => e.includes("snapshot failed"))).toBe(true);
    const after = readdirSync(dir).filter((n) => n.startsWith("verireceipt-"));
    expect(after.length).toBe(24);
    expect(after).not.toContain("verireceipt-20260101-0000.sqlite");
  });

  it("F6: a day lost to PUT 500 is backfilled on the next run; existing days are never re-uploaded", async () => {
    expect(DAILY_BACKUP_WINDOW_DAYS).toBe(7);
    expect(dateStrForDaysAgo(new Date("2026-11-21T12:00:00Z"), 2)).toBe("20261119");
    expect(exportReceiptsJsonlForDay).toBeTypeOf("function");
    const base = mkR2Dir("f6");
    const dbPath = join(base, "f6.sqlite");
    const prev = process.env.SQLITE_PATH;
    const prevToken = process.env.BACKUP_GITHUB_TOKEN;
    const prevRepo = process.env.BACKUP_REPO;
    process.env.SQLITE_PATH = dbPath;
    process.env.BACKUP_GITHUB_TOKEN = STUB_TOKEN;
    delete process.env.BACKUP_REPO;
    vi.resetModules();
    try {
      const bk = await import("../src/jobs/backup");
      const dbMod = await import("../src/core/db");
      const seed = (id: string, day: string) =>
        dbMod.saveReceipt({
          receipt_id: id,
          intent: "ONCHAIN_TX",
          upstream_url: "https://example.invalid/u",
          raw_response_sha256: "ab".repeat(32),
          quorum_votes: "2/3",
          fetched_at: `${day}T10:00:00Z`,
          audit_url: "",
        });
      seed("rcpt_R2F6DAY19-0000000000001", "2026-11-19");
      seed("rcpt_R2F6DAY20-0000000000001", "2026-11-20");
      interface Call {
        method?: string;
        url: string;
        body?: string;
      }
      const calls: Call[] = [];
      const record = (url: unknown, init?: RequestInit) => {
        calls.push({
          method: init?.method,
          url: String(url),
          body: init?.body ? String(init.body) : undefined,
        });
      };
      const failPut = (async (url: unknown, init?: RequestInit) => {
        record(url, init);
        if (init?.method === "PUT") return { status: 500 } as Response;
        return { status: 404 } as Response;
      }) as unknown as typeof fetch;
      // Run 1 (now Nov 20, exports Nov 19): PUT fails 500.
      const r1 = await bk.pushDailyBackup(failPut, new Date("2026-11-20T12:00:00Z"));
      expect(r1.result).toBe("failed");
      expect(r1.dropped_days).toEqual([]);
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
      // Run 2 (now Nov 21): everything succeeds — Nov 19 backfilled AND Nov 20 uploaded.
      calls.length = 0;
      const okFetch = (async (url: unknown, init?: RequestInit) => {
        record(url, init);
        if (init?.method === "PUT") return { status: 201 } as Response;
        return { status: 404 } as Response;
      }) as unknown as typeof fetch;
      const r2 = await bk.pushDailyBackup(okFetch, new Date("2026-11-21T12:00:00Z"));
      expect(r2.result).toBe("created");
      expect(r2.dropped_days).toEqual([]);
      const puts = calls.filter((c) => c.method === "PUT");
      expect(puts).toHaveLength(2);
      const bodies = puts
        .map((p) => Buffer.from(JSON.parse(p.body as string).content, "base64").toString("utf8"))
        .join("\n");
      expect(bodies).toContain("rcpt_R2F6DAY19-0000000000001");
      expect(bodies).toContain("rcpt_R2F6DAY20-0000000000001");
      // Run 3: both days exist now -> skipped, no PUT at all.
      calls.length = 0;
      const existsFetch = (async (url: unknown, init?: RequestInit) => {
        record(url, init);
        return { status: 200 } as Response;
      }) as unknown as typeof fetch;
      const r3 = await bk.pushDailyBackup(existsFetch, new Date("2026-11-21T12:00:00Z"));
      expect(r3.result).toBe("skipped-exists");
      expect(r3.dropped_days).toEqual([]);
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    } finally {
      process.env.SQLITE_PATH = prev;
      if (prevToken === undefined) delete process.env.BACKUP_GITHUB_TOKEN;
      else process.env.BACKUP_GITHUB_TOKEN = prevToken;
      if (prevRepo === undefined) delete process.env.BACKUP_REPO;
      else process.env.BACKUP_REPO = prevRepo;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("F7: assertDiskReady refuses a directory path and a trailing-slash path in guard format", () => {
    const dirPath = join(tmpDir, "r2-dirpath");
    mkdirSync(dirPath, { recursive: true });
    expect(() => assertDiskReady(dirPath)).toThrow(
      /verireceipt: refusing to open SQLite DB at .*path is a directory/,
    );
    expect(() => assertDiskReady(dirPath + "/")).toThrow(
      /verireceipt: refusing to open SQLite DB at .*trailing slash/,
    );
    expect(() => assertDiskReady(join(tmpDir, "r2-nope") + "/")).toThrow(/trailing slash/);
  });

  it("F7/F8: getDb on corrupt / directory / trailing-slash / zero-byte paths throws in guard format; a non-existent path still boots", async () => {
    const base = mkR2Dir("f7f8");
    const corrupt = join(base, "corrupt.sqlite");
    writeFileSync(corrupt, Buffer.from("garbage-not-a-database".repeat(200)));
    const corruptHeader = join(base, "corrupt2.sqlite");
    writeFileSync(
      corruptHeader,
      Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4080, 0x41)]),
    );
    const zero = join(base, "zero.sqlite");
    writeFileSync(zero, "");
    const dirPath = join(base, "somedir");
    mkdirSync(dirPath, { recursive: true });

    async function getDbError(dbPath: string): Promise<string> {
      const prev = process.env.SQLITE_PATH;
      process.env.SQLITE_PATH = dbPath;
      vi.resetModules();
      try {
        const m = await import("../src/core/db");
        m.getDb();
        return "NO-THROW";
      } catch (err) {
        return err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
      } finally {
        process.env.SQLITE_PATH = prev;
      }
    }

    const corruptMsg = await getDbError(corrupt);
    expect(corruptMsg).toMatch(/verireceipt: refusing to open SQLite DB at/);
    expect(corruptMsg).toContain("file is not a database");
    expect(corruptMsg).not.toContain("SqliteError");

    const corruptHeaderMsg = await getDbError(corruptHeader);
    expect(corruptHeaderMsg).toMatch(/verireceipt: refusing to open SQLite DB at/);
    expect(corruptHeaderMsg).not.toContain("SqliteError");

    const dirMsg = await getDbError(dirPath);
    expect(dirMsg).toMatch(/verireceipt: refusing to open SQLite DB at .*path is a directory/);
    expect(dirMsg).not.toContain("SqliteError");

    const slashMsg = await getDbError(dirPath + "/");
    expect(slashMsg).toMatch(/verireceipt: refusing to open SQLite DB at .*trailing slash/);
    expect(slashMsg).not.toContain("SqliteError");

    const zeroMsg = await getDbError(zero);
    expect(zeroMsg).toMatch(/verireceipt: refusing to open SQLite DB at .*file is empty/);
    expect(zeroMsg).not.toContain("SqliteError");

    // Non-existent path still boots and builds the schema.
    const freshPath = join(base, "fresh.sqlite");
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = freshPath;
    vi.resetModules();
    try {
      const m = await import("../src/core/db");
      const db = m.getDb();
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='miner_receipts'",
        )
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
    } finally {
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("F8: assertDiskReady refuses a pre-existing zero-byte file in guard format", () => {
    const zero = join(tmpDir, "r2-zero.sqlite");
    writeFileSync(zero, "");
    expect(() => assertDiskReady(zero)).toThrow(
      /verireceipt: refusing to open SQLite DB at .*file is empty/,
    );
  });
});

describe("DB round-3 fixes (R3)", () => {
  // Fresh-module tests use scratch under ~/workspace/db-r3-scratch (NOT
  // /tmp) and remove their own dirs when done.
  const R3_SCRATCH = join(process.env.HOME || tmpdir(), "workspace", "db-r3-scratch", "vitest-tmp");
  function mkR3Dir(name: string): string {
    mkdirSync(R3_SCRATCH, { recursive: true });
    return mkdtempSync(join(R3_SCRATCH, `${name}-`));
  }

  const FAKE_GHP = "ghp_FAKELEAKEDTOKEN1234567890";

  /** Capture console.log + console.warn + console.error into one array. */
  function captureAll(): { out: string[]; restore: () => void } {
    const out: string[] = [];
    const push = (...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(push);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(push);
    const errSpy = vi.spyOn(console, "error").mockImplementation(push);
    return {
      out,
      restore: () => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errSpy.mockRestore();
      },
    };
  }

  it("R3/B1: redactSecrets — uppercase prefixes redacted; short innocent strings pass through", () => {
    // Uppercase issuer prefixes are still tokens.
    expect(redactSecrets("leak GHP_FAKELEAKEDTOKEN1234567890 here")).toBe("leak [REDACTED] here");
    expect(redactSecrets("leak RND_FAKELEAKEDTOKEN1234567890 here")).toBe("leak [REDACTED] here");
    expect(redactSecrets("GHO_FAKELEAKEDTOKEN1234567890")).toBe("[REDACTED]");
    // Real-shaped rnd_ (>= 16 chars) is redacted.
    expect(redactSecrets("render rnd_FAKELEAKEDTOKEN1234567890 here")).not.toContain("rnd_FAKE");
    expect(redactSecrets("rnd_abcdefghij123456")).toBe("[REDACTED]");
    // Innocent short strings pass through UNTOUCHED (the round-2
    // docstring claim that no innocent string matches was false).
    expect(redactSecrets("rnd_3")).toBe("rnd_3");
    expect(redactSecrets("rnd_notes.txt")).toBe("rnd_notes.txt");
    expect(redactSecrets("/data/rnd_reports/2026")).toBe("/data/rnd_reports/2026");
    expect(redactSecrets("see github_pat_docs for details")).toBe("see github_pat_docs for details");
    expect(redactSecrets("ghp_x")).toBe("ghp_x");
    expect(redactSecrets("token ghp_abc here")).toBe("token ghp_abc here");
    // Bearer + explicit secrets still work.
    expect(redactSecrets("Bearer abc123-def end")).toBe("Bearer [REDACTED] end");
    expect(redactSecrets(`token=${STUB_TOKEN}`, [STUB_TOKEN])).not.toContain(STUB_TOKEN);
  });

  it("R3/B1: redactSecrets — a token split across a newline is rejoined and redacted", () => {
    const splitPrefix = redactSecrets(`leak ghp_\n${"FAKELEAKEDTOKEN1234567890"} end`);
    expect(splitPrefix).not.toContain("FAKELEAKEDTOKEN");
    expect(splitPrefix).not.toContain("ghp_");
    expect(splitPrefix).toContain("[REDACTED]");
    const splitBody = redactSecrets("leak ghp_FAKELEAKED\nTOKEN1234567890 end");
    expect(splitBody).not.toContain("FAKELEAKED");
    expect(splitBody).not.toContain("TOKEN1234567890");
    expect(splitBody).toContain("[REDACTED]");
    // The join is not token-aware: ANY whitespace run containing a
    // line break between two token characters (word char or hyphen)
    // is removed, so a wrapped line flattens; a break next to any
    // other character is kept.
    expect(redactSecrets("line one\nline two")).toBe("line oneline two");
    expect(redactSecrets("error:\nline two")).toBe("error:\nline two");
  });

  it("R3/B1: no log line (stdout+stderr, success AND error paths) contains a bare token in the DB path", async () => {
    const base = mkR3Dir("r3-b1-audit");
    const tokenDir = join(base, FAKE_GHP);
    mkdirSync(tokenDir, { recursive: true });
    const dbPath = join(tokenDir, "db.sqlite");
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    const cap = captureAll();
    let instance: Database.Database | null = null;
    try {
      const dbMod = await import("../src/core/db");
      const bk = await import("../src/jobs/backup");
      instance = dbMod.getDb();
      dbMod.saveReceipt({
        receipt_id: "rcpt_R3B1AUDIT0000000000001",
        intent: "ONCHAIN_TX",
        upstream_url: "https://example.invalid/u",
        raw_response_sha256: "ab".repeat(32),
        quorum_votes: "2/3",
        fetched_at: "2026-11-20T10:00:00Z",
        audit_url: "",
      });
      // Success paths: db ready (assertDiskReady) + snapshot success +
      // prune no-op (snapshotNow's finally).
      const snap = bk.snapshotNow(new Date("2026-11-20T06:00:00Z"));
      expect(snap).not.toBeNull();
      // Missing-dir prune line, under the token dir.
      expect(bk.pruneSnapshots(join(tokenDir, "no-such-dir"))).toBe(0);
      // Error path: same-minute snapshot collision -> "snapshot failed".
      expect(bk.snapshotNow(new Date("2026-11-20T06:00:00Z"))).toBeNull();
    } finally {
      cap.restore();
      if (instance) instance.close();
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
    const joined = cap.out.join("\n");
    expect(joined).toContain("db ready");
    expect(joined).toContain("snapshot");
    expect(joined).toContain("prune: directory missing");
    expect(joined).toContain("snapshot failed");
    expect(joined).toContain("[REDACTED]");
    expect(joined).not.toContain(FAKE_GHP);
    expect(joined).not.toContain("FAKELEAKEDTOKEN");
  });

  it("R3/B1: GET/PUT status failures are logged (redacted) and fail the run", async () => {
    // The GET/PUT lines carry only a filename + numeric status, so no
    // secret can reach them — the redactSecrets wrap is belt-and-braces
    // for the literal §11 claim. This pins the lines exist and are hit.
    const base = mkR3Dir("r3-b1-getput");
    const dbPath = join(base, "b1.sqlite");
    const prev = process.env.SQLITE_PATH;
    const prevToken = process.env.BACKUP_GITHUB_TOKEN;
    process.env.SQLITE_PATH = dbPath;
    process.env.BACKUP_GITHUB_TOKEN = STUB_TOKEN;
    delete process.env.BACKUP_REPO;
    vi.resetModules();
    const out: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    try {
      const dbMod = await import("../src/core/db");
      const bk = await import("../src/jobs/backup");
      dbMod.saveReceipt({
        receipt_id: "rcpt_R3B1GETPUT00000000001",
        intent: "ONCHAIN_TX",
        upstream_url: "https://example.invalid/u",
        raw_response_sha256: "ab".repeat(32),
        quorum_votes: "2/3",
        fetched_at: "2026-11-20T10:00:00Z",
        audit_url: "",
      });
      const get500 = (async () => ({ status: 500 }) as Response) as unknown as typeof fetch;
      const s = await bk.pushDailyBackup(get500, new Date("2026-11-21T12:00:00Z"));
      expect(s.result).toBe("failed");
      expect(out.some((l) => l.includes("GET") && l.includes("HTTP 500"))).toBe(true);
      const put500 = (async (url: unknown, init?: RequestInit) => {
        if (init?.method === "PUT") return { status: 500 } as Response;
        return { status: 404 } as Response;
      }) as unknown as typeof fetch;
      out.length = 0;
      const s2 = await bk.pushDailyBackup(put500, new Date("2026-11-21T12:00:00Z"));
      expect(s2.result).toBe("failed");
      expect(out.some((l) => l.includes("PUT") && l.includes("HTTP 500"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      process.env.SQLITE_PATH = prev;
      if (prevToken === undefined) delete process.env.BACKUP_GITHUB_TOKEN;
      else process.env.BACKUP_GITHUB_TOKEN = prevToken;
      rmSync(base, { recursive: true, force: true });
    }
  });

  /** Build a fresh-module DB with 200 receipts; return module + path. Caller closes + cleans up. */
  async function build200ReceiptDb(base: string, prefix: string): Promise<{
    dbMod: typeof import("../src/core/db");
    dbPath: string;
    instance: Database.Database;
  }> {
    const dbPath = join(base, `${prefix}.sqlite`);
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    const dbMod = await import("../src/core/db");
    const instance = dbMod.getDb();
    for (let i = 0; i < 200; i++) {
      dbMod.saveReceipt({
        receipt_id: `rcpt_${prefix}${String(i).padStart(4, "0")}0000000000`,
        intent: "ONCHAIN_TX",
        upstream_url: "https://example.invalid/u",
        raw_response_sha256: "ab".repeat(32),
        quorum_votes: "2/3",
        fetched_at: `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T10:00:00Z`,
        audit_url: "",
      });
    }
    const pages = instance.prepare("PRAGMA page_count").get() as { page_count: number };
    expect(pages.page_count).toBeGreaterThanOrEqual(10);
    process.env.SQLITE_PATH = prev;
    return { dbMod, dbPath, instance };
  }

  it("R3/B2: a valid DB with ONLY page 3 corrupted refuses to boot (guard format, logged)", async () => {
    const base = mkR3Dir("r3-b2-p3");
    const { dbPath, instance } = await build200ReceiptDb(base, "R3B2P3");
    instance.close();
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
    const bytes = readFileSync(dbPath);
    expect(bytes.length).toBeGreaterThan(12288);
    const corrupted = Buffer.from(bytes);
    corrupted.fill(0x41, 8192, 12288); // page 3 only; header + schema page intact
    writeFileSync(dbPath, corrupted);
    // Prove quick_check sees it (the old first-exec did not).
    const probe = new Database(dbPath, { readonly: true });
    const qc = probe.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    probe.close();
    expect(qc.some((r) => r.quick_check !== "ok")).toBe(true);

    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    const cap = captureAll();
    let message = "";
    try {
      const fresh = await import("../src/core/db");
      try {
        fresh.getDb();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
    } finally {
      cap.restore();
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
    // R4: on this corruption integrity_check itself THROWS "database
    // disk image is malformed" (quick_check returned problem rows
    // instead) — either form is a guard-format refusal, and the
    // guard's catch logs + rethrows both the same way.
    expect(message).toMatch(
      /verireceipt: refusing to open SQLite DB at .*(integrity check failed|database disk image is malformed)/,
    );
    expect(message).not.toContain("SqliteError");
    // The refusal is LOGGED, not just thrown.
    expect(cap.out.join("\n")).toMatch(/integrity check failed|database disk image is malformed/);
  });

  it("R3/B2: a leaf-page single-byte flip refuses to boot (guard format)", async () => {
    const base = mkR3Dir("r3-b2-p9");
    const { dbPath, instance } = await build200ReceiptDb(base, "R3B2P9");
    instance.close();
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
    const bytes = readFileSync(dbPath);
    // Find a leaf table b-tree page (first byte 0x0d) past the schema
    // pages — the exact leaf layout depends on row sizes, so scan rather
    // than assuming page 9. Flipping its type byte is J2's leaf-page
    // single-byte flip.
    const pageSize = 4096;
    let leafOff = -1;
    for (let off = pageSize * 2; off < bytes.length; off += pageSize) {
      if (bytes[off] === 0x0d) {
        leafOff = off;
        break;
      }
    }
    expect(leafOff).toBeGreaterThan(0);
    const corrupted = Buffer.from(bytes);
    corrupted[leafOff] = 0x00;
    writeFileSync(dbPath, corrupted);

    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    let message = "";
    try {
      const fresh = await import("../src/core/db");
      try {
        fresh.getDb();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
    } finally {
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
    expect(message).toMatch(/verireceipt: refusing to open SQLite DB at /);
    expect(message).toMatch(/integrity check failed|database disk image is malformed/);
    expect(message).not.toContain("SqliteError");
  });

  it("R3/B2: a healthy 200-receipt DB still boots, and the boot integrity check is fast", async () => {
    const base = mkR3Dir("r3-b2-ok");
    const { dbPath, instance } = await build200ReceiptDb(base, "R3B2OK");
    instance.close();
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    try {
      const fresh = await import("../src/core/db");
      const t0 = Date.now();
      const db = fresh.getDb();
      const ms = Date.now() - t0;
      // integrity_check on this size is ~0.11 ms measured (R4); 5000 ms
      // is a generous bound that only trips on a pathological regression.
      expect(ms).toBeLessThan(5000);
      const n = db.prepare("SELECT COUNT(*) AS n FROM miner_receipts").get() as { n: number };
      expect(n.n).toBe(200);
      db.close();
    } finally {
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("R4/BLOCKER: the round-3 V6 case — sequential-id both-copies flip is now REFUSED by integrity_check", async () => {
    // REWORKED in R4: this was the round-3 "honest limit" test (a
    // flipped payload byte passes quick_check and boots). That limit
    // was FALSE for this case: the corrupted value sorts after every
    // rcpt_R… id while its index cell sits in the middle, so
    // integrity_check refuses it. The TRUE uncatchable class is
    // pinned by the two R4/BLOCKER honest-limit tests below.
    const base = mkR3Dir("r3-b2-v6");
    const { dbPath, instance } = await build200ReceiptDb(base, "R3B2V6");
    instance.close();
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
    const bytes = readFileSync(dbPath);
    // Flip one byte inside a STORED receipt_id (row 0's id). The id
    // occurs three times in the file (table leaf + PK autoindex, plus
    // a stale copy in unallocated space), so flip the byte in EVERY
    // occurrence — flipping only the first would desync the index
    // from the table and the test would prove nothing about the row
    // itself.
    const targetId = Buffer.from("rcpt_R3B2V600000000000000");
    let occurrences = 0;
    const corrupted = Buffer.from(bytes);
    let from = 0;
    for (;;) {
      const idx = corrupted.indexOf(targetId, from);
      if (idx < 0) break;
      corrupted[idx + 5] = "X".charCodeAt(0); // 'R' -> 'X' inside the id
      occurrences++;
      from = idx + targetId.length;
    }
    expect(occurrences).toBeGreaterThanOrEqual(2);
    writeFileSync(dbPath, corrupted);
    // quick_check still says ok (the old boot check would have
    // booted); integrity_check refuses it.
    const probe = new Database(dbPath, { readonly: true });
    const qc = probe.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    expect(qc).toEqual([{ quick_check: "ok" }]);
    const ic = probe.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    probe.close();
    expect(ic.some((r) => r.integrity_check.includes("missing from index"))).toBe(true);

    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    const cap = captureAll();
    let message = "";
    try {
      const fresh = await import("../src/core/db");
      try {
        fresh.getDb();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
    } finally {
      cap.restore();
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
    expect(message).toMatch(/verireceipt: refusing to open SQLite DB at .*integrity check failed/);
    expect(message).toContain("missing from index");
    expect(message).not.toContain("SqliteError");
    // The refusal is LOGGED, not just thrown.
    expect(cap.out.join("\n")).toContain("integrity check failed");
  });
});

describe("DB round-3 fixes (R3) — daily backup window, F1/F5, years", () => {
  const R3B_SCRATCH = join(process.env.HOME || tmpdir(), "workspace", "db-r3-scratch", "vitest-tmp");
  function mkR3BDir(name: string): string {
    mkdirSync(R3B_SCRATCH, { recursive: true });
    return mkdtempSync(join(R3B_SCRATCH, `${name}-`));
  }

  interface FreshBackup {
    bk: typeof import("../src/jobs/backup");
    dbMod: typeof import("../src/core/db");
    instance: Database.Database;
    base: string;
    restore: () => void;
  }

  async function freshBackupWithSeeds(
    dirName: string,
    seeds: Array<[string, string]>,
  ): Promise<FreshBackup> {
    const base = mkR3BDir(dirName);
    const dbPath = join(base, "b3.sqlite");
    const prev = process.env.SQLITE_PATH;
    const prevToken = process.env.BACKUP_GITHUB_TOKEN;
    const prevRepo = process.env.BACKUP_REPO;
    process.env.SQLITE_PATH = dbPath;
    process.env.BACKUP_GITHUB_TOKEN = STUB_TOKEN;
    delete process.env.BACKUP_REPO;
    vi.resetModules();
    const dbMod = await import("../src/core/db");
    const bk = await import("../src/jobs/backup");
    const instance = dbMod.getDb();
    for (const [id, day] of seeds) {
      dbMod.saveReceipt({
        receipt_id: id,
        intent: "ONCHAIN_TX",
        upstream_url: "https://example.invalid/u",
        raw_response_sha256: "ab".repeat(32),
        quorum_votes: "2/3",
        fetched_at: `${day}T10:00:00Z`,
        audit_url: "",
      });
    }
    return {
      bk,
      dbMod,
      instance,
      base,
      restore: () => {
        process.env.SQLITE_PATH = prev;
        if (prevToken === undefined) delete process.env.BACKUP_GITHUB_TOKEN;
        else process.env.BACKUP_GITHUB_TOKEN = prevToken;
        if (prevRepo === undefined) delete process.env.BACKUP_REPO;
        else process.env.BACKUP_REPO = prevRepo;
      },
    };
  }

  interface B3Call {
    method?: string;
    url: string;
  }

  function makeB3Fetch(
    statusFor: (url: string, method: string | undefined) => number,
    delayMs = 0,
  ): { calls: B3Call[]; fetchImpl: typeof fetch } {
    const calls: B3Call[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method, url: String(url) });
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { status: statusFor(String(url), init?.method) } as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const okStatus = (url: string, method: string | undefined): number =>
    method === "PUT" ? 201 : 404;

  it("R3/B3: day −8 with receipts is warned about (day + count) and listed in the summary; never PUT", async () => {
    const { bk, instance, base, restore } = await freshBackupWithSeeds("r3-b3-aged", [
      ["rcpt_R3B3D13A000000000000001", "2026-11-13"],
      ["rcpt_R3B3D13B000000000000001", "2026-11-13"],
      ["rcpt_R3B3D200000000000000001", "2026-11-20"],
      ["rcpt_R3B3D190000000000000001", "2026-11-19"],
    ]);
    const now = new Date("2026-11-21T12:00:00Z");
    // The pure detector names the day before any network happens.
    expect(bk.findAgedOutDays(now)).toEqual([{ dateStr: "20261113", count: 2 }]);
    const { calls, fetchImpl } = makeB3Fetch(okStatus);
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    let summary: { result: string; dropped_days: Array<{ dateStr: string; count: number }> };
    try {
      summary = await bk.pushDailyBackup(fetchImpl, now);
    } finally {
      warnSpy.mockRestore();
      instance.close();
      restore();
      rmSync(base, { recursive: true, force: true });
    }
    expect(summary.result).toBe("created-with-dropped");
    expect(summary.dropped_days).toEqual([{ dateStr: "20261113", count: 2 }]);
    const joinedWarns = warns.join("\n");
    expect(joinedWarns).toContain(
      "day 2026-11-13 has 2 receipts but is outside the 7-day window, NOT backed up",
    );
    expect(joinedWarns).toContain("20261113");
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts.some((p) => p.url.includes("20261120"))).toBe(true);
    expect(puts.some((p) => p.url.includes("20261119"))).toBe(true);
    expect(calls.some((c) => c.url.includes("20261113"))).toBe(false);
  });

  it("R3/B3: day −7 is still backfilled; day −8 is warned, not uploaded", async () => {
    const { bk, instance, base, restore } = await freshBackupWithSeeds("r3-b3-edge", [
      ["rcpt_R3B3D140000000000000001", "2026-11-14"],
      ["rcpt_R3B3D13C000000000000001", "2026-11-13"],
    ]);
    const { calls, fetchImpl } = makeB3Fetch(okStatus);
    let summary: { result: string; dropped_days: Array<{ dateStr: string; count: number }> };
    try {
      summary = await bk.pushDailyBackup(fetchImpl, new Date("2026-11-21T12:00:00Z"));
    } finally {
      instance.close();
      restore();
      rmSync(base, { recursive: true, force: true });
    }
    expect(summary.result).toBe("created-with-dropped");
    expect(summary.dropped_days).toEqual([{ dateStr: "20261113", count: 1 }]);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain("20261114");
    expect(calls.some((c) => c.url.includes("20261113"))).toBe(false);
  });

  it("R3/B3: aged-out days with nothing in-window report skipped-with-dropped and make no calls", async () => {
    const { bk, instance, base, restore } = await freshBackupWithSeeds("r3-b3-onlyold", [
      ["rcpt_R3B3OLD0000000000000001", "2026-11-13"],
    ]);
    const { calls, fetchImpl } = makeB3Fetch(okStatus);
    let summary: { result: string; dropped_days: Array<{ dateStr: string; count: number }> };
    try {
      summary = await bk.pushDailyBackup(fetchImpl, new Date("2026-11-21T12:00:00Z"));
    } finally {
      instance.close();
      restore();
      rmSync(base, { recursive: true, force: true });
    }
    expect(summary.result).toBe("skipped-with-dropped");
    expect(summary.dropped_days).toEqual([{ dateStr: "20261113", count: 1 }]);
    expect(calls).toHaveLength(0);
  });

  it("R3/B3: two concurrent runs coalesce — each day PUT exactly once", async () => {
    const { bk, instance, base, restore } = await freshBackupWithSeeds("r3-b3-conc", [
      ["rcpt_R3B3C200000000000000001", "2026-11-20"],
      ["rcpt_R3B3C190000000000000001", "2026-11-19"],
    ]);
    const { calls, fetchImpl } = makeB3Fetch(okStatus, 30);
    const now = new Date("2026-11-21T12:00:00Z");
    let s1: unknown;
    let s2: unknown;
    let s3: { result: string };
    try {
      const p1 = bk.pushDailyBackup(fetchImpl, now);
      const p2 = bk.pushDailyBackup(fetchImpl, now);
      [s1, s2] = await Promise.all([p1, p2]);
      expect(s1).toBe(s2); // same in-flight run, same summary object
      expect((s1 as { result: string }).result).toBe("created");
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
      // The guard clears after the run: a sequential run works normally.
      const existsFetch = (async (url: unknown, init?: RequestInit) => {
        calls.push({ method: init?.method, url: String(url) });
        return { status: 200 } as Response;
      }) as unknown as typeof fetch;
      s3 = await bk.pushDailyBackup(existsFetch, now);
      expect(s3.result).toBe("skipped-exists");
    } finally {
      instance.close();
      restore();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("R3/B3: a backfill GET 500 is a failure (not skipped-empty), warned, and retried next run", async () => {
    const { bk, instance, base, restore } = await freshBackupWithSeeds("r3-b3-get500", [
      ["rcpt_R3B3G200000000000000001", "2026-11-20"],
      ["rcpt_R3B3G190000000000000001", "2026-11-19"],
    ]);
    const now = new Date("2026-11-21T12:00:00Z");
    const flaky = makeB3Fetch((url, method) => {
      if (url.includes("20261119") && method === "GET") return 500;
      return method === "PUT" ? 201 : 404;
    });
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    let first: { result: string; dropped_days: Array<{ dateStr: string; count: number }> };
    let second: { result: string };
    try {
      first = await bk.pushDailyBackup(flaky.fetchImpl, now);
      expect(first.result).toBe("failed");
      expect(first.result).not.toBe("skipped-empty");
      expect(first.dropped_days).toEqual([]);
      expect(warns.some((w) => w.includes("20261119") && w.includes("500"))).toBe(true);
      expect(flaky.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
      expect(flaky.calls.some((c) => c.method === "PUT" && c.url.includes("20261119"))).toBe(
        false,
      );
      // Next run, healthy: the day is retried and uploaded.
      const healthy = makeB3Fetch(okStatus);
      second = await bk.pushDailyBackup(healthy.fetchImpl, now);
      expect(second.result).toBe("created");
      expect(
        healthy.calls.some((c) => c.method === "PUT" && c.url.includes("20261119")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      instance.close();
      restore();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("R3/F1: pruneSnapshots distinguishes a broken symlink from a missing directory", () => {
    const link = join(tmpDir, "r3-broken-link");
    rmSync(link, { force: true });
    symlinkSync(join(tmpDir, "r3-no-such-target"), link);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      expect(pruneSnapshots(link)).toBe(0);
      expect(
        logs.some(
          (l) => l.includes("path exists but cannot be read") && l.includes(link),
        ),
      ).toBe(true);
      expect(logs.some((l) => l.includes("directory missing"))).toBe(false);
      logs.length = 0;
      // Contrast: a path that really does not exist still says "missing".
      expect(pruneSnapshots(join(tmpDir, "r3-really-missing"))).toBe(0);
      expect(logs.some((l) => l.includes("directory missing"))).toBe(true);
    } finally {
      spy.mockRestore();
      rmSync(link, { force: true });
    }
  });

  it("R3/F5: a snapshot-named directory is skipped, never deleted, never counted as kept", () => {
    const dir = join(tmpDir, "r3-prune-direntry");
    mkdirSync(dir, { recursive: true });
    for (let day = 1; day <= 25; day++) {
      writeFileSync(join(dir, `verireceipt-202601${String(day).padStart(2, "0")}-0000.sqlite`), "fake");
    }
    const dirEntry = join(dir, "verireceipt-20260126-0000.sqlite");
    mkdirSync(dirEntry);
    const warns: string[] = [];
    const errors: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      expect(pruneSnapshots(dir)).toBe(1); // 25 files -> 24; the directory is not a file
      expect(existsSync(dirEntry)).toBe(true);
      expect(statSync(dirEntry).isDirectory()).toBe(true);
      expect(readdirSync(dir).filter((n) => n.startsWith("verireceipt-"))).toHaveLength(25); // 24 files + 1 dir
      expect(
        warns.some(
          (w) =>
            w.includes("skipping 1 snapshot-named director") &&
            w.includes("verireceipt-20260126-0000.sqlite"),
        ),
      ).toBe(true);
      expect(errors.join("\n")).not.toContain("failed to prune");
      // Directory only, no files: no-op, no error, still warned, still there.
      warns.length = 0;
      errors.length = 0;
      const dir2 = join(tmpDir, "r3-prune-dironly");
      mkdirSync(dir2, { recursive: true });
      mkdirSync(join(dir2, "verireceipt-20260101-0000.sqlite"));
      expect(pruneSnapshots(dir2)).toBe(0);
      expect(existsSync(join(dir2, "verireceipt-20260101-0000.sqlite"))).toBe(true);
      expect(warns.some((w) => w.includes("skipping 1 snapshot-named director"))).toBe(true);
      expect(errors.join("\n")).not.toContain("failed to prune");
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("R3/F4: isValidFetchedAt accepts years 0001–0099; saveReceipt accepts a year-0001 receipt", () => {
    expect(isValidFetchedAt("0001-01-01T00:00:00Z")).toBe(true);
    expect(isValidFetchedAt("0099-12-31")).toBe(true);
    expect(isValidFetchedAt("0000-01-01")).toBe(true);
    expect(isValidFetchedAt("0001-02-29")).toBe(false); // 1 is not a leap year
    expect(isValidFetchedAt("0099-02-29")).toBe(false); // 99 is not a leap year
    expect(isValidFetchedAt("0004-02-29")).toBe(true); // 4 is a leap year
    expect(isValidFetchedAt("2026-11-19T10:00:00")).toBe(true); // naive = UTC, still valid
    expect(() =>
      saveReceipt({
        receipt_id: "rcpt_R3YEAR00000000000000001",
        intent: "ONCHAIN_TX",
        upstream_url: "https://example.invalid/u",
        raw_response_sha256: "ab".repeat(32),
        quorum_votes: "2/3",
        fetched_at: "0001-06-15T10:00:00Z",
        audit_url: "",
      }),
    ).not.toThrow();
    const row = getDb()
      .prepare("SELECT fetched_at FROM miner_receipts WHERE receipt_id = ?")
      .get("rcpt_R3YEAR00000000000000001") as { fetched_at: string };
    expect(row.fetched_at).toBe("0001-06-15T10:00:00Z");
  });
});

describe("DB round-4 fixes (R4)", () => {
  // Fresh-module tests use scratch under ~/workspace/db-r4-scratch (NOT
  // /tmp) and remove their own dirs when done.
  const R4_SCRATCH = join(process.env.HOME || tmpdir(), "workspace", "db-r4-scratch", "vitest-tmp");
  function mkR4Dir(name: string): string {
    mkdirSync(R4_SCRATCH, { recursive: true });
    return mkdtempSync(join(R4_SCRATCH, `${name}-`));
  }

  const FAKE_GHP = "ghp_FAKELEAKEDTOKEN1234567890";

  /** Capture console.log + console.warn + console.error into one array. */
  function captureAll(): { out: string[]; restore: () => void } {
    const out: string[] = [];
    const push = (...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(push);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(push);
    const errSpy = vi.spyOn(console, "error").mockImplementation(push);
    return {
      out,
      restore: () => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errSpy.mockRestore();
      },
    };
  }

  /** Build a fresh-module DB with 200 sequential receipts (same shape as the R3 helper). */
  async function buildSeqDb(base: string, prefix: string): Promise<{
    dbPath: string;
    instance: Database.Database;
  }> {
    const dbPath = join(base, `${prefix}.sqlite`);
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    const dbMod = await import("../src/core/db");
    const instance = dbMod.getDb();
    for (let i = 0; i < 200; i++) {
      dbMod.saveReceipt({
        receipt_id: `rcpt_${prefix}${String(i).padStart(4, "0")}0000000000`,
        intent: "ONCHAIN_TX",
        upstream_url: "https://example.invalid/u",
        raw_response_sha256: "ab".repeat(32),
        quorum_votes: "2/3",
        fetched_at: `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T10:00:00Z`,
        audit_url: "",
      });
    }
    const pages = instance.prepare("PRAGMA page_count").get() as { page_count: number };
    expect(pages.page_count).toBeGreaterThanOrEqual(10);
    process.env.SQLITE_PATH = prev;
    return { dbPath, instance };
  }

  /** Build a fresh-module DB with 200 RANDOM receipts (real newReceiptId() shape). */
  async function buildRandomIdDb(base: string, name: string): Promise<{
    dbPath: string;
    instance: Database.Database;
  }> {
    const dbPath = join(base, `${name}.sqlite`);
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    const dbMod = await import("../src/core/db");
    const instance = dbMod.getDb();
    // Seeded LCG (deterministic across runs): ids are rcpt_ + 26 chars
    // from A-Z0-9, exactly the shape newReceiptId() emits.
    // R5/O3: the last 6 chars encode the row counter in base36
    // (zero-padded) — the pure-LCG stream collapsed to ~5,300 unique
    // ids per 20k draws (all seeds tested), so a future 20k-row test
    // built with it would silently seed ~5.3k rows via INSERT OR
    // IGNORE. The first 20 chars stay LCG-random; the suffix
    // guarantees uniqueness while keeping the 26-char shape.
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let seed = 123456789;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 200; i++) {
      let id = "rcpt_";
      for (let j = 0; j < 20; j++) id += ALPHA[Math.floor(rnd() * ALPHA.length)];
      id += i.toString(36).toUpperCase().padStart(6, "0");
      dbMod.saveReceipt({
        receipt_id: id,
        intent: "ONCHAIN_TX",
        upstream_url: "https://example.invalid/u",
        raw_response_sha256: "ab".repeat(32),
        quorum_votes: "2/3",
        fetched_at: `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T10:00:00Z`,
        audit_url: "",
      });
    }
    process.env.SQLITE_PATH = prev;
    return { dbPath, instance };
  }

  interface FreshBackupR4 {
    bk: typeof import("../src/jobs/backup");
    dbMod: typeof import("../src/core/db");
    instance: Database.Database;
    base: string;
    restore: () => void;
  }

  async function freshBackupWithSeedsR4(
    dirName: string,
    seeds: Array<[string, string]>,
  ): Promise<FreshBackupR4> {
    const base = mkR4Dir(dirName);
    const dbPath = join(base, "b4.sqlite");
    const prev = process.env.SQLITE_PATH;
    const prevToken = process.env.BACKUP_GITHUB_TOKEN;
    const prevRepo = process.env.BACKUP_REPO;
    process.env.SQLITE_PATH = dbPath;
    process.env.BACKUP_GITHUB_TOKEN = STUB_TOKEN;
    delete process.env.BACKUP_REPO;
    vi.resetModules();
    const dbMod = await import("../src/core/db");
    const bk = await import("../src/jobs/backup");
    const instance = dbMod.getDb();
    for (const [id, day] of seeds) {
      dbMod.saveReceipt({
        receipt_id: id,
        intent: "ONCHAIN_TX",
        upstream_url: "https://example.invalid/u",
        raw_response_sha256: "ab".repeat(32),
        quorum_votes: "2/3",
        fetched_at: `${day}T10:00:00Z`,
        audit_url: "",
      });
    }
    return {
      bk,
      dbMod,
      instance,
      base,
      restore: () => {
        process.env.SQLITE_PATH = prev;
        if (prevToken === undefined) delete process.env.BACKUP_GITHUB_TOKEN;
        else process.env.BACKUP_GITHUB_TOKEN = prevToken;
        if (prevRepo === undefined) delete process.env.BACKUP_REPO;
        else process.env.BACKUP_REPO = prevRepo;
      },
    };
  }

  it("R4/BLOCKER: PK-autoindex-only corruption is REFUSED (integrity_check catches what quick_check misses)", async () => {
    const base = mkR4Dir("r4-pkidx");
    const { dbPath, instance } = await buildSeqDb(base, "R4PKIX");
    instance.close();
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
    const bytes = readFileSync(dbPath);
    const pageSize = 4096;
    // Row 0's id occurs 3x in the file (table leaf + PK autoindex,
    // plus a stale copy in unallocated space). Flip ONE byte ('P'->'X'
    // at offset 7, so the corrupted value sorts after every rcpt_R4P…
    // id) in EVERY occurrence that sits on an INDEX b-tree page
    // (0x02 leaf / 0x0a interior) — the table copies are never touched.
    const targetId = Buffer.from("rcpt_R4PKIX00000000000000");
    expect(targetId.length).toBe(25);
    const pageTypeAt = (page: number): number =>
      page === 1 ? bytes[100] : bytes[(page - 1) * pageSize];
    let flipped = 0;
    const corrupted = Buffer.from(bytes);
    let from = 0;
    for (;;) {
      const idx = corrupted.indexOf(targetId, from);
      if (idx < 0) break;
      const page = Math.floor(idx / pageSize) + 1;
      const t = pageTypeAt(page);
      if (t === 0x02 || t === 0x0a) {
        corrupted[idx + 7] = "X".charCodeAt(0);
        flipped++;
      }
      from = idx + targetId.length;
    }
    expect(flipped).toBeGreaterThanOrEqual(1);
    writeFileSync(dbPath, corrupted);
    // The OLD boot check would have booted: quick_check says ok.
    // integrity_check refuses: "row 1 missing from index …".
    const probe = new Database(dbPath, { readonly: true });
    const qc = probe.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    expect(qc).toEqual([{ quick_check: "ok" }]);
    const ic = probe.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    expect(ic.some((r) => r.integrity_check.includes("missing from index"))).toBe(true);
    // The TABLE copy is intact: a forced table scan still finds all
    // 200 rows including row 0's original id.
    const scanned = probe.prepare("SELECT receipt_id FROM miner_receipts NOT INDEXED").all() as Array<{
      receipt_id: string;
    }>;
    expect(scanned).toHaveLength(200);
    expect(scanned.some((r) => r.receipt_id === "rcpt_R4PKIX00000000000000")).toBe(true);
    // …but the index is corrupt, so the exact damage is visible: a PK
    // lookup misses the persisted row, and INSERT OR IGNORE with that
    // same existing id INSERTS a duplicate (200 -> 201). Probed on a
    // COPY so the refusal assertion below sees the pristine corrupt file.
    const copyPath = join(base, "copy.sqlite");
    writeFileSync(copyPath, corrupted);
    const copy = new Database(copyPath);
    expect(
      copy
        .prepare("SELECT receipt_id FROM miner_receipts WHERE receipt_id = ?")
        .get("rcpt_R4PKIX00000000000000"),
    ).toBeUndefined();
    const before = (
      copy.prepare("SELECT COUNT(*) AS n FROM miner_receipts NOT INDEXED").get() as {
        n: number;
      }
    ).n;
    copy
      .prepare(
        "INSERT OR IGNORE INTO miner_receipts (receipt_id, intent, upstream_url, raw_response_sha256, fetched_at) VALUES (?,?,?,?,?)",
      )
      .run(
        "rcpt_R4PKIX00000000000000",
        "ONCHAIN_TX",
        "https://example.invalid/u",
        "ab".repeat(32),
        "2026-11-01T10:00:00Z",
      );
    const after = (
      copy.prepare("SELECT COUNT(*) AS n FROM miner_receipts NOT INDEXED").get() as {
        n: number;
      }
    ).n;
    expect(before).toBe(200);
    expect(after).toBe(201);
    copy.close();
    probe.close();

    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    const cap = captureAll();
    let message = "";
    try {
      const fresh = await import("../src/core/db");
      try {
        fresh.getDb();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
    } finally {
      cap.restore();
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
    expect(message).toMatch(/verireceipt: refusing to open SQLite DB at .*integrity check failed/);
    expect(message).toContain("missing from index");
    expect(message).not.toContain("SqliteError");
    // The refusal is LOGGED, not just thrown.
    expect(cap.out.join("\n")).toContain("integrity check failed");
  });

  it("R4/BLOCKER: HONEST LIMIT (narrowed) — a random-id order-preserving both-copies flip passes ANY boot check and boots", async () => {
    const base = mkR4Dir("r4-v6-rand");
    const { dbPath, instance } = await buildRandomIdDb(base, "R4V6R");
    instance.close();
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
    // Read the ids back in index order and find a flip that keeps the
    // corrupted value strictly between its sorted neighbours, so the
    // index stays consistent: the row is still exactly where the index
    // says it is, with a different payload byte.
    const reader = new Database(dbPath, { readonly: true });
    const sorted = (
      reader.prepare("SELECT receipt_id FROM miner_receipts ORDER BY receipt_id").all() as Array<{
        receipt_id: string;
      }>
    ).map((r) => r.receipt_id);
    reader.close();
    expect(sorted).toHaveLength(200);
    function findOrderPreservingFlip(
      ids: string[],
    ): { id: string; pos: number; cand: string } | null {
      for (let i = 1; i < ids.length - 1; i++) {
        const id = ids[i];
        for (let pos = 5; pos < id.length; pos++) {
          for (const delta of [1, -1, 2, -2]) {
            const ch = id.charCodeAt(pos) + delta;
            const ok = (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90);
            if (!ok) continue;
            const cand = id.slice(0, pos) + String.fromCharCode(ch) + id.slice(pos + 1);
            if (cand > ids[i - 1] && cand < ids[i + 1] && cand !== id) {
              return { id, pos, cand };
            }
          }
        }
      }
      return null;
    }
    const flip = findOrderPreservingFlip(sorted);
    expect(flip).not.toBeNull();
    const { id, pos, cand } = flip as { id: string; pos: number; cand: string };
    const bytes = readFileSync(dbPath);
    const corrupted = Buffer.from(bytes);
    let occurrences = 0;
    let from = 0;
    for (;;) {
      const idx = corrupted.indexOf(Buffer.from(id), from);
      if (idx < 0) break;
      corrupted[idx + pos] = cand.charCodeAt(pos);
      occurrences++;
      from = idx + id.length;
    }
    expect(occurrences).toBeGreaterThanOrEqual(2); // table + index copies
    writeFileSync(dbPath, corrupted);
    // BOTH boot checks pass: this is the true uncatchable class.
    const probe = new Database(dbPath, { readonly: true });
    expect(probe.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
    expect(probe.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    probe.close();

    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    try {
      const fresh = await import("../src/core/db");
      const db = fresh.getDb(); // boots: no boot check can catch this
      const row = db
        .prepare("SELECT receipt_id FROM miner_receipts WHERE receipt_id = ?")
        .get(cand) as { receipt_id: string } | undefined;
      expect(row?.receipt_id).toBe(cand);
      const n = db.prepare("SELECT COUNT(*) AS n FROM miner_receipts").get() as { n: number };
      expect(n.n).toBe(200);
      db.close();
    } finally {
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("R4/BLOCKER: HONEST LIMIT (narrowed) — truncation zero-fill (last 100 bytes) passes ANY boot check and boots", async () => {
    const base = mkR4Dir("r4-v6-zero");
    const { dbPath, instance } = await buildSeqDb(base, "R4ZFIL");
    instance.close();
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
    const bytes = readFileSync(dbPath);
    const corrupted = Buffer.from(bytes);
    corrupted.fill(0, corrupted.length - 100, corrupted.length);
    writeFileSync(dbPath, corrupted);
    // BOTH boot checks pass — the damage is inside a stored value, in
    // a non-indexed column, so no structure or index check sees it.
    const probe = new Database(dbPath, { readonly: true });
    expect(probe.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
    expect(probe.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    probe.close();

    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    try {
      const fresh = await import("../src/core/db");
      const db = fresh.getDb(); // boots
      const rows = db
        .prepare("SELECT receipt_id, fetched_at FROM miner_receipts")
        .all() as Array<{ receipt_id: string; fetched_at: string }>;
      expect(rows).toHaveLength(200);
      // The damage is REAL, not vacuous: one row's fetched_at is 20 NULs.
      expect(rows.some((r) => r.fetched_at === "\0".repeat(20))).toBe(true);
      db.close();
    } finally {
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("R4/MINOR-1: getDb() trailing-slash refusal is LOGGED (console.error, redacted) as well as thrown", async () => {
    const base = mkR4Dir("r4-slash");
    const tokenDir = join(base, FAKE_GHP);
    mkdirSync(tokenDir, { recursive: true });
    const slashPath = join(tokenDir, "db.sqlite") + "/";
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = slashPath;
    vi.resetModules();
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    let message = "";
    try {
      const fresh = await import("../src/core/db");
      try {
        fresh.getDb();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
    } finally {
      errSpy.mockRestore();
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
    // The throw itself (unchanged guard format).
    expect(message).toMatch(/verireceipt: refusing to open SQLite DB at .*trailing slash/);
    expect(message).not.toContain("SqliteError");
    // …AND a console.error line from getDb() itself naming the refusal.
    // Before this fix the throw left ZERO console.error lines: the
    // check fired before the try/catch that logs assertDiskReady
    // refusals. The path carries a fake token, so the line must be
    // redacted.
    expect(errors.some((e) => e.includes("trailing slash"))).toBe(true);
    expect(
      errors.some(
        (e) => e.includes("refusing to open SQLite DB") && e.includes("trailing slash"),
      ),
    ).toBe(true);
    const joined = errors.join("\n");
    expect(joined).toContain("[REDACTED]");
    expect(joined).not.toContain(FAKE_GHP);
  });

  it("R4/MINOR-2: no-token run with an aged-out day still detects it (dropped_days + warning, 0 fetch calls)", async () => {
    const { bk, instance, base, restore } = await freshBackupWithSeedsR4("r4-notoken", [
      ["rcpt_R4NT130000000000000001", "2026-11-13"],
      ["rcpt_R4NT200000000000000001", "2026-11-20"],
    ]);
    const now = new Date("2026-11-21T12:00:00Z");
    delete process.env.BACKUP_GITHUB_TOKEN; // the run backs up NOTHING
    const { calls, fetchImpl } = makeStubFetch([404, 201]);
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    let summary: { result: string; dropped_days: Array<{ dateStr: string; count: number }> };
    try {
      summary = await bk.pushDailyBackup(fetchImpl, now);
    } finally {
      warnSpy.mockRestore();
      instance.close();
      restore();
      rmSync(base, { recursive: true, force: true });
    }
    expect(summary.result).toBe("skipped-no-token"); // result string unchanged
    expect(summary.dropped_days).toEqual([{ dateStr: "20261113", count: 1 }]);
    expect(calls).toHaveLength(0);
    const joined = warns.join("\n");
    expect(joined).toContain(
      "day 2026-11-13 has 1 receipts but is outside the 7-day window, NOT backed up",
    );
    expect(joined).toContain("20261113");
    expect(joined).toContain("BACKUP_GITHUB_TOKEN is not set");
  });

  it("R4/MINOR-2: bad-repo run with an aged-out day still detects it (failed + dropped_days, 0 fetch calls)", async () => {
    const { bk, instance, base, restore } = await freshBackupWithSeedsR4("r4-badrepo", [
      ["rcpt_R4BR130000000000000001", "2026-11-13"],
      ["rcpt_R4BR200000000000000001", "2026-11-20"],
    ]);
    const now = new Date("2026-11-21T12:00:00Z");
    process.env.BACKUP_REPO = "not-a-valid-repo"; // no owner/repo slash
    const { calls, fetchImpl } = makeStubFetch([404, 201]);
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    let summary: { result: string; dropped_days: Array<{ dateStr: string; count: number }> };
    try {
      summary = await bk.pushDailyBackup(fetchImpl, now);
    } finally {
      warnSpy.mockRestore();
      instance.close();
      restore();
      rmSync(base, { recursive: true, force: true });
    }
    expect(summary.result).toBe("failed"); // result string unchanged
    expect(summary.dropped_days).toEqual([{ dateStr: "20261113", count: 1 }]);
    expect(calls).toHaveLength(0);
    const joined = warns.join("\n");
    expect(joined).toContain(
      "day 2026-11-13 has 1 receipts but is outside the 7-day window, NOT backed up",
    );
    expect(joined).toContain("20261113");
  });

  it("R4/M3 (observation): a concurrent second call with DIFFERENT args still receives the first run's summary", async () => {
    const { bk, instance, base, restore } = await freshBackupWithSeedsR4("r4-conc-args", [
      ["rcpt_R4CA200000000000000001", "2026-11-20"],
      ["rcpt_R4CA240000000000000001", "2026-11-24"],
    ]);
    const { calls, fetchImpl } = makeStubFetch([404, 201]);
    let s1: unknown;
    let s2: unknown;
    try {
      const p1 = bk.pushDailyBackup(fetchImpl, new Date("2026-11-21T12:00:00Z"));
      // Different `now`: if this ran on its own it would PUT 20261124.
      const p2 = bk.pushDailyBackup(fetchImpl, new Date("2026-11-25T12:00:00Z"));
      [s1, s2] = await Promise.all([p1, p2]);
    } finally {
      instance.close();
      restore();
      rmSync(base, { recursive: true, force: true });
    }
    expect(s1).toBe(s2); // same in-flight run, same summary object
    expect((s1 as { result: string }).result).toBe("created");
    // Only the FIRST window's PUTs happen: 20261120 uploaded, 20261124 never fetched.
    expect(calls.filter((c) => c.init?.method === "PUT")).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("20261120"))).toBe(true);
    expect(calls.some((c) => c.url.includes("20261124"))).toBe(false);
  });

  it("R4/MINOR-3: redactor rejoins indented / blank-line / Bearer-tail token splits", () => {
    // Indented continuation line: both fragments used to leak verbatim.
    expect(redactSecrets("leak ghp_FAKELEAKED\n    TOKEN1234567890 end")).toBe(
      "leak [REDACTED] end",
    );
    // Blank line between the fragments.
    expect(redactSecrets("leak ghp_FAKELEAKED\n\nTOKEN1234567890 end")).toBe(
      "leak [REDACTED] end",
    );
    // Newline + single space.
    expect(redactSecrets("leak ghp_FAKELEAKED\n TOKEN1234567890 end")).toBe(
      "leak [REDACTED] end",
    );
    // CRLF + indentation.
    expect(redactSecrets("leak ghp_FAKELEAKED\r\n    TOKEN1234567890 end")).toBe(
      "leak [REDACTED] end",
    );
    // Bearer tail split: the Bearer token is rejoined first, so the
    // whole token is redacted — the tail used to leak after
    // "Bearer [REDACTED]".
    const bearer = redactSecrets(
      "upstream echoed Authorization: Bearer ghp_FAKELEAKED\n    TOKEN1234567890 end",
    );
    expect(bearer).toContain("Bearer [REDACTED]");
    expect(bearer).not.toContain("FAKELEAKED");
    expect(bearer).not.toContain("TOKEN1234567890");
    // Split AFTER a hyphen: a wrapped hyphenated configured token
    // rejoins and is caught exactly via extraSecrets.
    expect(
      redactSecrets("token=my-configured-token-\nXYZ-abcdef here", [
        "my-configured-token-XYZ-abcdef",
      ]),
    ).toBe("token=[REDACTED] here");
    // A break next to a non-token character is still kept (no flattening).
    expect(redactSecrets("error:\nline two")).toBe("error:\nline two");
    // The old single-newline cases still work.
    expect(redactSecrets("leak ghp_FAKELEAKED\nTOKEN1234567890 end")).toBe(
      "leak [REDACTED] end",
    );
    expect(redactSecrets("line one\nline two")).toBe("line oneline two");
  });

  it("R4/MINOR-3: hyphenated bare token — PINNED residual (first run redacted, tail visible)", () => {
    // Real issuer tokens contain no hyphens, so this shape does not
    // occur for a real token; the matcher is deliberately NOT
    // contorted for it (see the redactSecrets docstring). Pinned so a
    // future change to the behaviour is a conscious decision.
    expect(redactSecrets("leak ghp_ABCDEFGHIJKLMNOP-QRSTUVWXYZ234567 end")).toBe(
      "leak [REDACTED]-QRSTUVWXYZ234567 end",
    );
  });
});

describe("DB round-5 fixes (R5)", () => {
  // Fresh-module tests use scratch under ~/workspace/db-r5-scratch (NOT
  // /tmp) and remove their own dirs when done (per-test dirs in each
  // test's finally; the shared pristine fixture in afterAll).
  const R5_SCRATCH = join(process.env.HOME || tmpdir(), "workspace", "db-r5-scratch", "vitest-tmp");
  function mkR5Dir(name: string): string {
    mkdirSync(R5_SCRATCH, { recursive: true });
    return mkdtempSync(join(R5_SCRATCH, `${name}-`));
  }

  const FAKE_GHP = "ghp_FAKELEAKEDTOKEN1234567890";

  /** Capture console.log + console.warn + console.error into one array. */
  function captureAll(): { out: string[]; restore: () => void } {
    const out: string[] = [];
    const push = (...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(push);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(push);
    const errSpy = vi.spyOn(console, "error").mockImplementation(push);
    return {
      out,
      restore: () => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errSpy.mockRestore();
      },
    };
  }

  interface PristineWal {
    /** Pristine copy dir (removed in afterAll). */
    base: string;
    /** Main DB file whose rows live ONLY in the WAL (no table in the file alone). */
    dbPath: string;
    /** The unclean-exit WAL (50 committed receipts, ~449 KB). */
    walPath: string;
    /** First 32 bytes of the WAL (a real, valid WAL header). */
    header: Buffer;
  }

  let pristine: PristineWal | null = null;

  /**
   * Build the shared WAL fixture ONCE: 50 receipts via a fresh module's
   * getDb()+saveReceipt(), then copy the .sqlite + -wal files to a
   * pristine dir WITHOUT closing the source (closing would checkpoint
   * the WAL into the main file and delete it — the crash-without-close
   * shape J2 reproduced). Proves the rows live only in the WAL by
   * opening the main file alone (no -wal): it has no miner_receipts
   * table at all. Each test copies from pristine and mutates its own
   * copy, so tests stay independent.
   */
  async function buildPristineWal(): Promise<PristineWal> {
    const base = mkR5Dir("r5-pristine");
    const srcDir = join(base, "src");
    mkdirSync(srcDir, { recursive: true });
    const srcDb = join(srcDir, "src.sqlite");
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = srcDb;
    vi.resetModules();
    const dbMod = await import("../src/core/db");
    const instance = dbMod.getDb();
    for (let i = 0; i < 50; i++) {
      dbMod.saveReceipt({
        receipt_id: `rcpt_R5WAL${String(i).padStart(4, "0")}00000000000000`,
        intent: "ONCHAIN_TX",
        upstream_url: "https://example.invalid/u",
        raw_response_sha256: "ab".repeat(32),
        quorum_votes: "2/3",
        fetched_at: "2026-11-20T10:00:00Z",
        audit_url: "",
      });
    }
    const walBytes = readFileSync(srcDb + "-wal");
    expect(walBytes.length).toBeGreaterThan(100000);
    const dir = join(base, "pristine");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "c.sqlite");
    const walPath = dbPath + "-wal";
    writeFileSync(dbPath, readFileSync(srcDb));
    writeFileSync(walPath, walBytes);
    const header = Buffer.from(walBytes.subarray(0, 32));
    // Prove the fixture shape: the main file alone has no table —
    // every row lives only in the WAL.
    const alonePath = join(dir, "alone.sqlite");
    writeFileSync(alonePath, readFileSync(srcDb));
    const alone = new Database(alonePath, { readonly: true });
    try {
      expect(() =>
        alone.prepare("SELECT COUNT(*) FROM miner_receipts").get(),
      ).toThrow(/no such table/);
    } finally {
      alone.close();
      rmSync(alonePath, { force: true });
    }
    instance.close(); // checkpoints the SOURCE only; the pristine copy is untouched
    process.env.SQLITE_PATH = prev;
    return { base, dbPath, walPath, header };
  }

  beforeAll(async () => {
    pristine = await buildPristineWal();
  });

  afterAll(() => {
    if (pristine) rmSync(pristine.base, { recursive: true, force: true });
  });

  /** Copy the pristine WAL fixture to a case dir; optionally mutate the copy. */
  function caseCopy(
    name: string,
    mutate?: (dbPath: string, walPath: string) => void,
  ): { dir: string; dbPath: string; walPath: string } {
    const dir = mkR5Dir(name);
    const dbPath = join(dir, "c.sqlite");
    const walPath = dbPath + "-wal";
    writeFileSync(dbPath, readFileSync((pristine as PristineWal).dbPath));
    writeFileSync(walPath, readFileSync((pristine as PristineWal).walPath));
    if (mutate) mutate(dbPath, walPath);
    return { dir, dbPath, walPath };
  }

  /** Boot a DB copy in a fresh module; capture all console output. */
  async function bootFresh(dbPath: string): Promise<{
    message: string;
    count: number | null;
    logs: string;
  }> {
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    const cap = captureAll();
    let message = "";
    let count: number | null = null;
    try {
      const fresh = await import("../src/core/db");
      try {
        const db = fresh.getDb();
        try {
          count = (db.prepare("SELECT COUNT(*) AS n FROM miner_receipts").get() as {
            n: number;
          }).n;
        } finally {
          db.close();
        }
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
    } finally {
      cap.restore();
      process.env.SQLITE_PATH = prev;
    }
    return { message, count, logs: cap.out.join("\n") };
  }

  it("R5/BLOCKER-1: mid-WAL flip refuses to boot (guard format, logged, no 'db ready')", async () => {
    // J2's repro, exact: the middle byte of the WAL flipped. Pre-fix
    // this booted "healthy" with 24/50 receipts, silently dropping the
    // last 26 committed rows (only "db ready" logged).
    const { dir, dbPath } = caseCopy("r5-midflip", (_db, wal) => {
      const b = readFileSync(wal);
      b[Math.floor(b.length / 2)] ^= 0xff;
      writeFileSync(wal, b);
    });
    let out: { message: string; count: number | null; logs: string };
    try {
      out = await bootFresh(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(out.count).toBeNull();
    expect(out.message).toMatch(
      /verireceipt: refusing to open SQLite DB at .*WAL validation failed/,
    );
    expect(out.message).toMatch(/bad frame \d+ \((checksum|salt) mismatch\)/);
    expect(out.message).not.toContain("SqliteError");
    // The refusal is LOGGED, not just thrown …
    expect(out.logs).toContain("WAL validation failed");
    // … the disk guard ran first ("disk ready" is honest) …
    expect(out.logs).toContain("disk ready");
    // … but NO "db ready" line may appear before the refusal (MINOR-3).
    expect(out.logs).not.toContain("db ready");
  });

  it("R5/BLOCKER-1: first-frame flip (offset 40) refuses to boot", async () => {
    // J2's repro, exact: offset 40 is salt-1 of frame 1. Pre-fix this
    // booted "healthy" with 0/50 receipts — the entire table silently
    // empty, schema intact, integrity_check passing.
    const { dir, dbPath } = caseCopy("r5-firstframe", (_db, wal) => {
      const b = readFileSync(wal);
      b[40] ^= 0xff;
      writeFileSync(wal, b);
    });
    let out: { message: string; count: number | null; logs: string };
    try {
      out = await bootFresh(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(out.count).toBeNull();
    expect(out.message).toMatch(
      /verireceipt: refusing to open SQLite DB at .*WAL validation failed/,
    );
    expect(out.message).toMatch(/bad frame 0 \(salt mismatch\)/);
    expect(out.message).not.toContain("SqliteError");
    expect(out.logs).toContain("WAL validation failed");
    expect(out.logs).toContain("disk ready");
    expect(out.logs).not.toContain("db ready");
  });

  it("R5/BLOCKER-1: healthy WAL (50 committed rows, unclean exit) boots with all 50", async () => {
    const { dir, dbPath } = caseCopy("r5-healthy");
    let out: { message: string; count: number | null; logs: string };
    try {
      out = await bootFresh(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(out.message).toBe("");
    expect(out.count).toBe(50);
    expect(out.logs).toContain("db ready");
    expect(out.logs).not.toContain("WAL warning");
  });

  it("R5/BLOCKER-1: torn tail (bad frame AFTER the last commit frame) boots with a warning", async () => {
    // Append a garbage frame after the last commit frame: bad salt +
    // bad checksum AND a nonzero commit-size field (0xaaaaaaaa) — the
    // salt discriminator must ignore that commit-size (stale/garbage
    // frame, not a commit frame of this generation) and allow the boot.
    // This is the crashed-mid-write shape: the frames are uncommitted,
    // losing them loses nothing, and SQLite truncates them.
    const { dir, dbPath } = caseCopy("r5-torntail", (_db, wal) => {
      writeFileSync(wal, Buffer.concat([readFileSync(wal), Buffer.alloc(24 + 4096, 0xaa)]));
    });
    let out: { message: string; count: number | null; logs: string };
    try {
      out = await bootFresh(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(out.message).toBe("");
    expect(out.count).toBe(50);
    expect(out.logs).toContain("WAL warning");
    expect(out.logs).toContain("uncommitted tail");
    expect(out.logs).toContain("db ready");
  });

  it("R5/BLOCKER-1: no WAL file boots normally", async () => {
    // Checkpointed DB (rows in the main file, clean close deletes the WAL).
    const base = mkR5Dir("r5-nowal");
    const dbPath = join(base, "n.sqlite");
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    try {
      const dbMod = await import("../src/core/db");
      const instance = dbMod.getDb();
      for (let i = 0; i < 5; i++) {
        dbMod.saveReceipt({
          receipt_id: `rcpt_R5NOWAL${String(i).padStart(4, "0")}0000000000000`,
          intent: "ONCHAIN_TX",
          upstream_url: "https://example.invalid/u",
          raw_response_sha256: "ab".repeat(32),
          quorum_votes: "2/3",
          fetched_at: "2026-11-20T10:00:00Z",
          audit_url: "",
        });
      }
      instance.close();
    } finally {
      process.env.SQLITE_PATH = prev;
    }
    expect(existsSync(dbPath + "-wal")).toBe(false);
    let out: { message: string; count: number | null; logs: string };
    try {
      out = await bootFresh(dbPath);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    expect(out.message).toBe("");
    expect(out.count).toBe(5);
    expect(out.logs).toContain("db ready");
  });

  it("R5/BLOCKER-1: header-only WAL boots normally", async () => {
    // Checkpointed DB (rows in the main file) + a real 32-byte WAL
    // header (zero frames) placed next to it.
    const base = mkR5Dir("r5-headeronly");
    const dbPath = join(base, "h.sqlite");
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    try {
      const dbMod = await import("../src/core/db");
      const instance = dbMod.getDb();
      dbMod.saveReceipt({
        receipt_id: "rcpt_R5HDRONLY000000000000001",
        intent: "ONCHAIN_TX",
        upstream_url: "https://example.invalid/u",
        raw_response_sha256: "ab".repeat(32),
        quorum_votes: "2/3",
        fetched_at: "2026-11-20T10:00:00Z",
        audit_url: "",
      });
      instance.close();
    } finally {
      process.env.SQLITE_PATH = prev;
    }
    writeFileSync(dbPath + "-wal", (pristine as PristineWal).header);
    let out: { message: string; count: number | null; logs: string };
    try {
      out = await bootFresh(dbPath);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    expect(out.message).toBe("");
    expect(out.count).toBe(1);
    expect(out.logs).toContain("db ready");
    expect(out.logs).not.toContain("WAL warning");
  });

  // --- validateWalBuffer unit tests (synthetic WALs) ---------------------

  /** Independent checksum implementation (test-side; same algorithm). */
  function testWalCksum(
    littleEndian: boolean,
    buf: Buffer,
    off: number,
    len: number,
    s1: number,
    s2: number,
  ): [number, number] {
    for (let i = off; i < off + len; i += 8) {
      const x0 = littleEndian ? buf.readUInt32LE(i) : buf.readUInt32BE(i);
      const x1 = littleEndian ? buf.readUInt32LE(i + 4) : buf.readUInt32BE(i + 4);
      s1 = (s1 + x0 + s2) >>> 0;
      s2 = (s2 + x1 + s1) >>> 0;
    }
    return [s1, s2];
  }

  type TestFrameSpec = {
    commitSize: number;
    corrupt?: "checksum" | "salt" | "commitSizeZero" | "stale";
  };

  /**
   * Build a synthetic WAL in-test (512-byte pages keep the buffer
   * tiny). `corrupt` simulates one flipped frame, applied to the
   * STORED bytes only — the checksum chain advances from the writer's
   * (correct) values, exactly as a post-write bit flip behaves.
   */
  function buildTestWal(frames: TestFrameSpec[]): Buffer {
    const pageSize = 512;
    const salt: [number, number] = [0x11111111, 0x22222222];
    const header = Buffer.alloc(32);
    header.writeUInt32BE(0x377f0682, 0); // little-endian checksums
    header.writeUInt32BE(3007000, 4);
    header.writeUInt32BE(pageSize, 8);
    header.writeUInt32BE(0, 12);
    header.writeUInt32BE(salt[0], 16);
    header.writeUInt32BE(salt[1], 20);
    let [h1, h2] = testWalCksum(true, header, 0, 24, 0, 0);
    header.writeUInt32BE(h1, 24);
    header.writeUInt32BE(h2, 28);
    let [s1, s2] = [h1, h2];
    const parts: Buffer[] = [header];
    frames.forEach((f, i) => {
      const fh = Buffer.alloc(24);
      fh.writeUInt32BE(i + 1, 0);
      fh.writeUInt32BE(f.commitSize, 4);
      fh.writeUInt32BE(salt[0], 8);
      fh.writeUInt32BE(salt[1], 12);
      const page = Buffer.alloc(pageSize, 0x41 + i);
      let [c1, c2] = testWalCksum(true, fh, 0, 8, s1, s2);
      [c1, c2] = testWalCksum(true, page, 0, pageSize, c1, c2);
      s1 = c1;
      s2 = c2; // chain advances from the writer's values
      let stored1 = c1;
      const stored2 = c2;
      // NOTE: `^` yields a SIGNED 32-bit int in JS — `>>> 0` keeps the
      // stored checksum an unsigned u32 for writeUInt32BE.
      if (f.corrupt === "checksum") stored1 = (stored1 ^ 0xff) >>> 0;
      if (f.corrupt === "salt") fh.writeUInt32BE(salt[0] ^ 0xff, 8);
      if (f.corrupt === "commitSizeZero") fh.writeUInt32BE(0, 4);
      if (f.corrupt === "stale") {
        fh.writeUInt32BE(0x99999999, 8); // old-generation salt …
        stored1 = (stored1 ^ 0xff) >>> 0; // … and a checksum from the old chain (bad here)
      }
      fh.writeUInt32BE(stored1, 16);
      fh.writeUInt32BE(stored2, 20);
      parts.push(fh, page);
    });
    return Buffer.concat(parts);
  }

  it("R5/BLOCKER-1 (unit): healthy synthetic WAL validates (frames + last commit)", () => {
    const wal = buildTestWal([
      { commitSize: 0 },
      { commitSize: 5 },
      { commitSize: 0 },
      { commitSize: 9 },
    ]);
    const r = validateWalBuffer(wal, 512);
    expect(r.status).toBe("ok");
    expect(r.frames).toBe(4);
    expect(r.lastCommitFrame).toBe(3);
  });

  it("R5/BLOCKER-1 (unit): bad header (magic / version / page size / checksum) refuses", () => {
    const good = buildTestWal([{ commitSize: 5 }]);
    const badMagic = Buffer.from(good);
    badMagic[0] ^= 0xff;
    expect(validateWalBuffer(badMagic, 512).status).toBe("refuse");
    expect(validateWalBuffer(badMagic, 512).reason).toMatch(/header magic/);
    const badVersion = Buffer.from(good);
    badVersion.writeUInt32BE(9999999, 4);
    expect(validateWalBuffer(badVersion, 512).status).toBe("refuse");
    expect(validateWalBuffer(badVersion, 512).reason).toMatch(/header version/);
    const badPageSize = Buffer.from(good);
    badPageSize.writeUInt32BE(1000, 8); // not a power of two
    expect(validateWalBuffer(badPageSize, 512).status).toBe("refuse");
    expect(validateWalBuffer(badPageSize, 512).reason).toMatch(/page size/);
    const badCksum = Buffer.from(good);
    badCksum[24] ^= 0xff;
    expect(validateWalBuffer(badCksum, 512).status).toBe("refuse");
    expect(validateWalBuffer(badCksum, 512).reason).toMatch(/header checksum/);
    // A power-of-two page size that disagrees with the DB file's page
    // size refuses too (cross-check kills a flip in the field alone).
    expect(validateWalBuffer(good, 4096).status).toBe("refuse");
    expect(validateWalBuffer(good, 4096).reason).toMatch(
      /disagrees with the database file page size/,
    );
  });

  it("R5/BLOCKER-1 (unit): bad frame before the last commit frame refuses", () => {
    const wal = buildTestWal([
      { commitSize: 5 },
      { commitSize: 0, corrupt: "checksum" },
      { commitSize: 9 },
    ]);
    const r = validateWalBuffer(wal, 512);
    expect(r.status).toBe("refuse");
    expect(r.reason).toMatch(/bad frame 1 \(checksum mismatch\)/);
    expect(r.reason).toMatch(/later commit frame 2 would be lost/);
  });

  it("R5/BLOCKER-1 (unit): bad frame that IS a commit frame refuses", () => {
    const wal = buildTestWal([
      { commitSize: 5 },
      { commitSize: 9, corrupt: "checksum" },
    ]);
    const r = validateWalBuffer(wal, 512);
    expect(r.status).toBe("refuse");
    expect(r.reason).toMatch(/bad frame 1 \(checksum mismatch\)/);
    expect(r.reason).toMatch(/the frame is itself a commit frame/);
  });

  it("R5/BLOCKER-1 (unit): bad frame after the last commit frame warns (uncommitted tail)", () => {
    const wal = buildTestWal([
      { commitSize: 5 },
      { commitSize: 0, corrupt: "checksum" },
    ]);
    const r = validateWalBuffer(wal, 512);
    expect(r.status).toBe("warn");
    expect(r.reason).toMatch(/bad frame 1 \(checksum mismatch\) after last commit frame 0/);
    expect(r.reason).toMatch(/uncommitted tail/);
  });

  it("R5/BLOCKER-1 (unit): stale frame (old salt + bad checksum) after the last commit warns, not refuses", () => {
    // Post-checkpoint WAL reuse leaves old-generation frames past the
    // new valid prefix. Their salts mismatch AND their checksums are
    // bad under the new chain, so the commit-size field must be
    // ignored — refusing here would break routine crash recovery.
    const wal = buildTestWal([{ commitSize: 5 }, { commitSize: 9, corrupt: "stale" }]);
    const r = validateWalBuffer(wal, 512);
    expect(r.status).toBe("warn");
    expect(r.reason).toMatch(/bad frame 1 \(salt mismatch\) after last commit frame 0/);
  });

  it("R5/BLOCKER-1 (unit): salt-flipped LAST commit frame refuses (checksum still valid)", () => {
    // The frame checksum does NOT cover the salt bytes, so a
    // salt-mismatched frame with a VALID checksum is a
    // current-generation frame whose salt bytes were flipped: its
    // commit-size field can be trusted, and it is a commit frame.
    const wal = buildTestWal([
      { commitSize: 5 },
      { commitSize: 9, corrupt: "salt" },
    ]);
    const r = validateWalBuffer(wal, 512);
    expect(r.status).toBe("refuse");
    expect(r.reason).toMatch(/bad frame 1 \(salt mismatch\)/);
    expect(r.reason).toMatch(/the frame is itself a commit frame/);
  });

  it("R5/BLOCKER-1 (unit): truncated final frame, empty, header-only, and short WALs", () => {
    const wal = buildTestWal([{ commitSize: 5 }, { commitSize: 9 }]);
    const truncated = Buffer.from(wal.subarray(0, wal.length - 200));
    const r = validateWalBuffer(truncated, 512);
    expect(r.status).toBe("warn");
    expect(r.reason).toMatch(/frame 1 is truncated/);
    expect(validateWalBuffer(Buffer.alloc(0), 512).status).toBe("ok");
    const headerOnly = Buffer.from(wal.subarray(0, 32));
    const h = validateWalBuffer(headerOnly, 512);
    expect(h.status).toBe("ok");
    expect(h.frames).toBe(0);
    expect(h.lastCommitFrame).toBe(-1);
    const short = validateWalBuffer(Buffer.from(wal.subarray(0, 10)), 512);
    expect(short.status).toBe("warn");
    expect(short.reason).toMatch(/shorter than the 32-byte WAL header/);
    // A WAL that ends mid-frame-header warns too.
    const midHeader = Buffer.from(wal.subarray(0, 32 + 24 + 512 + 10));
    expect(validateWalBuffer(midHeader, 512).status).toBe("warn");
  });

  it("R5/BLOCKER-1 (unit): commit-size zeroed on the last commit frame warns — PINNED residual hole", () => {
    // A flip that zeroes the commit-size field of the LAST commit
    // frame fools the scan: the frame then looks like a non-commit
    // frame after the last commit. It needs the flip to land in those
    // 4 bytes AND produce exactly 0 (any other value still reads as a
    // commit frame and refuses). Pinned so a future change to the
    // behaviour is a conscious decision.
    const wal = buildTestWal([
      { commitSize: 5 },
      { commitSize: 9, corrupt: "commitSizeZero" },
    ]);
    const r = validateWalBuffer(wal, 512);
    expect(r.status).toBe("warn");
    expect(r.reason).toMatch(/bad frame 1 \(checksum mismatch\) after last commit frame 0/);
  });

  it("R5/BLOCKER-1 (unit): assertWalValid refuses an unreadable WAL (non-ENOENT) in guard format", () => {
    const base = mkR5Dir("r5-waldir");
    const dbPath = join(base, "w.sqlite");
    mkdirSync(dbPath + "-wal", { recursive: true }); // a directory, not a file
    try {
      expect(() => assertWalValid(dbPath)).toThrow(
        /verireceipt: refusing to open SQLite DB at .*cannot read WAL file/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    // A missing WAL file boots normally (no throw).
    expect(() => assertWalValid(join(base, "nope.sqlite"))).not.toThrow();
  });

  it("R5/MINOR-2: a 1-char fragment between breaks is fully redacted (fixpoint loop is load-bearing)", () => {
    // Single-pass replace consumes the lone "T" as group 2 of the
    // first match, so the second break has no preceding token char
    // left to match — removing the while-fixpoint loop leaks the token
    // verbatim (mutant (f): suite identical to baseline without this
    // test). The loop repeats until fixpoint so the token rejoins
    // fully and the ghp_ pattern catches it.
    expect(redactSecrets("leak ghp_FAKELEAKED\nT\nOKEN1234567890 end")).toBe(
      "leak [REDACTED] end",
    );
    // Second shape: the same 1-char fragment with CRLF breaks.
    expect(redactSecrets("leak ghp_FAKELEAKED\r\nT\r\nOKEN1234567890 end")).toBe(
      "leak [REDACTED] end",
    );
  });

  it("R5/MINOR-3: a refused boot logs NO 'db ready' line before the refusal (integrity path)", async () => {
    // Corrupt a 200-receipt DB's page 3 (same shape as the R3/B2
    // test); the integrity refusal must be the first verdict line —
    // "disk ready" may appear (the disk IS ready), "db ready" must not.
    const base = mkR5Dir("r5-logorder");
    const dbPath = join(base, "lo.sqlite");
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    const dbMod = await import("../src/core/db");
    const instance = dbMod.getDb();
    for (let i = 0; i < 200; i++) {
      dbMod.saveReceipt({
        receipt_id: `rcpt_R5LOG${String(i).padStart(4, "0")}00000000000000`,
        intent: "ONCHAIN_TX",
        upstream_url: "https://example.invalid/u",
        raw_response_sha256: "ab".repeat(32),
        quorum_votes: "2/3",
        fetched_at: `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T10:00:00Z`,
        audit_url: "",
      });
    }
    instance.close();
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
    const bytes = readFileSync(dbPath);
    const corrupted = Buffer.from(bytes);
    corrupted.fill(0x41, 8192, 12288); // page 3 only
    writeFileSync(dbPath, corrupted);
    process.env.SQLITE_PATH = prev;

    const out = await bootFresh(dbPath);
    rmSync(base, { recursive: true, force: true });
    expect(out.count).toBeNull();
    expect(out.message).toMatch(/verireceipt: refusing to open SQLite DB at /);
    expect(out.message).toMatch(/integrity check failed|database disk image is malformed/);
    expect(out.logs).toContain("disk ready");
    expect(out.logs).not.toContain("db ready");
  });

  it("R5/O1: a direct assertDiskReady() refusal is LOGGED (console.error, redacted) as well as thrown", () => {
    const base = mkR5Dir("r5-o1");
    const tokenDir = join(base, FAKE_GHP);
    mkdirSync(tokenDir, { recursive: true });
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      expect(() => assertDiskReady(join(tokenDir, "db.sqlite") + "/")).toThrow(
        /trailing slash/,
      );
    } finally {
      errSpy.mockRestore();
      rmSync(base, { recursive: true, force: true });
    }
    // Before this fix the direct call left ZERO console.error lines:
    // only getDb()'s try/catch logged refusals.
    const joined = errors.join("\n");
    expect(joined).toContain("refusing to open SQLite DB");
    expect(joined).toContain("trailing slash");
    expect(joined).toContain("[REDACTED]");
    expect(joined).not.toContain(FAKE_GHP);
  });

  it("R5/O2: snapshotNow() returns the RAW path (fs-usable) — the return value must never be logged", async () => {
    // Contract pinned (see the snapshotNow docstring): the return is
    // the real path because callers use it for fs ops; the log line
    // inside snapshotNow is the redacted form. Production's only
    // caller (startBackupJobs) discards the return.
    const base = mkR5Dir("r5-o2");
    const tokenDir = join(base, FAKE_GHP);
    mkdirSync(tokenDir, { recursive: true });
    const dbPath = join(tokenDir, "db.sqlite");
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    const out: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    let file: string | null = null;
    let fileExists = false;
    try {
      const bk = await import("../src/jobs/backup");
      file = bk.snapshotNow(new Date("2026-11-20T07:00:00Z"));
      fileExists = file !== null && existsSync(file);
    } finally {
      logSpy.mockRestore();
      process.env.SQLITE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
    expect(file).not.toBeNull();
    // RAW: the return still names the token directory (fs-usable).
    expect(file as string).toContain(FAKE_GHP);
    expect(fileExists).toBe(true);
    // But the LOGGED line is the redacted form — the module never logs
    // the return value.
    const joined = out.join("\n");
    expect(joined).toContain("snapshot");
    expect(joined).toContain("[REDACTED]");
    expect(joined).not.toContain(FAKE_GHP);
  });

  /** Build a DB with `count` random receipts (fixed R5/O3 id algorithm: LCG + base36 counter suffix). Single-transaction raw insert (fast at 20k). */
  async function buildRandomIdDbCount(
    base: string,
    name: string,
    count: number,
  ): Promise<{ dbPath: string; instance: Database.Database }> {
    const dbPath = join(base, `${name}.sqlite`);
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    vi.resetModules();
    const dbMod = await import("../src/core/db");
    const instance = dbMod.getDb();
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let seed = 123456789;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const insert = instance.prepare(
      "INSERT INTO miner_receipts (receipt_id, intent, upstream_url, raw_response_sha256, fetched_at) VALUES (?,?,?,?,?)",
    );
    const bulk = instance.transaction((n: number) => {
      for (let i = 0; i < n; i++) {
        let id = "rcpt_";
        for (let j = 0; j < 20; j++) id += ALPHA[Math.floor(rnd() * ALPHA.length)];
        id += i.toString(36).toUpperCase().padStart(6, "0");
        insert.run(
          id,
          "ONCHAIN_TX",
          "https://example.invalid/u",
          "ab".repeat(32),
          "2026-11-20T10:00:00Z",
        );
      }
    });
    bulk(count);
    process.env.SQLITE_PATH = prev;
    return { dbPath, instance };
  }

  it("R5/O3: the fixed random-id builder produces actually-unique ids at 20,000 draws", async () => {
    // The old pure-LCG stream collapsed to ~5,300 unique ids per 20k
    // draws (all seeds tested) — a future 20k-row test built with it
    // would silently seed ~5.3k rows via INSERT OR IGNORE.
    const base = mkR5Dir("r5-20k");
    const { instance } = await buildRandomIdDbCount(base, "R5K20", 20000);
    try {
      const n = (
        instance.prepare("SELECT COUNT(*) AS n FROM miner_receipts").get() as { n: number }
      ).n;
      expect(n).toBe(20000);
      const distinct = (
        instance.prepare("SELECT COUNT(DISTINCT receipt_id) AS n FROM miner_receipts").get() as {
          n: number;
        }
      ).n;
      expect(distinct).toBe(20000);
    } finally {
      instance.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
