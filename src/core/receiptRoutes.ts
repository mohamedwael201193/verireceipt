// G10 — serve stored receipts (C1 evidence store, 68665ce).
//
//   GET /receipts/:id          receipt metadata (JSON)
//   GET /receipts/:id/raw      the EXACT stored evidence bytes that
//                              raw_response_sha256 hashes
//   GET /receipts/:id/evidence alias of /raw (the name used in older
//                              handler comments), also under /api
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
//     Metadata agrees with /raw (G10 r2): the blob is verified for the
//     metadata too, so a corrupt blob shows evidence_available:false,
//     evidence_status "corrupt"; a missing one "missing"; else "ok". A
//     stored digest that is not a SHA-256 (main or any page) answers 500
//     RECEIPT_CORRUPT on metadata, /raw and page /raw alike.
//   - /raw responses carry ETag "<hex>"; If-None-Match matching it -> 304
//     (checked only after the bytes pass their hash check). OPTIONS on
//     every receipt route answers a CORS preflight (204).
//
// Hash format (README "Receipts"): raw_response_sha256 is 64 lowercase hex
// characters, no "0x" prefix (what `sha256sum` prints). Rows stored by
// builds that emitted "0x"+hex are served in the canonical form. The /raw
// response repeats the digest in X-Raw-SHA256 (same format) and in
// Repr-Digest (RFC 9530, sha-256 as base64), so a verifier can recompute
// sha256(body) and compare without a second request.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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

/**
 * Does If-None-Match match this representation's strong ETag `"<hex>"`?
 * RFC 9110 §13.1.2: "*" matches any; a list of entity-tags is compared
 * with the weak comparison (W/ prefix ignored).
 */
export function ifNoneMatchHits(header: unknown, etag: string): boolean {
  if (typeof header !== "string") return false;
  const value = header.trim();
  if (value === "*") return true;
  return value
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === etag);
}

/** Evidence state as served by BOTH metadata and /raw (G10 r2, J2 m3). */
type EvidenceStatus = "ok" | "missing" | "corrupt";

/** Verify a blob through the integrity-checking getter: never trust a flag. */
function evidenceStatus(read: () => ReceiptEvidence): { status: EvidenceStatus; bytes: number } {
  try {
    const ev = read();
    if (!ev.found || ev.evidence === null) return { status: "missing", bytes: 0 };
    return { status: "ok", bytes: ev.evidence.length };
  } catch {
    return { status: "corrupt", bytes: 0 };
  }
}

/**
 * G10 r2 (J2 m3): one digest check shared by metadata, /raw and every
 * page /raw, so a receipt whose stored main OR page digest is not a
 * SHA-256 answers 500 RECEIPT_CORRUPT on all of them (previously meta
 * 500 but /raw 404).
 */
function digestCorruption(id: string): ApiError | null {
  const row = getReceiptMeta(id);
  if (!row) return null;
  if (normalizeSha256Hex(row.raw_response_sha256) === null) {
    return new ApiError(500, "RECEIPT_CORRUPT", `stored digest for ${id} is not a SHA-256`);
  }
  for (const p of getReceiptPages(id)) {
    if (normalizeSha256Hex(p.raw_response_sha256) === null) {
      return new ApiError(500, "RECEIPT_CORRUPT", `stored digest for ${id} page ${p.page_index} is not a SHA-256`);
    }
  }
  return null;
}

/** CORS preflight for the receipt routes (lets a browser send If-None-Match). */
function preflight(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .status(204)
    .header("access-control-allow-origin", "*")
    .header("access-control-allow-methods", "GET, HEAD, OPTIONS")
    .header("access-control-allow-headers", "If-None-Match")
    .header("access-control-max-age", "86400")
    .send();
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
    const corrupt = digestCorruption(id);
    if (corrupt) return sendError(reply, corrupt);
    const digest = normalizeSha256Hex(row.raw_response_sha256) as string;
    // G10 r2 (J2 m3): evidence_available reflects what /raw would
    // actually do — the blob is verified (gunzip + length + sha256), not
    // just checked for presence. A corrupt blob is evidence_available:
    // false with evidence_status "corrupt" (and /raw answers 500
    // EVIDENCE_CORRUPT); a legacy/pruned row is "missing" (/raw 404).
    const mainEv = row.evidence_available
      ? evidenceStatus(() => getReceiptEvidence(id))
      : { status: "missing" as EvidenceStatus, bytes: 0 };
    const pages = getReceiptPages(id);
    const upstreamPages: Array<Record<string, unknown>> = [];
    for (const p of pages) {
      const pageDigest = normalizeSha256Hex(p.raw_response_sha256) as string;
      const pageEv = p.evidence_available
        ? evidenceStatus(() => getReceiptPageEvidence(id, p.page_index))
        : { status: "missing" as EvidenceStatus, bytes: 0 };
      upstreamPages.push({
        page_index: p.page_index,
        url: p.url,
        raw_response_sha256: pageDigest,
        raw_url: `${base}/receipts/${row.receipt_id}/pages/${p.page_index}/raw`,
        evidence_available: pageEv.status === "ok",
        evidence_status: pageEv.status,
        evidence_bytes: pageEv.bytes,
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
        evidence_available: mainEv.status === "ok",
        evidence_status: mainEv.status,
        evidence_bytes: mainEv.bytes,
        // Extra upstream pages (empty for single-document receipts).
        upstream_pages: upstreamPages,
      });
  };

  /** Shared /raw sender: re-checks the digest, then sends the exact bytes. */
  const sendBytes = (request: FastifyRequest, reply: FastifyReply, ev: ReceiptEvidence, what: string) => {
    if (ev.evidence === null) {
      return sendError(reply, notFound("EVIDENCE_NOT_FOUND", `${what} exists but its raw bytes are not stored (legacy or pruned)`));
    }
    const digest = sha256Hex(ev.evidence);
    // Belt and braces: the db getters already compared these.
    if (digest !== normalizeSha256Hex(ev.sha256)) {
      return sendError(reply, new ApiError(500, "EVIDENCE_CORRUPT", `stored evidence for ${what} failed its hash check`));
    }
    const b64 = Buffer.from(digest, "hex").toString("base64");
    const etag = `"${digest}"`;
    // G10 r2 (J2 m2): conditional GET. Evaluated only AFTER the stored
    // bytes passed their hash check, so a corrupt row never answers 304.
    if (ifNoneMatchHits(request.headers["if-none-match"], etag)) {
      return reply
        .status(304)
        .header("etag", etag)
        .header("x-raw-sha256", digest)
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("access-control-allow-origin", "*")
        .header("access-control-expose-headers", "x-raw-sha256, repr-digest, etag")
        .send();
    }
    return reply
      .header("content-type", evidenceContentType(ev.evidence))
      .header("x-raw-sha256", digest)
      .header("repr-digest", `sha-256=:${b64}:`)
      .header("etag", etag)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("access-control-allow-origin", "*")
      .header("access-control-expose-headers", "x-raw-sha256, repr-digest, etag")
      .send(ev.evidence);
  };

  const pageRaw = async (request: FastifyRequest, reply: FastifyReply) => {
    let id: string;
    let n: number;
    try {
      id = validateId((request.params as { id?: unknown }).id);
      n = validatePageIndex((request.params as { n?: unknown }).n);
    } catch (err) {
      return sendError(reply, err as ApiError);
    }
    if (!getReceiptMeta(id)) return sendError(reply, notFound("RECEIPT_NOT_FOUND", `no receipt ${id}`));
    const corrupt = digestCorruption(id);
    if (corrupt) return sendError(reply, corrupt);
    let ev: ReceiptEvidence;
    try {
      ev = getReceiptPageEvidence(id, n);
    } catch {
      return sendError(reply, new ApiError(500, "EVIDENCE_CORRUPT", `stored evidence for ${id} page ${n} failed its hash check`));
    }
    if (!ev.found) return sendError(reply, notFound("PAGE_NOT_FOUND", `receipt ${id} has no upstream page ${n}`));
    return sendBytes(request, reply, ev, `receipt ${id} page ${n}`);
  };

  const raw = async (request: FastifyRequest, reply: FastifyReply) => {
    let id: string;
    try {
      id = validateId((request.params as { id?: unknown }).id);
    } catch (err) {
      return sendError(reply, err as ApiError);
    }
    const corrupt = digestCorruption(id);
    if (corrupt) return sendError(reply, corrupt);
    let ev;
    try {
      ev = getReceiptEvidence(id);
    } catch {
      // getReceiptEvidence throws only when the blob fails its own hash
      // or length check: never serve those bytes.
      return sendError(reply, new ApiError(500, "EVIDENCE_CORRUPT", `stored evidence for ${id} failed its hash check`));
    }
    if (!ev.found) return sendError(reply, notFound("RECEIPT_NOT_FOUND", `no receipt ${id}`));
    return sendBytes(request, reply, ev, `receipt ${id}`);
  };

  for (const prefix of ["", "/api"]) {
    app.get(`${prefix}/receipts/:id`, meta);
    app.get(`${prefix}/receipts/:id/raw`, raw);
    // G10 r2 (J2 m4): the /evidence alias is mirrored under /api too.
    app.get(`${prefix}/receipts/:id/evidence`, raw);
    app.get(`${prefix}/receipts/:id/pages/:n/raw`, pageRaw);
    // G10 r2 (J2 m5): CORS preflight, so a browser may send If-None-Match.
    for (const path of ["", "/raw", "/evidence", "/pages/:n/raw"]) {
      app.options(`${prefix}/receipts/:id${path}`, preflight);
    }
  }
}
