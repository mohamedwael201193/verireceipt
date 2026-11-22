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
//   - no listing route exists: GET /receipts is 404, and /receipts/
//     (empty id) is 400 INVALID_RECEIPT_ID; neither returns any id.
//   - stored bytes that no longer hash to their recorded digest are DB
//     corruption -> 500 EVIDENCE_CORRUPT; wrong bytes are never served.
//     Metadata agrees with /raw (G10 r2): the blob is verified for the
//     metadata too, so a corrupt blob shows evidence_available:false,
//     evidence_status "corrupt"; a missing one "missing"; else "ok". A
//     stored digest that is not a SHA-256 (main or any page) answers 500
//     RECEIPT_CORRUPT on metadata, /raw and page /raw alike.
//   - /raw responses carry ETag "<hex>"; If-None-Match matching it -> 304
//     (checked only after the bytes pass their hash check). A CORS
//     OPTIONS request on any receipt route answers 204.
//   - Metadata verifies blobs without blocking the event loop (G10 r3):
//     async gunzip + sliced SHA-256, verdict cached per stored blob
//     (core/evidenceVerify.ts); /raw still verifies before every send.
//
// Hash format (canonical, see normalizeSha256Hex in core/receipt.ts):
// raw_response_sha256 is 64 lowercase hex
// characters, no "0x" prefix (what `sha256sum` prints). Rows stored by
// builds that emitted "0x"+hex are served in the canonical form. The /raw
// response repeats the digest in X-Raw-SHA256 (same format) and in
// Repr-Digest (RFC 9530, sha-256 as base64), so a verifier can recompute
// sha256(body) and compare without a second request.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError, badRequest, errorBody } from "./errors";
import type { ReceiptEvidence, StoredReceiptMeta } from "./db";
import { EvidenceCorruptError } from "./db";
import { getReceiptEvidence, getReceiptMeta, getReceiptPageEvidence, getReceiptPages } from "./storage";
import { RECEIPT_ID_RE, normalizeSha256Hex, publicBaseUrl, sha256Hex } from "./receipt";
import { receiptSigningPublicInfo, signReceipt } from "./receiptSign";
import { checkEvidence, recordVerified, type EvidenceStatus } from "./evidenceVerify";

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


/**
 * G10 r2 (J2 m3): one digest check shared by metadata, /raw and every
 * page /raw, so a receipt whose stored main OR page digest is not a
 * SHA-256 answers 500 RECEIPT_CORRUPT on all of them (previously meta
 * 500 but /raw 404).
 */
async function digestCorruption(id: string, metaRow?: StoredReceiptMeta | null): Promise<ApiError | null> {
  // G10 r3: the metadata route passes the row it already read (one row
  // read per call instead of two).
  const row = metaRow === undefined ? await getReceiptMeta(id) : metaRow;
  if (!row) return null;
  if (normalizeSha256Hex(row.raw_response_sha256) === null) {
    return new ApiError(500, "RECEIPT_CORRUPT", `stored digest for ${id} is not a SHA-256`);
  }
  for (const p of await getReceiptPages(id)) {
    if (normalizeSha256Hex(p.raw_response_sha256) === null) {
      return new ApiError(500, "RECEIPT_CORRUPT", `stored digest for ${id} page ${p.page_index} is not a SHA-256`);
    }
  }
  return null;
}

/** CORS OPTIONS request on the receipt routes (lets a browser send If-None-Match). */
function corsOptions(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .status(204)
    .header("access-control-allow-origin", "*")
    .header("access-control-allow-methods", "GET, HEAD, OPTIONS")
    .header("access-control-allow-headers", "If-None-Match")
    .header("access-control-max-age", "86400")
    .send();
}

export function registerReceiptRoutes(app: FastifyInstance): void {
  // Public Ed25519 verify key + the exact signing contract, so any holder
  // of a receipt can verify it offline (scripts/verify.mjs does). 404
  // when no signing key is configured — never a placeholder key.
  app.get("/.well-known/verireceipt.json", async (_request, reply) => {
    const info = receiptSigningPublicInfo();
    if (!info) {
      return sendError(
        reply,
        notFound("SIGNING_NOT_CONFIGURED", "receipt signing is not configured on this service"),
      );
    }
    return reply
      .header("cache-control", "public, max-age=300")
      .header("access-control-allow-origin", "*")
      .type("application/json; charset=utf-8")
      .send(info);
  });

  const meta = async (request: { params: unknown }, reply: FastifyReply) => {
    let id: string;
    try {
      id = validateId((request.params as { id?: unknown }).id);
    } catch (err) {
      return sendError(reply, err as ApiError);
    }
    const row = await getReceiptMeta(id);
    if (!row) return sendError(reply, notFound("RECEIPT_NOT_FOUND", `no receipt ${id}`));
    const base = publicBaseUrl();
    // A stored digest that is not a SHA-256 is corruption, not a format.
    const corrupt = await digestCorruption(id, row);
    if (corrupt) return sendError(reply, corrupt);
    const digest = normalizeSha256Hex(row.raw_response_sha256) as string;
    // Ed25519 signing (S2): sign the exact content fields served here, so
    // a verifier can rebuild the payload from THIS response. Covers
    // legacy rows too (they are signed at serve time, not at write time).
    // undefined when no key is configured -> the field is omitted.
    const signature = signReceipt({
      receipt_id: row.receipt_id,
      intent: row.intent,
      upstream_url: row.upstream_url,
      raw_response_sha256: digest,
      quorum_votes: row.quorum_votes,
      fetched_at: row.fetched_at,
    });
    // G10 r2 (J2 m3): evidence_available reflects what /raw would
    // actually do — the blob is verified (gunzip + length + sha256), not
    // just checked for presence. A corrupt blob is evidence_available:
    // false with evidence_status "corrupt" (and /raw answers 500
    // EVIDENCE_CORRUPT); a legacy/pruned row is "missing" (/raw 404).
    // G10 r3 (r2-m1): verified asynchronously and cached per stored blob
    // (core/evidenceVerify.ts) — never a synchronous unzip+hash per call.
    const mainEv = row.evidence_available
      ? await checkEvidence(id, null, row.raw_response_sha256, row.evidence_bytes)
      : { status: "missing" as EvidenceStatus, bytes: 0 };
    const pages = await getReceiptPages(id);
    const upstreamPages: Array<Record<string, unknown>> = [];
    for (const p of pages) {
      const pageDigest = normalizeSha256Hex(p.raw_response_sha256) as string;
      const pageEv = p.evidence_available
        ? await checkEvidence(id, p.page_index, p.raw_response_sha256, p.evidence_bytes)
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
        ...(signature ? { signature, signature_alg: "Ed25519" } : {}),
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
    if (!(await getReceiptMeta(id))) return sendError(reply, notFound("RECEIPT_NOT_FOUND", `no receipt ${id}`));
    const corrupt = await digestCorruption(id);
    if (corrupt) return sendError(reply, corrupt);
    let ev: ReceiptEvidence;
    try {
      ev = await getReceiptPageEvidence(id, n);
    } catch (err) {
      // Only a decode/hash failure is corruption; a storage error (e.g. a
      // Postgres connection reset) rethrows -> the error handler's 502.
      if (!(err instanceof EvidenceCorruptError)) throw err;
      await recordVerified(id, n, "corrupt", 0);
      return sendError(reply, new ApiError(500, "EVIDENCE_CORRUPT", `stored evidence for ${id} page ${n} failed its hash check`));
    }
    if (!ev.found) return sendError(reply, notFound("PAGE_NOT_FOUND", `receipt ${id} has no upstream page ${n}`));
    if (ev.evidence !== null && ev.sha256 !== null) await recordVerified(id, n, "ok", ev.evidence.length, { sha256: ev.sha256, evidenceBytes: ev.evidenceBytes });
    return sendBytes(request, reply, ev, `receipt ${id} page ${n}`);
  };

  const raw = async (request: FastifyRequest, reply: FastifyReply) => {
    let id: string;
    try {
      id = validateId((request.params as { id?: unknown }).id);
    } catch (err) {
      return sendError(reply, err as ApiError);
    }
    const corrupt = await digestCorruption(id);
    if (corrupt) return sendError(reply, corrupt);
    let ev;
    try {
      ev = await getReceiptEvidence(id);
    } catch (err) {
      // Only a decode/hash failure is corruption; a storage error (e.g. a
      // Postgres connection reset) rethrows -> the error handler's 502.
      if (!(err instanceof EvidenceCorruptError)) throw err;
      // getReceiptEvidence throws only when the blob fails its own hash
      // or length check: never serve those bytes.
      await recordVerified(id, null, "corrupt", 0);
      return sendError(reply, new ApiError(500, "EVIDENCE_CORRUPT", `stored evidence for ${id} failed its hash check`));
    }
    if (!ev.found) return sendError(reply, notFound("RECEIPT_NOT_FOUND", `no receipt ${id}`));
    if (ev.evidence !== null && ev.sha256 !== null) await recordVerified(id, null, "ok", ev.evidence.length, { sha256: ev.sha256, evidenceBytes: ev.evidenceBytes });
    return sendBytes(request, reply, ev, `receipt ${id}`);
  };

  for (const prefix of ["", "/api"]) {
    app.get(`${prefix}/receipts/:id`, meta);
    app.get(`${prefix}/receipts/:id/raw`, raw);
    // G10 r2 (J2 m4): the /evidence alias is mirrored under /api too.
    app.get(`${prefix}/receipts/:id/evidence`, raw);
    app.get(`${prefix}/receipts/:id/pages/:n/raw`, pageRaw);
    // G10 r2 (J2 m5): answer the CORS OPTIONS request, so a browser may
    // send If-None-Match.
    for (const path of ["", "/raw", "/evidence", "/pages/:n/raw"]) {
      app.options(`${prefix}/receipts/:id${path}`, corsOptions);
    }
  }
}
