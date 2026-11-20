# Miner Audit-Endpoint Contract (what the Desk needs from the miner)

**Status: NOT YET IMPLEMENTED on the live miner — this is the gate.**
Live check 2026-11-20 ~18:30 EET: `GET
https://verireceipt.onrender.com/receipts/rcpt_TSUA27HVHTJZIU50P05LMBZ1C3`
(a real TVL receipt issued minutes earlier, `audit_url` from the live
response) returns **HTTP 404**, and `GET /receipts` returns **404** too.
The miner has **no `/receipts/:id` route at all** in `src/server.ts`,
and its SQLite `miner_receipts` table stores only the hash — not the
raw bytes. Until this contract ships, no Desk receipt re-hash can
honestly report MATCH, and every Desk re-hash report must say UNPROVEN.

## Why this contract exists

The miner hashes the **raw upstream response bytes** at fetch time
(`receipt.raw_response_sha256`). The Desk's browser re-hash must hash
**those exact stored bytes**. Re-fetching the live upstream cannot
work: DeFiLlama / SEC EDGAR return fresh data on every fetch, so the
re-fetch hash legitimately differs from the fetch-time hash — that is
why the live TVL receipt re-hashed DIGEST MISMATCH on 2026-11-20
15:08 EET. A mismatch from a fresh re-fetch proves nothing about the
receipt; only the stored bytes can prove MATCH or MISMATCH.

## Required endpoints (miner side)

### 1. `GET /receipts/:id` — receipt page (JSON)

The URL the receipt already advertises as `audit_url`. Returns 200
with the stored receipt record:

```json
{
  "receipt_id": "rcpt_…",
  "intent": "TVL_LOOKUP_GENERAL",
  "upstream_url": "https://api.llama.fi/protocol/aave-v3",
  "raw_response_sha256": "0x…64 hex…",
  "fetched_at": "2026-11-20T16:25:57.739Z",
  "raw_url": "https://verireceipt.onrender.com/receipts/rcpt_…/raw"
}
```

Unknown `receipt_id` → **404** with `{"error": "receipt not found"}`.
Malformed `receipt_id` (not `rcpt_` + 26 `[A-Z0-9]`) → **400**.

### 2. `GET /receipts/:id/raw` — the exact stored raw bytes (THE GATE)

- **Response body: the exact bytes the miner hashed at fetch time,
  byte-identical.** No re-encoding, no JSON re-serialisation, no
  whitespace normalisation, no BOM added or stripped, no gzip
  re-compression that changes bytes (serve identity or set
  `Content-Length` to the stored length).
- `Content-Type: application/octet-stream` (or the upstream's original
  content type, recorded at fetch time). `Content-Length` MUST equal
  the stored byte length. `Cache-Control: public, immutable` (receipts
  never change).
- Unknown `receipt_id` → **404** `{"error": "receipt not found"}`.
- Receipt known but raw bytes were never stored (all receipts issued
  before this ships) → **404** with
  `{"error": "raw bytes not stored for this receipt"}` — an honest
  unavailable, never a fresh upstream re-fetch served as if it were
  the stored bytes.
- **Storage requirement:** the miner MUST persist the raw bytes at
  answer time, alongside the hash — e.g. a `raw_response BLOB`
  column on `miner_receipts` (or a `receipt_raw_bytes` table keyed by
  `receipt_id`), written in the same transaction as the receipt row.
  The current schema stores only the hash; without this column the
  endpoint cannot exist.

## Verification rule (Desk side)

```
SHA-256(GET /receipts/:id/raw) == receipt.raw_response_sha256
```

Comparison ignores the `0x` prefix and case. MATCH → verified.
MISMATCH → the stored bytes do not hash to the recorded digest
(report both hashes). Audit endpoint 404 → **UNAVAILABLE, not
MISMATCH**: the Desk reports "audit endpoint not deployed yet" and
the re-hash story stays UNPROVEN.

## Verification modes (labels the miner MUST carry per receipt)

The blueprint's "30s live re-curl" claim is mathematically broken for
mutable APIs: DeFiLlama / SEC EDGAR return fresh bytes on every fetch,
so a live re-fetch can never reproduce the fetch-time bytes, and a
re-curl mismatch proves nothing about the receipt. Verification must
hash STORED bytes. Each receipt therefore carries a `verification_mode`
label, and the Desk verifies each mode only by its own method:

| `verification_mode` | Meaning | How the Desk verifies it |
|---|---|---|
| `snapshot_raw_digest` (default, ALL five intents) | The digest covers the exact raw upstream bytes as fetched at answer time. Those bytes are mutable upstream — a live re-fetch will differ. | **Only** via the stored bytes: `SHA-256(GET /receipts/:id/raw) == raw_response_sha256`. A live re-curl is never attempted for these receipts, and a re-curl mismatch is never reported as a receipt failure. |
| `immutable_live_recheck` | The digest covers bytes a live re-fetch is *guaranteed* to reproduce byte-identically — only for queries against a provably immutable upstream (content-addressed, or pinned to a finalized block with a byte-stable response). The miner must be able to state why the bytes are immutable; "the upstream usually returns the same data" does not qualify. | Either via the stored bytes (same as above) or via a live re-fetch of `upstream_url` hashed immediately. |

Rules:
- The miner MUST include `verification_mode` on every receipt (new
  field on the `Receipt` object, alongside `raw_response_sha256`).
  A receipt without the label is treated as `snapshot_raw_digest`.
- The Desk's `AuditRehashControl` ("Recompute from stored bytes") is
  the verification path for `snapshot_raw_digest` receipts — the only
  path that can honestly report MATCH or MISMATCH for them.
- The existing frontend upstream re-fetch (VerifyPanel) is valid ONLY
  for `immutable_live_recheck` receipts. For `snapshot_raw_digest`
  receipts it must be labelled as informational ("live data has moved
  since fetch time — a mismatch here proves nothing"), never as a
  verification verdict. The panel enforces this by gating on
  `receipt.verification_mode`: for snapshot receipts it shows no
  re-fetch button and no MATCH / MISMATCH verdict at all — only the
  stored-bytes re-hash below can verify them. (An earlier draft of
  this contract claimed the panel "already says this for TVL" — that
  was false: the shipped panel rendered SHA-256 MATCH VERIFIED ✓ and a
  DIGEST MISMATCH "not verified" verdict for snapshot receipts. The
  gate above is the fix.)
- The `/v1/tx` JSON-RPC replay and `/v1/grid-price` canonical-evidence
  re-hash already in the frontend are `immutable_live_recheck`
  constructions (replay of a deterministic call / rebuild of canonical
  JSON) — they stay as-is and should be labelled so.

Caveat (round-2 review): the `immutable_live_recheck` classification
trusts the miner's `verification_mode` label for filings/tvl immutable
claims, and tx/grid are forced immutable by method, without a
finality check. No false positive has been constructed from this:
reorgs or node disagreement produce false *negatives* (a re-fetch
that no longer reproduces the bytes), not false verifications, and
grid's canonical rebuild is deterministic, with stored entries
honestly labelled amber. The label is therefore a claim the miner
must be able to justify (see the table above), not a proof in itself.

## What the Desk already ships (this clone)

- `src/desk/verify.ts` — `verifyRawBytes(raw, recordedSha)` (server
  re-hash) + devnode signal/delivery verification. CAVEAT: the live
  combined run that motivated the design verified the signal half and
  the delivery half on DIFFERENT asks — no single receipt had been
  proven end-to-end live by that run. `verifyReceipt` takes a
  caller-paired signal_hash + receipt_hash (the caller asserts both
  belong to one ask); the MCP ledger path pairs them from one ledger
  row. END-TO-END LIVE PROOF (2026-11-20 ~18:08 UTC, fixed code): the
  M13-01 TX pair (signal
  `0xd61bc4c6ea837aa3ea32f5c0d052416cf20d520fb4c0fe383b9d34be228c3ecb` +
  receipt
  `0xe0e96add6e03832d617fbe28e76e627df23d20a799fe03c37e2b5b1e4c0bff02`)
  and the M13-02 TX pair (signal
  `0xbe7a02569c12a8f454ff3cbd1d7082c5510234749677a69135a0b44c2b4dc4c1` +
  receipt
  `0x10dbf4c372d2e470b2ec4f6beaa1fb67ce507f9dab7092877db9d65f69f67404`),
  each from ONE ask, both verified end-to-end live (signal verified +
  delivery verified in epoch 25, 8-element Merkle proof, receipt_hash
  + epoch_id matched). The different-asks caveat describes the original
  18:40 run, not these two receipts. M13-01 was re-verified live again
  during round-2 review (same pair, same result: verified, epoch 25,
  8-element Merkle proof, 51.9s; the /deliveries endpoint answered
  promptly that evening, unlike the 120s timeouts seen earlier).
- `frontend/src/lib/auditRehash.ts` — browser re-hash against
  `/receipts/:id/raw` via WebCrypto (`lib/verify.ts`).
- `frontend/src/components/AuditRehashControl.tsx` — "Recompute from
  stored bytes" control showing MATCH / MISMATCH / UNAVAILABLE
  honestly.

## Checklist for the miner coordinator (before MATCH can be proven)

- [ ] Persist raw response bytes at answer time (schema change above).
- [ ] Ship `GET /receipts/:id` (200 for a real receipt).
- [ ] Ship `GET /receipts/:id/raw` returning byte-identical stored bytes.
- [ ] Add `verification_mode` to every receipt
      (`snapshot_raw_digest` default; `immutable_live_recheck` only
      where the miner can prove the upstream bytes are immutable).
- [ ] Deploy to Render; confirm the live TVL receipt
      `rcpt_TSUA27HVHTJZIU50P05LMBZ1C3` serves 200 on both routes and
      its `/raw` bytes hash to
      `0x6fad7b9be5364f29e00508f4ae25c9cdf0af042bef666f52f5091ed989a629b3`.
- [ ] Notify the verification worker, who then re-runs the end-to-end
      re-hash proof live and reports MATCH with receipt ID + both
      hashes, or MISMATCH with the evidence.
