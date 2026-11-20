# JUDGE.md — 2-minute verification guide for VeriReceipt

Verify every claim below against the live service at
`https://verireceipt.onrender.com`. No account, no key, no login is needed.
Each check is a single `curl`; the whole guide takes about two minutes.

## 1. The five endpoints

```bash
BASE=https://verireceipt.onrender.com

# 1. Transaction lookup — replace the hash with any real transaction hash
curl "$BASE/v1/tx?tx_hash=0x6ed42787fef7f854a1e8c95924a2f68b6ec113f48e141e95fe2dda1393b27005&chain=ethereum"

# 2. Filings — SEC EDGAR + Federal Register for an entity over a period
curl "$BASE/v1/filings?entity=Apple%20Inc&period=last%2012%20months"

# 3. TVL — DeFiLlama protocol TVL
curl "$BASE/v1/tvl?protocol=aave-v3"

# 4. Execution quote — sell exactly 1 ETH for USDC on Ethereum mainnet
curl "$BASE/v1/route?pair=ETH%2FUSDC"

# 5. Grid price — wholesale LMP for a node and interval (CAISO example)
curl "$BASE/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-19T00%3A00%3A00Z"
```

**What to check on each success response:**

- The requested fields are present (`tx_hash`/`status`/`from`/`to`/
  `block_number`/`value_eth`; `entity`/`filing_count`/`filings`/`urls`;
  `protocol_or_chain`/`tvl_usd`/`chain_tvl_usd`/`as_of`; `amount_out`;
  `lmp_usd_per_mwh`/`node_or_zone`/`market`/`interval_start`/`currency`).
- `confidence`, `verdict`, and `source` are present.
- `receipt.raw_response_sha256` is present and is a 64-character
  lowercase hex string.

## 2. Refusal drills (fail-closed, never fabricated)

```bash
BASE=https://verireceipt.onrender.com

# 400 — malformed transaction hash (not 0x + 64 hex chars)
curl -i "$BASE/v1/tx?tx_hash=not-a-hash&chain=ethereum"
# Expect: HTTP 400, error body, no invented transaction.

# 422 — wrong pair (only ETH/USDC is supported)
curl -i "$BASE/v1/route?pair=BTC%2FUSD"
# Expect: HTTP 422, error body, no quote.

# 422 — future grid interval (no settlement data exists yet)
curl -i "$BASE/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2999-01-01T00%3A00%3A00Z"
# Expect: HTTP 422, error body, no invented price.
```

## 3. The 502 contract (upstream failure)

A judge cannot test this by stopping the upstreams — they are third-party
services outside the judge's control. The contract is:

- If any required upstream is unreachable, times out, or returns
  unparseable data, the endpoint returns **HTTP 502** with an error body
  naming the failed upstream.
- It **never** returns a fabricated value, a cached stale value presented
  as fresh, or a success response with a missing/empty receipt.
- A 502 is a fail-closed refusal, not a wrong answer: the request can
  simply be retried.

## 4. Receipt recomputation — per intent (no single re-curl works)

Every answer is receipted: `receipt.raw_response_sha256` is the SHA-256 of
the exact bytes the answer was derived from at fetch time. There is NO
one procedure that re-checks every intent — each digest covers different
bytes, and a plain `curl <receipt.upstream_url> | sha256sum` is the WRONG
check for most of them (it hashes the wrong bytes and a mismatch proves
nothing about the receipt). Use the procedure for the intent:

- **tx — POST replay.** The digest covers the POST
  `eth_getTransactionReceipt` response text, not a GET of the RPC URL
  (a GET of an RPC URL can never return the POST response bytes):
  ```bash
  curl -s -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["<tx_hash>"]}' \
    "<receipt.upstream_url>" | sha256sum
  # Compare with receipt.raw_response_sha256.
  ```
- **grid — canonical rebuild, no fetch.** The digest covers
  `JSON.stringify({node_or_zone, interval_start, lmp_usd_per_mwh,
  market})` built from the answer fields. The CAISO zip bytes were
  never hashed, so fetching the zip can never match:
  ```bash
  printf '%s' '{"node_or_zone":"<node>","interval_start":"<interval>","lmp_usd_per_mwh":<lmp>,"market":"<market>"}' | sha256sum
  # Compare with receipt.raw_response_sha256 (no trailing newline).
  ```
- **tvl / filings — stored bytes only.** The digest covers the exact
  upstream body as fetched at answer time. DeFiLlama / SEC EDGAR
  return fresh data on every fetch, so a live re-fetch can never
  reproduce the fetch-time bytes: a re-fetch mismatch proves nothing
  about the receipt, and neither would a match. Verify only via the
  stored bytes (see below); do NOT re-curl the upstream URL.
- **route — not reproducible from the answer.** The digest covers the
  winning quoter's raw request/response, which the API response does
  not carry. No browser or curl procedure can re-hash it; verify only
  via the stored bytes below.

**Stored-bytes re-hash (the check that works for every intent):**
once the miner ships `GET /receipts/:id/raw` (see CONTRACT.md — NOT
yet live as of 2026-11-20), fetch the exact stored bytes and hash them:
```bash
curl -s "https://verireceipt.onrender.com/receipts/<receipt_id>/raw" | sha256sum
# Compare with receipt.raw_response_sha256. A match proves the answer
# was derived from those exact bytes; a mismatch is a real failure.
```
Until that endpoint ships, a tvl/filings/route receipt cannot be
independently re-hashed — its re-hash story is UNPROVEN, not failed.
The Desk's "Recompute from stored bytes" control performs this check
in the browser.

Notes:

- The upstream URL is named in the receipt (`receipt.upstream_url`) and the
  fetch time in `receipt.fetched_at`.
- A mismatch from the WRONG procedure (e.g. a plain GET re-curl of a tx
  RPC URL, a zip re-fetch for grid, or a live re-fetch of a mutable
  tvl/filings upstream) proves nothing about the receipt — it proves
  only that the wrong bytes were hashed. Only the procedure above, or
  the stored-bytes re-hash, is a verification.

## 5. What is NOT claimed

- No language model is used anywhere in the answer path. The service is
  deterministic: the same upstream state yields the same answer.
- No number in any response is estimated, interpolated, or backfilled. If
  the source does not have the data, the endpoint refuses instead of
  answering.
- `OPTIMAL_EXECUTION_ROUTE` is judgment-kind: its ranking depends on an
  evaluator whose criteria are not public, so no placement is guaranteed.
  The quote itself is block-pinned and receipted.
- `GRID_POWER_PRICE` scores vary epoch to epoch with ISO feed availability.
