// G10 r3 — non-blocking evidence verification for GET /receipts/:id
// (J1 n1 / J2 r2-m1). G10 r4: cache-hit counters, per-key generation
// so an in-flight verification cannot overwrite a newer /raw verdict,
// and gunzip output is bounded (J1 M1, J2 m1/m2).
//
// The metadata route reports evidence_status ("ok" | "missing" |
// "corrupt") for the main evidence and every page, so that it agrees with
// what /raw would do (G10 r2, J2 m3). Round 2 did that with the
// synchronous getters (gunzipSync + one big sha256 per blob on every
// call): a 2 x 20 MB receipt blocked the event loop ~0.14 s per call.
//
// Here a blob is verified:
//   - asynchronously: zlib.gunzip runs on the libuv threadpool, and the
//     SHA-256 is fed in 1 MiB slices with a setImmediate yield between
//     slices, so other requests keep being served while a large blob is
//     checked;
//   - once: the verdict is cached per (receipt id, part, stored digest,
//     recorded length) — all read from the metadata row the route already
//     loads, so a cache hit never touches the blob (zero blob reads,
//     gunzips, and hashes). Receipts are immutable audit rows
//     (INSERT OR IGNORE): the stored bytes for a given id/part/digest do
//     not change in normal operation. A pruned blob reads as "missing"
//     (has_evidence false) before the cache is consulted;
//   - once per key even under concurrency: parallel calls share one
//     in-flight verification.
// /raw keeps verifying the exact bytes on every call before serving them
// and feeds its result back here (recordVerified). A blob altered in
// place behind the server's back AFTER a cached "ok" (same digest and
// length columns) keeps reading "ok" in metadata until /raw is asked for
// it or the process restarts; /raw never serves it (500
// EVIDENCE_CORRUPT), and from then on metadata says "corrupt" too.
// recordVerified bumps a per-key generation; an in-flight verification
// started at an older generation does not remember its result over that
// newer verdict (G10 r4, J2 m1).
//
// The comparison is the same as db.getReceiptEvidence: decompressed
// length === evidence_bytes AND sha256Hex(bytes) === the stored digest
// string, exactly. gunzip is bounded to evidence_bytes + 1
// (maxOutputLength) and fails closed as corrupt (G10 r4, J2 m2).
//
// Event-loop residual (honest, not "non-blocking"): a cache miss still
// does a synchronous SQLite blob/row read. vs r2 this is ~2× better;
// the worst observed stall on a 40 MB row can approach the old sync
// cost (see G10-R4-BUILD.md). Real evidence today is KB-sized.

import { createHash } from "crypto";
import { gunzip } from "zlib";
import { promisify } from "util";
import { getEvidenceBlob, getReceiptMeta, getReceiptPages, type StoredEvidenceBlob } from "./db";

const gunzipAsync = promisify(gunzip);

export type EvidenceStatus = "ok" | "missing" | "corrupt";
export interface EvidenceCheck {
  status: EvidenceStatus;
  /** Uncompressed length when ok, else 0. */
  bytes: number;
}

/** Hash slice size; one setImmediate yield per slice. */
export const VERIFY_SLICE_BYTES = 1024 * 1024;
/** Max cached verdicts (oldest evicted first). */
export const VERIFY_CACHE_MAX = 2048;

const cache = new Map<string, EvidenceCheck>();
const inflight = new Map<string, Promise<EvidenceCheck>>();
/** Bumped by recordVerified so a late in-flight remember() cannot clobber it. */
const keyGen = new Map<string, number>();

/** Work counters: a cache hit must leave all three unchanged (G10 r4, J1 M1). */
export const evidenceVerifyStats = {
  blobReads: 0,
  gunzips: 0,
  hashes: 0,
};

export function resetEvidenceVerifyStats(): void {
  evidenceVerifyStats.blobReads = 0;
  evidenceVerifyStats.gunzips = 0;
  evidenceVerifyStats.hashes = 0;
}

function currentGen(key: string): number {
  return keyGen.get(key) ?? 0;
}

function cacheKey(id: string, part: number | null, storedSha256: string, evidenceBytes: number): string {
  return [id, part === null ? "main" : `p${part}`, storedSha256, evidenceBytes].join("|");
}

function remember(key: string, value: EvidenceCheck): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > VERIFY_CACHE_MAX) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
    if (!inflight.has(oldest)) keyGen.delete(oldest);
  }
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Test-only: pause after the blob is read, before unzip/hash, so races are deterministic. */
let pauseAfterBlobRead: (() => Promise<void>) | null = null;

export function setEvidenceVerifyPauseForTests(hook: (() => Promise<void>) | null): void {
  pauseAfterBlobRead = hook;
}

async function verifyBlob(blob: StoredEvidenceBlob & { gzip: Buffer }): Promise<EvidenceCheck> {
  let bytes: Buffer;
  try {
    evidenceVerifyStats.gunzips += 1;
    // Fail closed if a tampered gzip expands past the recorded length (J2 m2).
    bytes = await gunzipAsync(blob.gzip, { maxOutputLength: blob.evidenceBytes + 1 });
  } catch {
    return { status: "corrupt", bytes: 0 };
  }
  if (bytes.length !== blob.evidenceBytes) return { status: "corrupt", bytes: 0 };
  evidenceVerifyStats.hashes += 1;
  const h = createHash("sha256");
  for (let off = 0; off < bytes.length; off += VERIFY_SLICE_BYTES) {
    h.update(bytes.subarray(off, off + VERIFY_SLICE_BYTES));
    if (off + VERIFY_SLICE_BYTES < bytes.length) await yieldToLoop();
  }
  if (h.digest("hex") !== blob.sha256) return { status: "corrupt", bytes: 0 };
  return { status: "ok", bytes: bytes.length };
}

/**
 * Evidence status of a receipt's main blob (part null) or page `part`,
 * given the digest and length columns of the row the caller has already
 * read (the caller has also checked the blob is present). A cache hit
 * reads nothing; a miss loads the blob once and verifies it async.
 */
export async function checkEvidence(
  id: string,
  part: number | null,
  storedSha256: string,
  evidenceBytes: number,
): Promise<EvidenceCheck> {
  const key = cacheKey(id, part, storedSha256, evidenceBytes);
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const startedGen = currentGen(key);
  const p = (async (): Promise<EvidenceCheck> => {
    // Let the caller's synchronous row reads finish their tick before the
    // (synchronous) blob read, so the two never form one long block.
    await yieldToLoop();
    evidenceVerifyStats.blobReads += 1;
    const blob = getEvidenceBlob(id, part);
    if (!blob || blob.gzip === null) return { status: "missing", bytes: 0 }; // pruned meanwhile: not cached
    if (pauseAfterBlobRead) await pauseAfterBlobRead();
    await yieldToLoop();
    const result = await verifyBlob(blob as StoredEvidenceBlob & { gzip: Buffer });
    // Cache only a verdict for the row the key describes, and only if
    // recordVerified has not already written a newer verdict for it.
    if (blob.sha256 === storedSha256 && blob.evidenceBytes === evidenceBytes && currentGen(key) === startedGen) {
      remember(key, result);
      return result;
    }
    // Generation moved (recordVerified won) or the blob no longer
    // matches the key: do not overwrite a newer cached verdict.
    return cache.get(key) ?? result;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Feed a /raw verification result back into the cache (G10 r3), so
 * metadata agrees with the latest /raw outcome for the same stored row.
 * `stored` is the row's digest/length when /raw already has them;
 * otherwise they are read from the small metadata columns (no blob copy).
 * Bumps the per-key generation so a still-running checkEvidence cannot
 * remember an older "ok" over this verdict (G10 r4).
 */
export function recordVerified(
  id: string,
  part: number | null,
  status: "ok" | "corrupt",
  bytes: number,
  stored?: { sha256: string; evidenceBytes: number },
): void {
  let row = stored;
  if (!row) {
    if (part === null) {
      const m = getReceiptMeta(id);
      if (m) row = { sha256: m.raw_response_sha256, evidenceBytes: m.evidence_bytes };
    } else {
      const pg = getReceiptPages(id).find((x) => x.page_index === part);
      if (pg) row = { sha256: pg.raw_response_sha256, evidenceBytes: pg.evidence_bytes };
    }
  }
  if (!row) return;
  const key = cacheKey(id, part, row.sha256, row.evidenceBytes);
  keyGen.set(key, currentGen(key) + 1);
  remember(key, { status, bytes: status === "ok" ? bytes : 0 });
}

/** Test hook: forget every cached verdict. */
export function clearEvidenceVerifyCache(): void {
  cache.clear();
  keyGen.clear();
}

/** Test/ops visibility: number of cached verdicts. */
export function evidenceVerifyCacheSize(): number {
  return cache.size;
}
