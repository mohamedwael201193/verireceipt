// G10 — GET /receipts/:id and /receipts/:id/raw (plus /api aliases).
//
// Unit: id validation (400), unknown id (404), no listing, legacy rows
// (no evidence, "0x"-prefixed digest), corrupt blob (500, bytes never
// served), content types, verification headers, HEAD.
// End-to-end (stubbed upstream): a real /v1/validator request through the
// real server and handler creates a receipt; /raw is fetched and
// sha256(body) must equal the receipt's raw_response_sha256.
// End-to-end LIVE: the same against the real beacon APIs and the real
// Ethereum RPCs (reference tx), no stubs.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import type { FastifyInstance } from "fastify";

const SCRATCH = resolve(process.cwd(), "..", "g10-test-scratch");
mkdirSync(SCRATCH, { recursive: true });
const DB_DIR = mkdtempSync(join(SCRATCH, "db-"));
process.env.SQLITE_PATH = join(DB_DIR, "verireceipt.sqlite");
process.env.PUBLIC_BASE_URL = "https://verireceipt.example";

import { buildServer } from "../src/server";
import { getDb, saveReceipt, getReceiptMeta, getReceiptPages, MAX_EVIDENCE_TOTAL_BYTES } from "../src/core/db";
import { randomBytes } from "crypto";
import {
  makeReceipt,
  normalizeSha256Hex,
  RECEIPT_ID_RE,
  sha256Hex,
} from "../src/core/receipt";
import { evidenceContentType, ifNoneMatchHits } from "../src/core/receiptRoutes";
import {
  clearEvidenceVerifyCache,
  evidenceVerifyCacheSize,
  evidenceVerifyStats,
  resetEvidenceVerifyStats,
  setEvidenceVerifyPauseForTests,
} from "../src/core/evidenceVerify";
import { getReceiptEvidence } from "../src/core/db";
import { stopTvlListsRefreshTimer } from "../src/handlers/tvl";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
let app: FastifyInstance;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  stopTvlListsRefreshTimer();
  // the r2 budget tests write ~100 MB of random evidence: never leave it behind
  rmSync(DB_DIR, { recursive: true, force: true });
});

function insertLegacyRow(id: string, digest: string, evidenceGzip: Buffer | null, evidenceBytes: number) {
  getDb()
    .prepare(
      `INSERT INTO miner_receipts
       (receipt_id, intent, upstream_url, raw_response_sha256, fetched_at, evidence_gzip, evidence_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, "TVL_LOOKUP_GENERAL", "https://api.llama.fi/protocol/lido", digest, "2026-11-20T13:10:00.000Z", evidenceGzip, evidenceBytes);
}

describe("normalizeSha256Hex / RECEIPT_ID_RE", () => {
  it("canonical form is 64 lowercase hex, no 0x; legacy 0x and uppercase normalise", () => {
    const h = sha("x");
    expect(normalizeSha256Hex(h)).toBe(h);
    expect(normalizeSha256Hex("0x" + h)).toBe(h);
    expect(normalizeSha256Hex("0X" + h.toUpperCase())).toBe(h);
    expect(normalizeSha256Hex(h.slice(1))).toBeNull();
    expect(normalizeSha256Hex("0x" + h + "0")).toBeNull();
    expect(normalizeSha256Hex(12345)).toBeNull();
  });
  it("makeReceipt emits the canonical form and a valid id", () => {
    const r = makeReceipt("TVL_LOOKUP_GENERAL", "https://u.example", "abc", "1/1");
    expect(r.raw_response_sha256).toBe(sha("abc"));
    expect(r.raw_response_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(RECEIPT_ID_RE.test(r.receipt_id)).toBe(true);
    expect(r.audit_url).toBe(`https://verireceipt.example/receipts/${r.receipt_id}`);
  });
});

describe("evidenceContentType", () => {
  it("json / text / binary", () => {
    expect(evidenceContentType(Buffer.from('{"a":1}'))).toBe("application/json; charset=utf-8");
    expect(evidenceContentType(Buffer.from("a,b\n1,2\n"))).toBe("text/plain; charset=utf-8");
    expect(evidenceContentType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]))).toBe("application/octet-stream");
  });
});

describe("id validation, unknown ids, no listing", () => {
  const malformed = [
    "rcpt_abc",
    "rcpt_" + "a".repeat(26), // lowercase
    "rcpt_" + "A".repeat(25),
    "rcpt_" + "A".repeat(27),
    "RCPT_" + "A".repeat(26),
    "..%2F..%2Fetc%2Fpasswd",
    "rcpt_" + "A".repeat(20) + "%2E%2E%2F%2E",
    "%00",
    "rcpt_" + "A".repeat(25) + "%20",
  ];
  for (const id of malformed) {
    for (const suffix of ["", "/raw"]) {
      it(`400 INVALID_RECEIPT_ID for ${id}${suffix}`, async () => {
        const res = await app.inject({ method: "GET", url: `/receipts/${id}${suffix}` });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: "INVALID_RECEIPT_ID", error: "invalid_receipt_id" });
        expect(res.headers["cache-control"]).toBe("no-store");
      });
    }
  }
  it("raw path traversal segments never resolve to a file", async () => {
    for (const url of ["/receipts/../package.json", "/receipts/%2e%2e/package.json", "/receipts/..%2fpackage.json/raw", "/api/receipts/../../src/server.ts"]) {
      const res = await app.inject({ method: "GET", url });
      expect([400, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain('"name":"verireceipt"');
      expect(res.body).not.toContain("buildServer");
    }
  });
  it("404 RECEIPT_NOT_FOUND for a well-formed unknown id (json, raw, /api, evidence alias)", async () => {
    const id = "rcpt_" + "Z".repeat(26);
    for (const url of [`/receipts/${id}`, `/receipts/${id}/raw`, `/api/receipts/${id}`, `/api/receipts/${id}/raw`, `/receipts/${id}/evidence`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("RECEIPT_NOT_FOUND");
    }
  });
  it("no listing: /receipts and /api/receipts are 404; a trailing slash (empty id) is 400; neither returns ids", async () => {
    // seed one receipt so a listing would have something to leak
    const r = makeReceipt("TVL_LOOKUP_GENERAL", "https://u.example", "seed", "1/1");
    saveReceipt(r, "seed");
    for (const [url, code] of [["/receipts", 404], ["/api/receipts", 404], ["/receipts/", 400], ["/api/receipts/", 400]] as const) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(code);
      expect(res.body).not.toContain(r.receipt_id);
    }
  });
});

describe("stored receipts", () => {
  it("serves metadata and the exact bytes with verification headers (JSON evidence)", async () => {
    const body = Buffer.from('{"z":1,"a":[1,2,3],"s":"é"}', "utf8");
    const r = makeReceipt("VALIDATOR_PERFORMANCE_VERIFY_GENERAL", "https://beacon.example/v", body, "2/2 sources agreed");
    saveReceipt(r, body);
    for (const prefix of ["", "/api"]) {
      const m = await app.inject({ method: "GET", url: `${prefix}/receipts/${r.receipt_id}` });
      expect(m.statusCode).toBe(200);
      expect(m.json()).toEqual({
        receipt_id: r.receipt_id,
        intent: r.intent,
        upstream_url: r.upstream_url,
        raw_response_sha256: r.raw_response_sha256,
        hash_algorithm: "sha256",
        hash_encoding: "hex-lowercase",
        quorum_votes: "2/2 sources agreed",
        fetched_at: r.fetched_at,
        audit_url: r.audit_url,
        raw_url: `${r.audit_url}/raw`,
        evidence_available: true,
        evidence_status: "ok",
        evidence_bytes: body.length,
        upstream_pages: [],
      });
      const raw = await app.inject({ method: "GET", url: `${prefix}/receipts/${r.receipt_id}/raw` });
      expect(raw.statusCode).toBe(200);
      expect(raw.rawPayload.equals(body)).toBe(true);
      expect(sha(raw.rawPayload)).toBe(r.raw_response_sha256);
      expect(raw.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(raw.headers["x-raw-sha256"]).toBe(r.raw_response_sha256);
      expect(raw.headers["repr-digest"]).toBe(`sha-256=:${Buffer.from(r.raw_response_sha256, "hex").toString("base64")}:`);
      expect(raw.headers["etag"]).toBe(`"${r.raw_response_sha256}"`);
      expect(raw.headers["x-content-type-options"]).toBe("nosniff");
      expect(raw.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(raw.headers["cache-control"]).toContain("immutable");
      expect(Number(raw.headers["content-length"])).toBe(body.length);
    }
    const alias = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/evidence` });
    expect(alias.rawPayload.equals(body)).toBe(true);
    const head = await app.inject({ method: "HEAD", url: `/receipts/${r.receipt_id}/raw` });
    expect(head.statusCode).toBe(200);
    expect(head.headers["x-raw-sha256"]).toBe(r.raw_response_sha256);
  });

  it("CSV and binary evidence are byte-exact (no re-encoding)", async () => {
    for (const body of [Buffer.from("Time Stamp,Name,LBMP\r\n11/20/2026 23:00,N.Y.C.,41.27\r\n"), Buffer.from([0, 1, 2, 0xff, 0xfe, 0x80, 0x0a])]) {
      const r = makeReceipt("GRID_POWER_PRICE_GENERAL", "https://grid.example", body, "1/1 primary source");
      saveReceipt(r, body);
      const raw = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/raw` });
      expect(raw.statusCode).toBe(200);
      expect(raw.rawPayload.equals(body)).toBe(true);
      expect(sha(raw.rawPayload)).toBe(r.raw_response_sha256);
    }
  });

  it("legacy row (0x digest, no evidence, no quorum_votes): metadata normalised, raw 404 EVIDENCE_NOT_FOUND", async () => {
    const id = "rcpt_LEGACY" + "0".repeat(20);
    const d = sha("legacy body");
    insertLegacyRow(id, "0x" + d, null, 0);
    const m = await app.inject({ method: "GET", url: `/receipts/${id}` });
    expect(m.statusCode).toBe(200);
    expect(m.json()).toMatchObject({ raw_response_sha256: d, evidence_available: false, evidence_status: "missing", evidence_bytes: 0, quorum_votes: null });
    const raw = await app.inject({ method: "GET", url: `/receipts/${id}/raw` });
    expect(raw.statusCode).toBe(404);
    expect(raw.json().code).toBe("EVIDENCE_NOT_FOUND");
    expect(getReceiptMeta(id)?.quorum_votes).toBeNull();
  });

  it("corrupt evidence blob is never served (500 EVIDENCE_CORRUPT)", async () => {
    const id = "rcpt_CORRUPT" + "0".repeat(19);
    const good = Buffer.from("original bytes");
    insertLegacyRow(id, sha(good), gzipSync(Buffer.from("tampered bytes")), good.length);
    const raw = await app.inject({ method: "GET", url: `/receipts/${id}/raw` });
    expect(raw.statusCode).toBe(500);
    expect(raw.json().code).toBe("EVIDENCE_CORRUPT");
    expect(raw.body).not.toContain("tampered");
  });

  it("a non-SHA-256 stored digest is reported as corruption, not served as a hash", async () => {
    const id = "rcpt_BADDIGEST" + "0".repeat(17);
    insertLegacyRow(id, "not-a-digest", null, 0);
    const m = await app.inject({ method: "GET", url: `/receipts/${id}` });
    expect(m.statusCode).toBe(500);
    expect(m.json().code).toBe("RECEIPT_CORRUPT");
  });
});

// ---- every intent, and multi-page (FILINGS upstream_pages[]) receipts ----
describe("receipts from every intent, incl. FILINGS with upstream_pages", () => {
  const INTENTS = [
    "ONCHAIN_TX_LOOKUP_GENERAL",
    "GRID_POWER_PRICE_GENERAL",
    "REGULATORY_FILING_MONITOR_GENERAL",
    "OPTIMAL_EXECUTION_ROUTE_GENERAL",
    "VALIDATOR_PERFORMANCE_VERIFY_GENERAL",
    "TVL_LOOKUP_GENERAL",
  ];
  it("routes are intent-agnostic: a stored receipt of each of the 6 intents is served and re-hashes", async () => {
    for (const intent of INTENTS) {
      const body = JSON.stringify({ intent, n: Math.random() });
      const r = makeReceipt(intent, "https://up.example/" + intent, body, "1/1 primary source");
      saveReceipt(r, body);
      const m = await app.inject({ method: "GET", url: `/api/receipts/${r.receipt_id}` });
      expect(m.statusCode).toBe(200);
      expect(m.json().intent).toBe(intent);
      const raw = await app.inject({ method: "GET", url: `/api/receipts/${r.receipt_id}/raw` });
      expect(sha(raw.rawPayload)).toBe(r.raw_response_sha256);
    }
  });

  // Shape A1's filings handler produces: the receipt hashes the main
  // submissions document; older pages are listed in upstream_pages[] as
  // { url, raw_response_sha256 } with sha256Hex of each page's raw text.
  const mainDoc = JSON.stringify({ cik: "0000320193", filings: { recent: { form: ["10-K"] }, files: [{ name: "CIK0000320193-submissions-001.json" }] } });
  const pageBodies = [
    JSON.stringify({ accessionNumber: ["0000320193-10-000001"], form: ["10-K"] }),
    JSON.stringify({ accessionNumber: ["0000320193-05-000001"], form: ["10-Q"] }),
  ];
  const pageUrls = [
    "https://data.sec.gov/submissions/CIK0000320193-submissions-001.json",
    "https://data.sec.gov/submissions/CIK0000320193-submissions-002.json",
  ];
  const upstreamPages = pageBodies.map((b, i) => ({ url: pageUrls[i], raw_response_sha256: sha256Hex(b) }));

  it("FILINGS: metadata lists upstream_pages with per-page digests and raw_url; each page /raw re-hashes", async () => {
    const r = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://data.sec.gov/submissions/CIK0000320193.json", mainDoc, "1/1 primary source");
    saveReceipt(r, mainDoc, pageBodies.map((body, i) => ({ ...upstreamPages[i], body })));
    for (const prefix of ["", "/api"]) {
      const m = await app.inject({ method: "GET", url: `${prefix}/receipts/${r.receipt_id}` });
      expect(m.statusCode).toBe(200);
      const meta = m.json();
      expect(meta.raw_response_sha256).toBe(sha(mainDoc));
      expect(meta.upstream_pages).toEqual(
        upstreamPages.map((p, i) => ({
          page_index: i,
          url: p.url,
          raw_response_sha256: p.raw_response_sha256,
          raw_url: `https://verireceipt.example/receipts/${r.receipt_id}/pages/${i}/raw`,
          evidence_available: true,
          evidence_status: "ok",
          evidence_bytes: Buffer.byteLength(pageBodies[i]),
        })),
      );
      const main = await app.inject({ method: "GET", url: `${prefix}/receipts/${r.receipt_id}/raw` });
      expect(main.rawPayload.toString("utf8")).toBe(mainDoc);
      for (let i = 0; i < pageBodies.length; i++) {
        const pr = await app.inject({ method: "GET", url: `${prefix}/receipts/${r.receipt_id}/pages/${i}/raw` });
        expect(pr.statusCode).toBe(200);
        expect(pr.rawPayload.toString("utf8")).toBe(pageBodies[i]);
        expect(sha(pr.rawPayload)).toBe(upstreamPages[i].raw_response_sha256);
        expect(pr.headers["x-raw-sha256"]).toBe(upstreamPages[i].raw_response_sha256);
        expect(pr.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(pr.headers["cache-control"]).toContain("immutable");
      }
    }
    const missing = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/pages/2/raw` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("PAGE_NOT_FOUND");
    for (const bad of ["01", "-1", "abc", "1.0", "99999", "+1", "0x1"]) {
      const res = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/pages/${bad}/raw` });
      expect([bad, res.statusCode]).toEqual([bad, 400]);
      expect(res.json().code).toBe("INVALID_PAGE_INDEX");
    }
    // "pages/%2e%2e/raw": the URL parser (WHATWG dot-segment removal)
    // resolves it to this receipt's own /raw before routing — it can
    // only ever reach this receipt's main evidence, never a file.
    const dot = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/pages/%2e%2e/raw` });
    if (dot.statusCode === 200) expect(dot.rawPayload.toString("utf8")).toBe(mainDoc);
    else expect(dot.statusCode).toBe(400);
    const unknown = await app.inject({ method: "GET", url: `/receipts/rcpt_${"Y".repeat(26)}/pages/0/raw` });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe("RECEIPT_NOT_FOUND");
    const badId = await app.inject({ method: "GET", url: `/receipts/rcpt_x/pages/0/raw` });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().code).toBe("INVALID_RECEIPT_ID");
  });

  it("saveReceipt refuses a page whose bytes do not match its declared digest — nothing is written", async () => {
    const r = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://data.sec.gov/x.json", mainDoc, "1/1 primary source");
    expect(() =>
      saveReceipt(r, mainDoc, [{ url: pageUrls[0], body: pageBodies[0], raw_response_sha256: sha256Hex("other") }]),
    ).toThrow(/upstream page 0/);
    expect(getReceiptMeta(r.receipt_id)).toBeNull();
    expect(getReceiptPages(r.receipt_id)).toEqual([]);
  });

  it("a colliding receipt id never gains pages from a second save (immutable audit record)", async () => {
    const r = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://data.sec.gov/y.json", mainDoc, "1/1 primary source");
    saveReceipt(r, mainDoc);
    saveReceipt(r, mainDoc, [{ url: pageUrls[0], body: pageBodies[0] }]);
    expect(getReceiptPages(r.receipt_id)).toEqual([]);
  });

  it("a corrupt page blob is never served (500 EVIDENCE_CORRUPT)", async () => {
    const r = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://data.sec.gov/z.json", mainDoc, "1/1 primary source");
    saveReceipt(r, mainDoc, [{ url: pageUrls[0], body: pageBodies[0] }]);
    getDb()
      .prepare("UPDATE miner_receipt_pages SET evidence_gzip = ? WHERE receipt_id = ? AND page_index = 0")
      .run(gzipSync(Buffer.from("tampered page")), r.receipt_id);
    const res = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/pages/0/raw` });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe("EVIDENCE_CORRUPT");
    expect(res.body).not.toContain("tampered");
  });
});

// ---- end-to-end through a real intent route (stubbed upstream) ----
function beaconBody(index: number, eff: string, status: string): string {
  return JSON.stringify({
    execution_optimistic: false,
    finalized: true,
    data: {
      index: String(index),
      balance: "32001234567",
      status,
      validator: {
        pubkey: "0x" + "ab".repeat(48),
        withdrawal_credentials: "0x01" + "00".repeat(11) + "11".repeat(20),
        effective_balance: eff,
        slashed: false,
        activation_eligibility_epoch: "0",
        activation_epoch: "0",
        exit_epoch: "18446744073709551615",
        withdrawable_epoch: "18446744073709551615",
      },
    },
  });
}

describe("end-to-end: /v1/validator -> receipt -> /raw re-hash (stubbed beacon upstream)", () => {
  it("sha256(/raw body) == receipt.raw_response_sha256 and == metadata digest", async () => {
    const body = beaconBody(1, "32000000000", "active_ongoing");
    const stub = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", stub);
    let res;
    try {
      res = await app.inject({ method: "GET", url: "/v1/validator?validator_index=1" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(res.statusCode).toBe(200);
    const receipt = res.json().receipt;
    expect(receipt.raw_response_sha256).toBe(sha(body));
    const raw = await app.inject({ method: "GET", url: new URL(receipt.audit_url).pathname + "/raw" });
    expect(raw.statusCode).toBe(200);
    expect(sha(raw.rawPayload)).toBe(receipt.raw_response_sha256);
    expect(raw.rawPayload.toString("utf8")).toBe(body);
    const m = await app.inject({ method: "GET", url: `/api/receipts/${receipt.receipt_id}` });
    expect(m.json().raw_response_sha256).toBe(receipt.raw_response_sha256);
    expect(m.json().quorum_votes).toBe(receipt.quorum_votes);
  });
});

describe("end-to-end LIVE (real upstreams, no stubs)", () => {
  it("validator index 1: real beacon answer -> /raw bytes re-hash to the receipt digest", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/validator?validator_index=1" });
    expect(res.statusCode).toBe(200);
    const receipt = res.json().receipt;
    const raw = await app.inject({ method: "GET", url: `/receipts/${receipt.receipt_id}/raw` });
    expect(raw.statusCode).toBe(200);
    expect(sha(raw.rawPayload)).toBe(receipt.raw_response_sha256);
    expect(sha256Hex(raw.rawPayload)).toBe(raw.headers["x-raw-sha256"]);
  }, 30_000);

  it("reference tx on Ethereum: real RPC quorum -> /raw bytes re-hash to the receipt digest", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/tx?tx_hash=0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060&chain=ethereum",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().block_number).toBe(46147);
    const receipt = res.json().receipt;
    const raw = await app.inject({ method: "GET", url: `/api/receipts/${receipt.receipt_id}/raw` });
    expect(raw.statusCode).toBe(200);
    expect(sha(raw.rawPayload)).toBe(receipt.raw_response_sha256);
  }, 60_000);
});

// ---------------- G10 r2 (J2 round 1 minors) ----------------
function totalEvidenceGzip(): number {
  return (getDb()
    .prepare(
      `SELECT (SELECT COALESCE(SUM(LENGTH(evidence_gzip)), 0) FROM miner_receipts)
            + (SELECT COALESCE(SUM(LENGTH(evidence_gzip)), 0) FROM miner_receipt_pages) AS t`,
    )
    .get() as { t: number }).t;
}
function hasMain(id: string): boolean {
  return getReceiptMeta(id)?.evidence_available === true;
}
/** Remove all stored evidence so each budget test starts from an empty budget. */
function clearAllEvidence(): void {
  getDb().exec("UPDATE miner_receipts SET evidence_gzip = NULL, evidence_bytes = 0");
  getDb().exec("UPDATE miner_receipt_pages SET evidence_gzip = NULL, evidence_bytes = 0");
}
const MB = 1024 * 1024;

describe("G10 r2 m1: evidence budget with page-only receipts", () => {
  it("J2 repro: page-only receipt larger than the whole budget is stored without blobs and prunes nobody", async () => {
    clearAllEvidence();
    const small = Array.from({ length: 5 }, (_, i) => {
      const r = makeReceipt("TVL_LOOKUP_GENERAL", "https://u.example/" + i, "small-" + i, "1/1");
      saveReceipt(r, "small-" + i);
      return r;
    });
    const big = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://data.sec.gov/big.json", "main-not-stored", "1/1");
    const p0 = randomBytes(26 * MB);
    const p1 = randomBytes(26 * MB);
    saveReceipt(big, undefined, [
      { url: "https://data.sec.gov/p0.json", body: p0 },
      { url: "https://data.sec.gov/p1.json", body: p1 },
    ]);
    for (const r of small) expect(hasMain(r.receipt_id)).toBe(true);
    const pages = getReceiptPages(big.receipt_id);
    expect(pages.map((p) => [p.raw_response_sha256, p.evidence_available])).toEqual([
      [sha(p0), false],
      [sha(p1), false],
    ]);
    const next = makeReceipt("TVL_LOOKUP_GENERAL", "https://u.example/next", "next", "1/1");
    saveReceipt(next, "next");
    expect(hasMain(next.receipt_id)).toBe(true);
    for (const r of small) expect(hasMain(r.receipt_id)).toBe(true);
    expect(totalEvidenceGzip()).toBeLessThanOrEqual(MAX_EVIDENCE_TOTAL_BYTES);
    // served honestly: digests listed, raw 404 like a pruned receipt
    const m = await app.inject({ method: "GET", url: `/receipts/${big.receipt_id}` });
    expect(m.json().upstream_pages[0]).toMatchObject({ evidence_available: false, evidence_status: "missing", raw_response_sha256: sha(p0) });
    const pr = await app.inject({ method: "GET", url: `/receipts/${big.receipt_id}/pages/0/raw` });
    expect(pr.statusCode).toBe(404);
    expect(pr.json().code).toBe("EVIDENCE_NOT_FOUND");
  }, 60000);

  it("a page-only receipt within budget is a normal prune victim (oldest first), others keep their evidence", async () => {
    clearAllEvidence();
    const pageOnly = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://data.sec.gov/old.json", "x", "1/1");
    pageOnly.fetched_at = "2026-11-21T00:00:00.000Z"; // oldest
    saveReceipt(pageOnly, undefined, [{ url: "https://data.sec.gov/old-p0.json", body: randomBytes(18 * MB) }]);
    expect(getReceiptPages(pageOnly.receipt_id)[0].evidence_available).toBe(true);
    const later = [1, 2].map((i) => {
      const body = randomBytes(18 * MB);
      const r = makeReceipt("TVL_LOOKUP_GENERAL", "https://u.example/l" + i, body, "1/1");
      r.fetched_at = `2026-11-21T00:00:0${i}.000Z`;
      saveReceipt(r, body);
      return r;
    });
    // 3 x 18 MB > 50 MB -> the OLDEST (the page-only receipt) is pruned
    expect(getReceiptPages(pageOnly.receipt_id)[0].evidence_available).toBe(false);
    for (const r of later) expect(hasMain(r.receipt_id)).toBe(true);
    expect(totalEvidenceGzip()).toBeLessThanOrEqual(MAX_EVIDENCE_TOTAL_BYTES);
    // digests survive pruning
    expect(getReceiptPages(pageOnly.receipt_id)[0].raw_response_sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60000);

  it("a single main evidence larger than the budget is stored without bytes and prunes nobody", async () => {
    clearAllEvidence();
    const keep = makeReceipt("TVL_LOOKUP_GENERAL", "https://u.example/keep", "keep", "1/1");
    saveReceipt(keep, "keep");
    const body = randomBytes(MAX_EVIDENCE_TOTAL_BYTES + MB);
    const huge = makeReceipt("TVL_LOOKUP_GENERAL", "https://u.example/huge", body, "1/1");
    saveReceipt(huge, body);
    expect(hasMain(keep.receipt_id)).toBe(true);
    expect(hasMain(huge.receipt_id)).toBe(false);
    expect(getReceiptMeta(huge.receipt_id)?.raw_response_sha256).toBe(sha(body));
    expect(totalEvidenceGzip()).toBeLessThanOrEqual(MAX_EVIDENCE_TOTAL_BYTES);
    clearAllEvidence();
  }, 60000);
});

describe("G10 r2 m3: metadata agrees with /raw on broken rows", () => {
  it("corrupt main blob: meta evidence_available false / status corrupt, raw 500 EVIDENCE_CORRUPT", async () => {
    const id = "rcpt_R2CORRUPT" + "0".repeat(17);
    const good = Buffer.from("original");
    insertLegacyRow(id, sha(good), gzipSync(Buffer.from("tampered")), good.length);
    const m = await app.inject({ method: "GET", url: `/receipts/${id}` });
    expect(m.statusCode).toBe(200);
    expect(m.json()).toMatchObject({ evidence_available: false, evidence_status: "corrupt", evidence_bytes: 0 });
    const raw = await app.inject({ method: "GET", url: `/receipts/${id}/raw` });
    expect(raw.statusCode).toBe(500);
    expect(raw.json().code).toBe("EVIDENCE_CORRUPT");
  });

  it("garbage (non-gzip) blob is reported the same way", async () => {
    const id = "rcpt_R2GARBAGE" + "0".repeat(17);
    insertLegacyRow(id, sha("x"), Buffer.from("not gzip at all"), 1);
    const m = await app.inject({ method: "GET", url: `/receipts/${id}` });
    expect(m.json()).toMatchObject({ evidence_available: false, evidence_status: "corrupt" });
    expect((await app.inject({ method: "GET", url: `/receipts/${id}/raw` })).statusCode).toBe(500);
  });

  it("corrupt page blob: that page shows status corrupt in meta, page raw 500", async () => {
    const r = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://data.sec.gov/c.json", "main", "1/1");
    saveReceipt(r, "main", [{ url: "https://data.sec.gov/c0.json", body: "p0" }, { url: "https://data.sec.gov/c1.json", body: "p1" }]);
    getDb()
      .prepare("UPDATE miner_receipt_pages SET evidence_gzip = ? WHERE receipt_id = ? AND page_index = 1")
      .run(gzipSync(Buffer.from("tampered")), r.receipt_id);
    const meta = (await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}` })).json();
    expect(meta.evidence_status).toBe("ok");
    expect(meta.upstream_pages.map((p: Record<string, unknown>) => [p.evidence_available, p.evidence_status])).toEqual([
      [true, "ok"],
      [false, "corrupt"],
    ]);
    expect((await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/pages/1/raw` })).statusCode).toBe(500);
    expect((await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/pages/0/raw` })).statusCode).toBe(200);
  });

  it("non-SHA-256 stored digest: 500 RECEIPT_CORRUPT on meta, /raw, /api/raw, /evidence alike", async () => {
    const id = "rcpt_R2BADDIG" + "0".repeat(18);
    insertLegacyRow(id, "not-a-digest", null, 0);
    for (const url of [`/receipts/${id}`, `/receipts/${id}/raw`, `/api/receipts/${id}/raw`, `/receipts/${id}/evidence`, `/api/receipts/${id}/evidence`]) {
      const res = await app.inject({ method: "GET", url });
      expect([url, res.statusCode, res.json().code]).toEqual([url, 500, "RECEIPT_CORRUPT"]);
    }
  });

  it("non-SHA-256 page digest: same 500 RECEIPT_CORRUPT on meta, main raw and page raw", async () => {
    const r = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://data.sec.gov/d.json", "main-d", "1/1");
    saveReceipt(r, "main-d", [{ url: "https://data.sec.gov/d0.json", body: "pd" }]);
    getDb().prepare("UPDATE miner_receipt_pages SET raw_response_sha256 = 'zz' WHERE receipt_id = ?").run(r.receipt_id);
    for (const url of [`/receipts/${r.receipt_id}`, `/receipts/${r.receipt_id}/raw`, `/receipts/${r.receipt_id}/pages/0/raw`]) {
      const res = await app.inject({ method: "GET", url });
      expect([url, res.statusCode, res.json().code]).toEqual([url, 500, "RECEIPT_CORRUPT"]);
    }
  });
});

describe("G10 r2 m4/m2/m5: /api evidence alias, ETag 304, CORS OPTIONS request", () => {
  it("/api/receipts/:id/evidence serves the same exact bytes as /raw", async () => {
    const body = '{"alias":true}';
    const r = makeReceipt("TVL_LOOKUP_GENERAL", "https://u.example/alias", body, "1/1");
    saveReceipt(r, body);
    const res = await app.inject({ method: "GET", url: `/api/receipts/${r.receipt_id}/evidence` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(body);
    expect(res.headers["x-raw-sha256"]).toBe(r.raw_response_sha256);
    const unknown = await app.inject({ method: "GET", url: `/api/receipts/rcpt_${"Q".repeat(26)}/evidence` });
    expect(unknown.statusCode).toBe(404);
    const bad = await app.inject({ method: "GET", url: `/api/receipts/rcpt_q/evidence` });
    expect(bad.statusCode).toBe(400);
  });

  it("ifNoneMatchHits: exact, list, weak, star; no match otherwise", () => {
    const e = `"${"a".repeat(64)}"`;
    expect(ifNoneMatchHits(e, e)).toBe(true);
    expect(ifNoneMatchHits(`"x", ${e}`, e)).toBe(true);
    expect(ifNoneMatchHits(`W/${e}`, e)).toBe(true);
    expect(ifNoneMatchHits("*", e)).toBe(true);
    expect(ifNoneMatchHits(`"${"b".repeat(64)}"`, e)).toBe(false);
    expect(ifNoneMatchHits("a".repeat(64), e)).toBe(false); // unquoted is not an entity-tag
    expect(ifNoneMatchHits(undefined, e)).toBe(false);
  });

  it("If-None-Match with the ETag -> 304 (no body) on /raw, /api/raw, /evidence and page raw; mismatch -> 200", async () => {
    const body = '{"etag":1}';
    const r = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://data.sec.gov/e.json", body, "1/1");
    saveReceipt(r, body, [{ url: "https://data.sec.gov/e0.json", body: "page-e" }]);
    const etag = `"${r.raw_response_sha256}"`;
    for (const path of ["/raw", "/evidence"]) {
      for (const prefix of ["", "/api"]) {
        const url = `${prefix}/receipts/${r.receipt_id}${path}`;
        const hit = await app.inject({ method: "GET", url, headers: { "if-none-match": etag } });
        expect([url, hit.statusCode]).toEqual([url, 304]);
        expect(hit.body).toBe("");
        expect(hit.headers["etag"]).toBe(etag);
        expect(hit.headers["cache-control"]).toContain("immutable");
        const miss = await app.inject({ method: "GET", url, headers: { "if-none-match": `"${"0".repeat(64)}"` } });
        expect(miss.statusCode).toBe(200);
        expect(miss.body).toBe(body);
      }
    }
    const pageEtag = `"${sha("page-e")}"`;
    const p304 = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/pages/0/raw`, headers: { "if-none-match": pageEtag } });
    expect(p304.statusCode).toBe(304);
    // the main ETag does not validate the page (different representation)
    const p200 = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/pages/0/raw`, headers: { "if-none-match": etag } });
    expect(p200.statusCode).toBe(200);
  });

  it("a corrupt row never answers 304, even with a matching If-None-Match", async () => {
    const id = "rcpt_R2ETAGBAD" + "0".repeat(17);
    const good = Buffer.from("orig");
    insertLegacyRow(id, sha(good), gzipSync(Buffer.from("evil")), good.length);
    const res = await app.inject({ method: "GET", url: `/receipts/${id}/raw`, headers: { "if-none-match": `"${sha(good)}"` } });
    expect(res.statusCode).toBe(500);
  });

  it("CORS OPTIONS request -> 204 with CORS allow headers on every receipt route", async () => {
    const id = "rcpt_" + "P".repeat(26);
    for (const prefix of ["", "/api"]) {
      for (const path of ["", "/raw", "/evidence", "/pages/0/raw"]) {
        const res = await app.inject({ method: "OPTIONS", url: `${prefix}/receipts/${id}${path}` });
        expect(res.statusCode).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe("*");
        expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("if-none-match");
        expect(res.headers["access-control-allow-methods"]).toContain("GET");
      }
    }
  });
});

describe("G10 r3 (J1 n1 / J2 r2-m1): metadata verification is async and cached", () => {
  const meta = async (id: string) => (await app.inject({ method: "GET", url: `/receipts/${id}` })).json();

  it("verdict is cached per stored blob: a second metadata call does not re-verify", async () => {
    // 256 KiB of random bytes; the tamper below flips one gzip byte and
    // leaves the digest and length columns (the cache key) unchanged.
    const body = randomBytes(256 * 1024);
    const r = makeReceipt("GRID_POWER_PRICE_GENERAL", "https://grid.example/r3", body, "1/1");
    saveReceipt(r, body);
    clearEvidenceVerifyCache();
    resetEvidenceVerifyStats();
    expect(await meta(r.receipt_id)).toMatchObject({ evidence_available: true, evidence_status: "ok" });
    expect(evidenceVerifyCacheSize()).toBe(1);
    expect(evidenceVerifyStats.blobReads).toBeGreaterThan(0);
    expect(evidenceVerifyStats.gunzips).toBeGreaterThan(0);
    expect(evidenceVerifyStats.hashes).toBeGreaterThan(0);
    // Alter the stored blob in place behind the server's back.
    const gz = getDb().prepare("SELECT evidence_gzip FROM miner_receipts WHERE receipt_id = ?").get(r.receipt_id) as { evidence_gzip: Buffer };
    const tampered = Buffer.from(gz.evidence_gzip);
    const mid = Math.floor(tampered.length / 2);
    tampered[mid] = tampered[mid] ^ 0xff;
    getDb().prepare("UPDATE miner_receipts SET evidence_gzip = ? WHERE receipt_id = ?").run(tampered, r.receipt_id);
    // Deterministic cache-hit proof (J1 M1): zero blob reads / unzip / hash.
    resetEvidenceVerifyStats();
    expect((await meta(r.receipt_id)).evidence_status).toBe("ok");
    expect(evidenceVerifyCacheSize()).toBe(1);
    expect(evidenceVerifyStats).toEqual({ blobReads: 0, gunzips: 0, hashes: 0 });
    // ... but /raw re-verifies before every send and never serves the bytes,
    const raw = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/raw` });
    expect(raw.statusCode).toBe(500);
    expect(raw.json().code).toBe("EVIDENCE_CORRUPT");
    // and feeds that back: metadata now agrees with /raw.
    expect(await meta(r.receipt_id)).toMatchObject({ evidence_available: false, evidence_status: "corrupt", evidence_bytes: 0 });
    // A fresh process (empty cache) reaches the same verdict on its own.
    clearEvidenceVerifyCache();
    expect((await meta(r.receipt_id)).evidence_status).toBe("corrupt");
  });

  it("the cache key is the stored row: a row whose digest column changes is re-verified", async () => {
    const r = makeReceipt("GRID_POWER_PRICE_GENERAL", "https://grid.example/r3b", "good-bytes", "1/1");
    saveReceipt(r, "good-bytes");
    expect((await meta(r.receipt_id)).evidence_status).toBe("ok");
    getDb().prepare("UPDATE miner_receipts SET raw_response_sha256 = ? WHERE receipt_id = ?").run(sha("other-bytes"), r.receipt_id);
    expect((await meta(r.receipt_id))).toMatchObject({ evidence_available: false, evidence_status: "corrupt" });
    expect((await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/raw` })).statusCode).toBe(500);
  });

  it("a pruned blob reads as missing even after a cached ok (cache never resurrects evidence)", async () => {
    const r = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://data.sec.gov/r3.json", "main", "1/1");
    saveReceipt(r, "main", [{ url: "https://data.sec.gov/r3p0.json", body: "page0" }]);
    const before = await meta(r.receipt_id);
    expect(before.evidence_status).toBe("ok");
    expect(before.upstream_pages[0].evidence_status).toBe("ok");
    getDb().prepare("UPDATE miner_receipts SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = ?").run(r.receipt_id);
    getDb().prepare("UPDATE miner_receipt_pages SET evidence_gzip = NULL, evidence_bytes = 0 WHERE receipt_id = ?").run(r.receipt_id);
    const after = await meta(r.receipt_id);
    expect(after).toMatchObject({ evidence_available: false, evidence_status: "missing" });
    expect(after.upstream_pages[0]).toMatchObject({ evidence_available: false, evidence_status: "missing" });
    expect((await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/raw` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/pages/0/raw` })).statusCode).toBe(404);
  });

  it("concurrent metadata calls share one verification and agree", async () => {
    const body = randomBytes(2 * 1024 * 1024);
    const r = makeReceipt("GRID_POWER_PRICE_GENERAL", "https://grid.example/r3c", body, "1/1");
    saveReceipt(r, body);
    clearEvidenceVerifyCache();
    const results = await Promise.all(Array.from({ length: 8 }, () => meta(r.receipt_id)));
    for (const m of results) expect(m).toMatchObject({ evidence_status: "ok", evidence_bytes: body.length });
    expect(evidenceVerifyCacheSize()).toBe(1);
  });

  it("an uncached 40 MB blob yields to the event loop; a cached call does no blob work", async () => {
    const body = randomBytes(40 * 1024 * 1024);
    const r = makeReceipt("GRID_POWER_PRICE_GENERAL", "https://grid.example/r3big", body, "1/1");
    saveReceipt(r, body);
    expect(getReceiptMeta(r.receipt_id)?.evidence_available).toBe(true);
    // Reference measurement only (r2 sync path); not used in assertions.
    let t = performance.now();
    getReceiptEvidence(r.receipt_id);
    const syncMs = performance.now() - t;

    clearEvidenceVerifyCache();
    resetEvidenceVerifyStats();
    let maxGap = 0;
    let ticks = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 2);
    t = performance.now();
    const m = await meta(r.receipt_id);
    const asyncMs = performance.now() - t;
    clearInterval(timer);
    expect(m).toMatchObject({ evidence_status: "ok", evidence_bytes: body.length });
    expect(evidenceVerifyStats.blobReads).toBeGreaterThan(0);
    expect(evidenceVerifyStats.gunzips).toBeGreaterThan(0);
    expect(evidenceVerifyStats.hashes).toBeGreaterThan(0);
    const uncachedStats = { ...evidenceVerifyStats };

    resetEvidenceVerifyStats();
    t = performance.now();
    const m2 = await meta(r.receipt_id);
    const cachedMs = performance.now() - t;
    expect(m2.evidence_status).toBe("ok");
    // Deterministic cache-hit proof (J1 M1): zero blob reads / unzip / hash.
    expect(evidenceVerifyStats).toEqual({ blobReads: 0, gunzips: 0, hashes: 0 });
    console.log(
      `[g10-r4] 40 MB blob: sync getter ${syncMs.toFixed(1)} ms blocking; async meta ${asyncMs.toFixed(1)} ms wall, ` +
        `max event-loop gap ${maxGap.toFixed(1)} ms over ${ticks} ticks; cached meta ${cachedMs.toFixed(1)} ms ` +
        `(uncached work blobReads=${uncachedStats.blobReads} gunzips=${uncachedStats.gunzips} hashes=${uncachedStats.hashes})`,
    );
    // The loop kept turning (async unzip+hash yields). Timing is logged
    // for notes as a range including worst case; the only remaining
    // timing checks are generous hang-guards, not ratios of two samples.
    expect(ticks).toBeGreaterThan(5);
    const GENEROUS_MS = 2000;
    expect(maxGap).toBeLessThan(GENEROUS_MS);
    expect(cachedMs).toBeLessThan(GENEROUS_MS);
  }, 60_000);
});

describe("G10 r4: generation guard and bounded gunzip", () => {
  const meta = async (id: string) => (await app.inject({ method: "GET", url: `/receipts/${id}` })).json();

  afterEach(() => {
    setEvidenceVerifyPauseForTests(null);
  });

  it("an in-flight ok verification does not overwrite a newer /raw corrupt verdict", async () => {
    const body = randomBytes(256 * 1024);
    const r = makeReceipt("GRID_POWER_PRICE_GENERAL", "https://grid.example/r4race", body, "1/1");
    saveReceipt(r, body);
    clearEvidenceVerifyCache();
    resetEvidenceVerifyStats();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const atPause = new Promise<void>((resolve) => {
      entered = resolve;
    });
    setEvidenceVerifyPauseForTests(async () => {
      entered();
      await gate;
    });

    const inFlight = meta(r.receipt_id);
    await atPause;

    // Tamper in place (digest and length columns, the cache key, stay the same).
    const gz = getDb().prepare("SELECT evidence_gzip FROM miner_receipts WHERE receipt_id = ?").get(r.receipt_id) as { evidence_gzip: Buffer };
    const tampered = Buffer.from(gz.evidence_gzip);
    const mid = Math.floor(tampered.length / 2);
    tampered[mid] = tampered[mid] ^ 0xff;
    getDb().prepare("UPDATE miner_receipts SET evidence_gzip = ? WHERE receipt_id = ?").run(tampered, r.receipt_id);

    try {
      const raw = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/raw` });
      expect(raw.statusCode).toBe(500);
      expect(raw.json().code).toBe("EVIDENCE_CORRUPT");
    } finally {
      release();
    }
    const inFlightBody = await inFlight;
    // /raw already recorded corrupt; the in-flight result must not clobber it.
    expect(inFlightBody.evidence_status).toBe("corrupt");
    expect(inFlightBody.evidence_available).toBe(false);
    expect((await meta(r.receipt_id)).evidence_status).toBe("corrupt");
  });

  it("a gzip that expands past evidence_bytes fails closed as corrupt without accepting the output", async () => {
    const honest = Buffer.from("small-honest-body");
    const r = makeReceipt("GRID_POWER_PRICE_GENERAL", "https://grid.example/r4bomb", honest, "1/1");
    saveReceipt(r, honest);
    expect((await meta(r.receipt_id)).evidence_status).toBe("ok");

    // Replace the stored gzip with a much larger payload, leaving the
    // recorded digest and length (the small honest body) unchanged.
    const bomb = gzipSync(Buffer.alloc(16 * 1024 * 1024, 0));
    getDb().prepare("UPDATE miner_receipts SET evidence_gzip = ? WHERE receipt_id = ?").run(bomb, r.receipt_id);
    clearEvidenceVerifyCache();
    resetEvidenceVerifyStats();

    const after = await meta(r.receipt_id);
    expect(after).toMatchObject({ evidence_available: false, evidence_status: "corrupt", evidence_bytes: 0 });
    const raw = await app.inject({ method: "GET", url: `/receipts/${r.receipt_id}/raw` });
    expect(raw.statusCode).toBe(500);
    expect(raw.json().code).toBe("EVIDENCE_CORRUPT");
    // Page path too: store the same bomb as page 0 of another receipt.
    const r2 = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://data.sec.gov/r4bomb.json", honest, "1/1");
    saveReceipt(r2, honest, [{ url: "https://data.sec.gov/r4bomb-p0.json", body: honest }]);
    getDb().prepare("UPDATE miner_receipt_pages SET evidence_gzip = ? WHERE receipt_id = ?").run(bomb, r2.receipt_id);
    clearEvidenceVerifyCache();
    const pageMeta = await meta(r2.receipt_id);
    expect(pageMeta.upstream_pages[0]).toMatchObject({ evidence_available: false, evidence_status: "corrupt" });
    const pageRaw = await app.inject({ method: "GET", url: `/receipts/${r2.receipt_id}/pages/0/raw` });
    expect(pageRaw.statusCode).toBe(500);
    expect(pageRaw.json().code).toBe("EVIDENCE_CORRUPT");
  }, 30_000);
});
