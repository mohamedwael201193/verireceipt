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
  const baseUrl = (process.env.PUBLIC_BASE_URL || "https://verireceipt.onrender.com").replace(
    /\/+$/,
    "",
  );
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
