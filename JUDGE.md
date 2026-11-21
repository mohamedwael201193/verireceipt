# JUDGE.md — 2-minute verification guide for VeriReceipt

Verify every claim below against the live service at
`https://verireceipt.onrender.com`. No account, no key, no login is needed.
Each check is a single `curl`; the whole guide takes about two minutes.

## 1. The five endpoints

```bash
BASE=https://verireceipt.onrender.com

# 1. Transaction lookup — replace the hash with any real transaction hash
curl "$BASE/v1/tx?tx_hash=0x6ed42787fef7f854a1e8c95924a2f68b6ec113f48e141e95fe2dda1393b27005&chain=ethereum"

# 2. Filings — SEC EDGAR filings for a company over a period (optional form_type)
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

## 4. 30-second receipt recomputation

Every answer is receipted: `receipt.raw_response_sha256` is the SHA-256 of
the raw upstream response the answer was derived from.

```bash
# Fetch the same upstream URL the receipt names, hash it, compare:
curl -s "<receipt.upstream_url>" | sha256sum
# Compare the output with receipt.raw_response_sha256 from the answer.
# A match proves the answer was derived from that exact upstream response.
```

Notes:

- The upstream URL is named in the receipt (`receipt.upstream_url`) and the
  fetch time in `receipt.fetched_at`.
- Some upstreams (e.g. RPC quorums) return a fresh response on each fetch,
  so a recomputation minutes later may legitimately differ. The receipt
  proves the response *at fetch time*; the strongest check is to recompute
  immediately after receiving the answer.
- For the `/v1/tx` quorum, the receipt covers the quorum's aggregated raw
  response; the same procedure applies.

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
