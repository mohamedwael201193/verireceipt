import { createHash, randomBytes } from "crypto";

export interface Receipt {
  receipt_id: string;
  intent: string;
  upstream_url: string;
  raw_response_sha256: string;
  quorum_votes: string;
  fetched_at: string;
  audit_url: string;
}

const RECEIPT_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// Bare 64-character lowercase hex (NO "0x" prefix): the miner contract
// (JUDGE.md §1) and scripts/run-traptest.ts require /^[0-9a-f]{64}$/.
// A "0x"-prefixed form made TrapTest 12/12 unreachable, so the prefix
// was removed 2026-11-20 (TX Judge round 3) and every consumer/test was
// aligned to bare-64.
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Deterministic JSON serialization: object keys sorted recursively
 * (lexicographically, by UTF-16 code unit), arrays kept in order.
 * Two deep-equal JSON values serialize to the same string regardless of
 * the key order they were parsed or constructed in.
 *
 * WHY this exists (receipt-fix, 2026-11-20): DeFiLlama's
 * /protocol/{slug} body is NOT byte-stable across fetches — measured
 * live, two fetches one minute apart served the same top-level keys
 * with the `chains` array order permuted and the live values moved
 * (last tvl point $15,096,985,033 @1795170731 vs $15,072,112,929
 * @1795178651), so even a sorted-keys re-serialization of the WHOLE
 * body hashes differently per fetch. TVL receipts therefore hash a
 * PINNED canonical evidence object built from the parsed payload
 * (see src/handlers/tvl.ts), serialized with this function, and the
 * exact bytes are stored and served at GET /receipts/:id/raw.
 * A re-hash of the SERVED bytes always matches; a re-fetch of the
 * upstream URL is not the verification path (see JUDGE.md §4).
 *
 * Values are JSON data only. `undefined` / function / symbol values
 * behave as in JSON.stringify (dropped from objects, null in arrays,
 * "null" at the top level); bigint is treated the same (JSON.stringify
 * would throw — this never does). Non-JSON values are NOT supported:
 * a Date (or any object with no enumerable own properties) serializes
 * to `{}` — two different Dates collide — so callers must only pass
 * JSON-parsed data (the receipt evidence paths do: every input here is
 * a parsed upstream JSON body or a constructed plain object).
 */
function stableStringifyInner(value: unknown): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringifyInner(v) ?? "null").join(",") + "]";
  }
  if (typeof value === "object") {
    // R2 (F2): single-pass — each nested value is evaluated exactly
    // ONCE and its serialized form kept. The old code evaluated each
    // value twice (once in .filter(), once in .map()), so cost doubled
    // per nesting level: depth 20 took ~4 s, depth 100 hung. A
    // pre-pass filter + a second map over the same entries is still
    // two passes over the entries, but the recursion itself is once
    // per value — cost is now linear in the size of the value.
    const serialized: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = stableStringifyInner(v);
      if (s !== undefined) serialized.push([k, s]);
    }
    serialized.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      "{" +
      serialized.map(([k, s]) => JSON.stringify(k) + ":" + s).join(",") +
      "}"
    );
  }
  return undefined;
}

export function stableStringify(value: unknown): string {
  return stableStringifyInner(value) ?? "null";
}

export function newReceiptId(): string {
  const bytes = randomBytes(26);
  let id = "";
  for (let i = 0; i < 26; i++) {
    id += RECEIPT_ID_ALPHABET[bytes[i] % RECEIPT_ID_ALPHABET.length];
  }
  return "rcpt_" + id;
}

/**
 * Public origin used in audit_url / raw_url. Validate PUBLIC_BASE_URL: an
 * unparseable base falls back to the default, and a valid base contributes
 * only its origin (any path is stripped, so e.g. "https://example.com/api"
 * cannot produce a likely-404 audit path). Empty string still means "use
 * the default". Read at call time so tests can set it.
 */
export function publicBaseUrl(): string {
  const DEFAULT_BASE_URL = "https://verireceipt.onrender.com";
  const rawBase = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "") || DEFAULT_BASE_URL;
  try {
    return new URL(rawBase).origin;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

/**
 * Receipt id shape (G10): "rcpt_" + 26 characters of A-Z0-9, exactly what
 * newReceiptId() emits (and what every earlier build emitted). Anything
 * else is a malformed id — rejected before any DB access.
 */
export const RECEIPT_ID_RE = /^rcpt_[A-Z0-9]{26}$/;

/**
 * Canonical receipt hash format (G10, documented in README "Receipts"):
 * raw_response_sha256 is the SHA-256 of the exact evidence bytes as 64
 * LOWERCASE hex characters with NO "0x" prefix — the same string
 * `sha256sum` prints. Builds up to 66868d7 emitted "0x" + hex; rows
 * stored by those builds are normalised to the canonical form when
 * served. Returns null for anything that is not a SHA-256 digest.
 */
export function normalizeSha256Hex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export function makeReceipt(
  intent: string,
  upstreamUrl: string,
  rawBody: string | Buffer,
  quorumVotes: string,
): Receipt {
  const receipt_id = newReceiptId();
  const baseUrl = publicBaseUrl();
  return {
    receipt_id,
    intent,
    upstream_url: upstreamUrl,
    raw_response_sha256: sha256Hex(rawBody),
    quorum_votes: quorumVotes,
    fetched_at: new Date().toISOString(),
    audit_url: baseUrl + "/receipts/" + receipt_id,
  };
}

export function envelope(
  intent: string,
  fields: Record<string, unknown>,
  receipt: Receipt,
  meta: { answer: string; verdict: string; confidence: number; source: string },
): Record<string, unknown> {
  const RESERVED = ["answer", "verdict", "confidence", "source", "checked_at", "receipt"];
  for (const key of RESERVED) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new Error(`envelope field collides with reserved key: ${key}`);
    }
  }
  return {
    ...fields,
    answer: meta.answer,
    verdict: meta.verdict,
    confidence: meta.confidence,
    source: meta.source,
    checked_at: new Date().toISOString(),
    receipt,
  };
}
