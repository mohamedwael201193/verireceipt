#!/usr/bin/env node
// verify.mjs — one-command receipt verification for VeriReceipt (S2).
//
//   node scripts/verify.mjs <receipt_id | audit_url> [--base <url>]
//
// Re-checks, from the live service only (no repo code imported, no
// network besides the service itself):
//   1. GET {base}/receipts/{id}            receipt metadata
//   2. GET {base}/receipts/{id}/raw        exact stored evidence bytes,
//      recomputes sha256 and compares with raw_response_sha256
//   3. GET {base}/.well-known/verireceipt.json   public Ed25519 key
//   4. rebuilds the signed payload from the SERVED metadata fields
//      (stable-JSON, payload tag "verireceipt-receipt-v1") and verifies
//      the Ed25519 `signature`
//
// Exit codes: 0 = PASS (hash + signature verified), 1 = FAIL (fetch
// error, hash mismatch, signature mismatch, malformed response),
// 2 = UNSIGNED (hash verified; the service does not sign receipts).
//
// Zero dependencies; Node >= 20 (global fetch, node:crypto).

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

const RECEIPT_ID_RE = /^rcpt_[A-Z0-9]{26}$/;
const PAYLOAD_TAG = "verireceipt-receipt-v1";
const SIGNED_FIELDS = [
  "receipt_id",
  "intent",
  "upstream_url",
  "raw_response_sha256",
  "quorum_votes",
  "fetched_at",
];
const DEFAULT_BASE = "https://verireceipt.onrender.com";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// --- argument parsing -----------------------------------------------------
const args = process.argv.slice(2);
let baseArg = null;
let target = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--base") {
    baseArg = args[++i] ?? fail("--base needs a value");
  } else if (target === null) {
    target = args[i];
  } else {
    fail(`unexpected extra argument: ${args[i]}`);
  }
}
if (!target) fail("usage: node scripts/verify.mjs <receipt_id | audit_url> [--base <url>]");

let base = (baseArg || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
let id = target;
if (RECEIPT_ID_RE.test(target)) {
  if (!base) base = DEFAULT_BASE;
} else {
  let url;
  try {
    url = new URL(target);
  } catch {
    fail(`target is neither a receipt id nor a URL: ${target}`);
  }
  const m = url.pathname.match(/^(?:\/api)?\/receipts\/(rcpt_[A-Z0-9]{26})\/?$/);
  if (!m) fail(`URL is not a receipt audit URL (.../receipts/rcpt_...): ${target}`);
  id = m[1];
  if (!base) base = url.origin;
}

// --- stable JSON (same rule as src/core/receipt.ts) ------------------------
function stable(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => (v === undefined ? "null" : stable(v))).join(",") + "]";
  }
  if (typeof value === "object") {
    const parts = [];
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      parts.push([JSON.stringify(k), stable(v)]);
    }
    parts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + parts.map(([k, s]) => k + ":" + s).join(",") + "}";
  }
  return "null";
}

async function getJson(url) {
  const res = await fetch(url, { redirect: "error" });
  if (!res.ok) fail(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

// --- 1. metadata ------------------------------------------------------------
console.log(`receipt: ${id}`);
console.log(`base:    ${base}`);
const meta = await getJson(`${base}/receipts/${id}`).catch((e) => fail(e.message));
for (const f of SIGNED_FIELDS) {
  if (!(f in meta)) fail(`metadata is missing field ${f}`);
}
// Target binding (reviewer r147): the service must answer for the exact
// receipt asked for — never accept valid signed metadata for a DIFFERENT
// id (a swap would let any valid receipt masquerade as this one).
if (meta.receipt_id !== id) {
  fail(`service answered with a different receipt_id (${meta.receipt_id}) than requested (${id})`);
}

// --- 2. raw bytes hash ------------------------------------------------------
const rawRes = await fetch(`${base}/receipts/${id}/raw`, { redirect: "error" }).catch((e) => fail(e.message));
if (!rawRes.ok) fail(`GET ${base}/receipts/${id}/raw -> HTTP ${rawRes.status}`);
const rawBytes = Buffer.from(await rawRes.arrayBuffer());
const digest = createHash("sha256").update(rawBytes).digest("hex");
if (digest !== meta.raw_response_sha256) {
  fail(`evidence hash mismatch: sha256(raw)=${digest} but receipt says ${meta.raw_response_sha256}`);
}
console.log(`hash:    OK sha256(raw bytes) == raw_response_sha256 (${digest.slice(0, 16)}..., ${rawBytes.length} bytes)`);

// --- 3+4. signature ---------------------------------------------------------
if (typeof meta.signature !== "string" || !meta.signature) {
  console.log("sign:    receipt carries no signature (service has no signing key configured)");
  console.log("UNSIGNED (hash verified)");
  process.exit(2);
}
const wellKnown = await getJson(`${base}/.well-known/verireceipt.json`).catch((e) => fail(e.message));
if (wellKnown.alg !== "Ed25519" || typeof wellKnown.public_key !== "string") {
  fail("well-known document does not offer an Ed25519 public_key");
}
if (wellKnown.payload !== PAYLOAD_TAG) {
  fail(`well-known payload tag ${JSON.stringify(wellKnown.payload)} != expected ${JSON.stringify(PAYLOAD_TAG)}`);
}
const picked = { payload: PAYLOAD_TAG };
for (const f of SIGNED_FIELDS) picked[f] = meta[f] === undefined ? null : meta[f];
const payloadBytes = Buffer.from(stable(picked), "utf8");

let key;
try {
  key = createPublicKey({ key: Buffer.from(wellKnown.public_key, "base64"), format: "der", type: "spki" });
} catch {
  fail("well-known public_key is not base64 SPKI DER");
}
// Algorithm binding (reviewer r147): a non-Ed25519 key labeled Ed25519
// must be rejected from the parsed key itself, not from the label.
if (key.asymmetricKeyType !== "ed25519") {
  fail(`well-known public_key is ${key.asymmetricKeyType}, not ed25519`);
}
const sig = Buffer.from(meta.signature, "base64");
if (sig.length !== 64) fail(`signature is ${sig.length} bytes, expected 64`);
if (!edVerify(null, payloadBytes, key, sig)) {
  fail(`Ed25519 signature does not verify against key_id ${wellKnown.key_id ?? "(no key_id)"}`);
}
console.log(`sign:    OK Ed25519 signature verifies (key_id ${wellKnown.key_id ?? "unknown"})`);
console.log("PASS");
process.exit(0);
