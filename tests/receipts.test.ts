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

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { mkdirSync, mkdtempSync } from "fs";
import { join, resolve } from "path";
import type { FastifyInstance } from "fastify";

const SCRATCH = resolve(process.cwd(), "..", "g10-test-scratch");
mkdirSync(SCRATCH, { recursive: true });
process.env.SQLITE_PATH = join(mkdtempSync(join(SCRATCH, "db-")), "verireceipt.sqlite");
process.env.PUBLIC_BASE_URL = "https://verireceipt.example";

import { buildServer } from "../src/server";
import { getDb, saveReceipt, getReceiptMeta, getReceiptPages } from "../src/core/db";
import {
  makeReceipt,
  normalizeSha256Hex,
  RECEIPT_ID_RE,
  sha256Hex,
} from "../src/core/receipt";
import { evidenceContentType } from "../src/core/receiptRoutes";
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
    expect(m.json()).toMatchObject({ raw_response_sha256: d, evidence_available: false, evidence_bytes: 0, quorum_votes: null });
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
