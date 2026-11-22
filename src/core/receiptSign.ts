// Ed25519 signatures over receipts (S2 audit-trail hardening, 2026-11-22).
//
// What is signed: the receipt's CONTENT fields only —
//   receipt_id, intent, upstream_url, raw_response_sha256,
//   quorum_votes, fetched_at
// plus a domain-separation payload tag. audit_url / raw_url are NOT
// signed: they are derived from PUBLIC_BASE_URL (deployment-specific),
// and a verifier recomputes the payload from the served metadata, so the
// signature must not depend on which deployment served it.
//
// Canonicalization: stableStringify (core/receipt.ts) — keys sorted
// recursively, UTF-8 bytes of that string are the signed message. The
// same canonicalization already backs raw_response_sha256, so one rule
// covers both hashes and signatures.
//
// Key handling: the Ed25519 PRIVATE key is read from the environment
// variable VERIRECEIPT_RECEIPT_SIGNING_KEY (PEM, or base64 PKCS#8 DER).
// It is provisioned out-of-band (vault route into the host's env) and is
// never committed, logged, or served. Only the DERIVED public key is
// published, at GET /.well-known/verireceipt.json. When the variable is
// absent or invalid, signing is DISABLED: receipts carry no `signature`
// field (the field is omitted, never fabricated) and the well-known
// route answers 404 SIGNING_NOT_CONFIGURED.
//
// Signature format: base64 (standard alphabet) of the 64-byte Ed25519
// signature, attached as `signature` on the receipt JSON.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "crypto";
import { stableStringify } from "./receipt";

export const RECEIPT_SIGNING_KEY_ENV = "VERIRECEIPT_RECEIPT_SIGNING_KEY";
export const RECEIPT_SIGNATURE_PAYLOAD = "verireceipt-receipt-v1";
export const RECEIPT_SIGNED_FIELDS = [
  "receipt_id",
  "intent",
  "upstream_url",
  "raw_response_sha256",
  "quorum_votes",
  "fetched_at",
] as const;

/** The receipt content a signature binds (subset of Receipt). */
export interface ReceiptSignable {
  receipt_id: string;
  intent: string;
  upstream_url: string;
  raw_response_sha256: string;
  quorum_votes: string | null;
  fetched_at: string;
}

/**
 * The exact bytes that are signed: UTF-8 of the stable-JSON object
 * {payload, ...signed fields}. Deterministic for a given receipt, so a
 * verifier that re-derives it from served metadata gets the same bytes.
 */
export function receiptSigningPayload(receipt: ReceiptSignable): Buffer {
  const picked: Record<string, unknown> = { payload: RECEIPT_SIGNATURE_PAYLOAD };
  for (const field of RECEIPT_SIGNED_FIELDS) {
    picked[field] = receipt[field] === undefined ? null : receipt[field];
  }
  return Buffer.from(stableStringify(picked), "utf8");
}

function decodePrivateKey(raw: string): KeyObject {
  const trimmed = raw.trim();
  const key = trimmed.includes("PRIVATE KEY")
    ? createPrivateKey(trimmed)
    : createPrivateKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`expected an Ed25519 key, got ${String(key.asymmetricKeyType)}`);
  }
  return key;
}

let privateKey: KeyObject | null = null;
let publicKey: KeyObject | null = null;
let publicKeyDerB64: string | null = null;

/**
 * (Re)configure signing from the environment. Always resets first, so
 * tests can flip configurations within one process. Returns true when a
 * valid Ed25519 key is active. An invalid value disables signing and
 * logs a warning — it never throws at boot and never signs with a
 * partially-parsed key.
 */
export function configureReceiptSigningFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  privateKey = null;
  publicKey = null;
  publicKeyDerB64 = null;
  const raw = env[RECEIPT_SIGNING_KEY_ENV];
  if (!raw || !raw.trim()) return false;
  try {
    privateKey = decodePrivateKey(raw);
  } catch (err) {
    console.error(
      `verireceipt: receipt signing DISABLED — ${RECEIPT_SIGNING_KEY_ENV} is not a valid ` +
        `Ed25519 private key (PEM or base64 PKCS#8): ${(err as Error).message}`,
    );
    privateKey = null;
    return false;
  }
  publicKey = createPublicKey(privateKey);
  publicKeyDerB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return true;
}

export function receiptSigningActive(): boolean {
  return privateKey !== null;
}

/**
 * Base64 Ed25519 signature over the receipt content, or undefined when
 * signing is not configured. Registered as the receipt signer at server
 * boot (server.ts setReceiptSigner); also used to sign legacy stored
 * rows at serve time.
 */
export function signReceipt(receipt: ReceiptSignable): string | undefined {
  if (!privateKey) return undefined;
  return edSign(null, receiptSigningPayload(receipt), privateKey).toString("base64");
}

/**
 * Verification, mirroring exactly what scripts/verify.mjs does
 * client-side. publicKeyDerB64 is the base64 SPKI DER from
 * /.well-known/verireceipt.json.
 */
export function verifyReceiptSignature(
  receipt: ReceiptSignable,
  signatureB64: string,
  publicKeyDerB64Input: string,
): boolean {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(publicKeyDerB64Input, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
  } catch {
    return false;
  }
  const sig = Buffer.from(signatureB64, "base64");
  if (sig.length !== 64) return false;
  try {
    return edVerify(null, receiptSigningPayload(receipt), key, sig);
  } catch {
    return false;
  }
}

/**
 * The document served at /.well-known/verireceipt.json when signing is
 * configured, else null. key_id is a fingerprint of the public key
 * (first 16 hex chars of sha256 of the SPKI DER), so key rotation is
 * observable without exposing anything but the public key.
 */
export function receiptSigningPublicInfo(): Record<string, unknown> | null {
  if (!publicKeyDerB64) return null;
  const fingerprint = createHash("sha256")
    .update(Buffer.from(publicKeyDerB64, "base64"))
    .digest("hex")
    .slice(0, 16);
  return {
    service: "verireceipt",
    alg: "Ed25519",
    key_id: `ed25519-${fingerprint}`,
    public_key: publicKeyDerB64,
    public_key_encoding: "base64(spki-der)",
    payload: RECEIPT_SIGNATURE_PAYLOAD,
    signed_fields: [...RECEIPT_SIGNED_FIELDS],
    canonicalization:
      "UTF-8 of stable-json: object keys sorted recursively, arrays in order, no whitespace",
    signature_encoding: "base64",
    verify:
      "GET /receipts/{id} for metadata, GET /receipts/{id}/raw for evidence bytes; " +
      "recompute sha256(raw) == raw_response_sha256, rebuild the payload from " +
      "signed_fields + payload tag, verify `signature` with public_key",
  };
}
