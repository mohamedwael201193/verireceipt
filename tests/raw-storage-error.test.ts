// PG-MIGRATE r2: a STORAGE failure while reading evidence (on Postgres: a
// connection reset / timeout) must be a 502 and must NOT be cached as
// "corrupt"; only an EvidenceCorruptError (bad bytes) is 500
// EVIDENCE_CORRUPT. Found re-running J2's RST fault injection on r2.
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdirSync, mkdtempSync } from "fs";
import { join, resolve } from "path";

const SCRATCH = resolve(process.cwd(), "..", "tmp", "raw-storage-error-test");
mkdirSync(SCRATCH, { recursive: true });
process.env.SQLITE_PATH = join(mkdtempSync(join(SCRATCH, "db-")), "verireceipt.sqlite");
process.env.SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? "verireceipt-test test@example.invalid";

import * as db from "../src/core/db";
import * as store from "../src/core/storage";
import { makeReceipt } from "../src/core/receipt";
import { buildServer } from "../src/server";

afterAll(async () => {
  vi.restoreAllMocks();
  store.__setStorageBackendForTests(null);
  await store.closeStorage();
});

describe("/raw: storage error vs corruption", () => {
  it("a storage error is 502 (not 500 EVIDENCE_CORRUPT) and the receipt is served normally afterwards", async () => {
    store.__setStorageBackendForTests("sqlite");
    const body = Buffer.from("raw-storage-error " + Date.now());
    const r = makeReceipt("TX_LOOKUP_GENERAL", "https://example.invalid/rpc", body, "2/2");
    await store.saveReceipt(r, body, [{ url: "https://example.invalid/p0", body: "page0" }]);
    const app = buildServer();
    try {
      const reset = Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
      const s1 = vi.spyOn(db, "getReceiptEvidence").mockImplementationOnce(() => {
        throw reset;
      });
      const a = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/raw` });
      expect(s1).toHaveBeenCalled();
      expect(a.statusCode).toBe(502);
      expect(a.body).not.toContain("EVIDENCE_CORRUPT");
      const s2 = vi.spyOn(db, "getReceiptPageEvidence").mockImplementationOnce(() => {
        throw reset;
      });
      const b = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/pages/0/raw` });
      expect(s2).toHaveBeenCalled();
      expect(b.statusCode).toBe(502);
      // Not cached as corrupt: the next reads serve the exact bytes.
      const ok = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/raw` });
      expect(ok.statusCode).toBe(200);
      expect(Buffer.compare(ok.rawPayload, body)).toBe(0);
      const meta = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}` });
      expect(meta.json().evidence_status).toBe("ok");
      const p = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/pages/0/raw` });
      expect(p.statusCode).toBe(200);
      // A real decode failure is still 500 EVIDENCE_CORRUPT.
      vi.spyOn(db, "getReceiptEvidence").mockImplementationOnce(() => {
        throw new db.EvidenceCorruptError("bad bytes");
      });
      const c = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/raw` });
      expect(c.statusCode).toBe(500);
      expect(c.json().error?.code ?? c.json().code ?? c.body).toContain("EVIDENCE_CORRUPT");
    } finally {
      await app.close();
    }
  });
});
