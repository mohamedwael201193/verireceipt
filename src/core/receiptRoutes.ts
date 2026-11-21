// G10 — serve stored receipts (C1 evidence store, 68665ce).
//
//   GET /receipts/:id          receipt metadata (JSON)
//   GET /receipts/:id/raw      the EXACT stored evidence bytes that
//                              raw_response_sha256 hashes
//   GET /receipts/:id/evidence alias of /raw (the name used in handler
//                              comments and JUDGE.md §4)
//   GET /receipts/:id/pages/:n/raw
//                              the EXACT bytes of extra upstream page n
//                              (0-based, = upstream_pages[n]) that the
//                              answer also relied on, e.g. FILINGS older
//                              submissions pages. Each page has its own
//                              sha256; the main digest covers only /raw.
//   /api/receipts/:id[/raw|/pages/:n/raw]
//                              same routes under /api, so the path the
//                              frontend calls (vercel.json rewrites
//                              /api/* -> this service /*) also works when
//                              called on this service directly.
//
// audit_url in every receipt is <PUBLIC_BASE_URL>/receipts/<id>, which is
// the first route above. Contract:
//   - id must match RECEIPT_ID_RE ("rcpt_" + 26 A-Z0-9) -> else 400
//     INVALID_RECEIPT_ID, before any DB access. The id is only ever a bound
//     SQL parameter; it never reaches the filesystem, so there is no path
//     to traverse.
//   - unknown id -> 404 RECEIPT_NOT_FOUND; a known receipt whose evidence
//     was never stored (legacy row) or was pruned under the evidence
//     budget -> /raw 404 EVIDENCE_NOT_FOUND (metadata still 200 with
//     evidence_available:false).
//   - no listing route exists: GET /receipts and /receipts/ are 404.
//   - stored bytes that no longer hash to their recorded digest are DB
//     corruption -> 500 EVIDENCE_CORRUPT; wrong bytes are never served.
//
// Hash format (README "Receipts"): raw_response_sha256 is 64 lowercase hex
// characters, no "0x" prefix (what `sha256sum` prints). Rows stored by
// builds that emitted "0x"+hex are served in the canonical form. The /raw
// response repeats the digest in X-Raw-SHA256 (same format) and in
// Repr-Digest (RFC 9530, sha-256 as base64), so a verifier can recompute
// sha256(body) and compare without a second request.

import type { FastifyInstance, FastifyReply } from "fastify";
import { ApiError, badRequest, errorBody } from "./errors";
import { getReceiptEvidence, getReceiptMeta, getReceiptPageEvidence, getReceiptPages, type ReceiptEvidence } from "./db";
import { RECEIPT_ID_RE, normalizeSha256Hex, publicBaseUrl, sha256Hex } from "./receipt";

const notFound = (code: string, message: string): ApiError => new ApiError(404, code, message);

function validateId(raw: unknown): string {
  if (typeof raw !== "string" || !RECEIPT_ID_RE.test(raw)) {
    throw badRequest(
      "INVALID_RECEIPT_ID",
      'receipt id must be "rcpt_" followed by 26 characters A-Z or 0-9',
    );
  }
  return raw;
}

/**
 * Content type for stored evidence. Upstream content types are not
 * stored, so it is derived from the bytes alone: valid UTF-8 that parses
 * as JSON -> application/json; other valid UTF-8 (e.g. CSV) -> text/plain;
 * anything else -> application/octet-stream. The bytes are sent unchanged
 * in every case; the type only tells a browser how to display them.
 */
export function evidenceContentType(bytes: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "application/octet-stream";
  }
  try {
    JSON.parse(text);
    return "application/json; charset=utf-8";
  } catch {
    return "text/plain; charset=utf-8";
  }
}

const PAGE_INDEX_RE = /^(0|[1-9][0-9]{0,3})$/;

function validatePageIndex(raw: unknown): number {
  if (typeof raw !== "string" || !PAGE_INDEX_RE.test(raw)) {
    throw badRequest("INVALID_PAGE_INDEX", "page index must be a non-negative integer without leading zeros");
  }
  return Number(raw);
}

function sendError(reply: FastifyReply, err: ApiError): FastifyReply {
  return reply
    .status(err.status)
    .header("cache-control", "no-store")
    .header("access-control-allow-origin", "*")
    .type("application/json; charset=utf-8")
    .send(errorBody(err));
}

export function registerReceiptRoutes(app: FastifyInstance): void {
  const meta = async (request: { params: unknown }, reply: FastifyReply) => {
    let id: string;
    try {
      id = validateId((request.params as { id?: unknown }).id);
    } catch (err) {
      return sendError(reply, err as ApiError);
    }
    const row = getReceiptMeta(id);
    if (!row) return sendError(reply, notFound("RECEIPT_NOT_FOUND", `no receipt ${id}`));
    const base = publicBaseUrl();
    // A stored digest that is not a SHA-256 is corruption, not a format.
    const digest = normalizeSha256Hex(row.raw_response_sha256);
    if (digest === null) {
      return sendError(reply, new ApiError(500, "RECEIPT_CORRUPT", `stored digest for ${id} is not a SHA-256`));
    }
    const pages = getReceiptPages(id);
    const upstreamPages: Array<Record<string, unknown>> = [];
    for (const p of pages) {
      const pageDigest = normalizeSha256Hex(p.raw_response_sha256);
      if (pageDigest === null) {
        return sendError(reply, new ApiError(500, "RECEIPT_CORRUPT", `stored digest for ${id} page ${p.page_index} is not a SHA-256`));
      }
      upstreamPages.push({
        page_index: p.page_index,
        url: p.url,
        raw_response_sha256: pageDigest,
        raw_url: `${base}/receipts/${row.receipt_id}/pages/${p.page_index}/raw`,
        evidence_available: p.evidence_available,
        evidence_bytes: p.evidence_bytes,
      });
    }
    return reply
      .header("cache-control", "public, max-age=60")
      .header("access-control-allow-origin", "*")
      .send({
        receipt_id: row.receipt_id,
        intent: row.intent,
        upstream_url: row.upstream_url,
        raw_response_sha256: digest,
        hash_algorithm: "sha256",
        hash_encoding: "hex-lowercase",
        quorum_votes: row.quorum_votes,
        fetched_at: row.fetched_at,
        audit_url: `${base}/receipts/${row.receipt_id}`,
        raw_url: `${base}/receipts/${row.receipt_id}/raw`,
        evidence_available: row.evidence_available,
        evidence_bytes: row.evidence_bytes,
        // Extra upstream pages (empty for single-document receipts).
        upstream_pages: upstreamPages,
      });
  };

  /** Shared /raw sender: re-checks the digest, then sends the exact bytes. */
  const sendBytes = (reply: FastifyReply, ev: ReceiptEvidence, what: string) => {
    if (ev.evidence === null) {
      return sendError(reply, notFound("EVIDENCE_NOT_FOUND", `${what} exists but its raw bytes are not stored (legacy or pruned)`));
    }
    const digest = sha256Hex(ev.evidence);
    // Belt and braces: the db getters already compared these.
    if (digest !== normalizeSha256Hex(ev.sha256)) {
      return sendError(reply, new ApiError(500, "EVIDENCE_CORRUPT", `stored evidence for ${what} failed its hash check`));
    }
    const b64 = Buffer.from(digest, "hex").toString("base64");
    return reply
      .header("content-type", evidenceContentType(ev.evidence))
      .header("x-raw-sha256", digest)
      .header("repr-digest", `sha-256=:${b64}:`)
      .header("etag", `"${digest}"`)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("access-control-allow-origin", "*")
      .header("access-control-expose-headers", "x-raw-sha256, repr-digest, etag")
      .send(ev.evidence);
  };

  const pageRaw = async (request: { params: unknown }, reply: FastifyReply) => {
    let id: string;
    let n: number;
    try {
      id = validateId((request.params as { id?: unknown }).id);
      n = validatePageIndex((request.params as { n?: unknown }).n);
    } catch (err) {
      return sendError(reply, err as ApiError);
    }
    if (!getReceiptMeta(id)) return sendError(reply, notFound("RECEIPT_NOT_FOUND", `no receipt ${id}`));
    let ev: ReceiptEvidence;
    try {
      ev = getReceiptPageEvidence(id, n);
    } catch {
      return sendError(reply, new ApiError(500, "EVIDENCE_CORRUPT", `stored evidence for ${id} page ${n} failed its hash check`));
    }
    if (!ev.found) return sendError(reply, notFound("PAGE_NOT_FOUND", `receipt ${id} has no upstream page ${n}`));
    return sendBytes(reply, ev, `receipt ${id} page ${n}`);
  };

  const raw = async (request: { params: unknown }, reply: FastifyReply) => {
    let id: string;
    try {
      id = validateId((request.params as { id?: unknown }).id);
    } catch (err) {
      return sendError(reply, err as ApiError);
    }
    let ev;
    try {
      ev = getReceiptEvidence(id);
    } catch {
      // getReceiptEvidence throws only when the blob fails its own hash
      // or length check: never serve those bytes.
      return sendError(reply, new ApiError(500, "EVIDENCE_CORRUPT", `stored evidence for ${id} failed its hash check`));
    }
    if (!ev.found) return sendError(reply, notFound("RECEIPT_NOT_FOUND", `no receipt ${id}`));
    return sendBytes(reply, ev, `receipt ${id}`);
  };

  for (const prefix of ["", "/api"]) {
    app.get(`${prefix}/receipts/:id`, meta);
    app.get(`${prefix}/receipts/:id/raw`, raw);
    app.get(`${prefix}/receipts/:id/pages/:n/raw`, pageRaw);
  }
  app.get("/receipts/:id/evidence", raw);
}
