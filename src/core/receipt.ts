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

export function sha256Hex(data: string | Buffer): string {
  return "0x" + createHash("sha256").update(data).digest("hex");
}

export function newReceiptId(): string {
  const bytes = randomBytes(26);
  let id = "";
  for (let i = 0; i < 26; i++) {
    id += RECEIPT_ID_ALPHABET[bytes[i] % RECEIPT_ID_ALPHABET.length];
  }
  return "rcpt_" + id;
}

export function makeReceipt(
  intent: string,
  upstreamUrl: string,
  rawBody: string | Buffer,
  quorumVotes: string,
): Receipt {
  const receipt_id = newReceiptId();
  // Validate PUBLIC_BASE_URL: an unparseable base falls back to the default,
  // and a valid base contributes only its origin (any path is stripped, so
  // e.g. "https://example.com/api" cannot produce a likely-404 audit path).
  // Empty string still means "use the default".
  const DEFAULT_BASE_URL = "https://verireceipt.onrender.com";
  const rawBase = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "") || DEFAULT_BASE_URL;
  let baseUrl: string;
  try {
    baseUrl = new URL(rawBase).origin;
  } catch {
    baseUrl = DEFAULT_BASE_URL;
  }
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
