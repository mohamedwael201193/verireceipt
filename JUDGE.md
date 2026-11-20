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

## 6. VeriReceipt Desk (Track 3)

Deterministic M13 + M12 gates over ranked Telegraph escrow calls.
Routes are mounted without an `/api` prefix (the proxy strips it).

```bash
BASE=https://verireceipt.onrender.com

# Desk stats: spend, caps ($0.06 M13 run, $0.02 M12 run), runway
curl "$BASE/desk/stats"

# Desk ledger: paginated runs with signal_hash links
curl "$BASE/desk/ledger?page=1&limit=20"

# One M13 audit ($0.06, 6 ranked calls incl. independent spot price)
curl -X POST "$BASE/desk/run" -H 'Content-Type: application/json' -d \
  '{"mission":"M13","protocol":"aave-v3","tx_hash":"0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3","chain":"ethereum","issuer_entity":"Apple Inc","period":"last 12 months","trade_pair":"ETH/USDC"}'

# MCP tools/list (Streamable HTTP JSON-RPC)
curl -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d \
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

What to check: the current code emits 8 checks per M13 verdict
(including `route_vs_spot` computed against the bought
`CRYPTO_PRICE_USD` and a `tx_hash` binding check) and 7 checks per
M12 verdict (including `interval_match` and `hashprice_block`). The
settled runs (17:02–17:07 UTC, 2026-11-20, decided by pre-revision
evaluators) do NOT satisfy that description: settled M13 decisions
carry 7 checks with `route_vs_spot` skipped and no `tx_hash` check,
and settled M12 decisions carry 5 checks. A re-run through the
current code (the held re-proof) will produce 8-check M13 / 7-check
M12 verdicts with `route_vs_spot` computed. Do not read current-code
behaviour as settled-run behaviour.
Caps (5 free checks / IP / day, $2.00 / day) apply identically to
`POST /desk/run` and to the MCP `run_*` tools.

Pending: the `desk_runs.receipt_json` migration is code-verified but
the live DB still lacks the column — no post-fix run has touched the
real DB; the re-proof that would migrate it is held.

Known gap (see README §Desk): the 2026-11-20 run logged 130,000
µUSDC while the node ledger shows charged 150,000 µUSDC (unbilled 0
at last check, 2026-11-20, epoch 25) — $0.02
of unlogged spend, root-caused to an eager-promise budget bug and
fixed. Node-ledger snapshot retained in-tree:
`receipts/node-ledger-snapshot-2026-11-20.json` (live read-only GET,
fetched 2026-11-20T20:50:08Z, HTTP 200, body verbatim — deposited
2,000,000, available 1,850,000, charged 150,000, unbilled 0, epoch 25).
Funding txs (verified on Sepolia): mint
`0xfacf3a8de2712b7520c234753d089f1027b32832f27b6bd4ffde141efc777232`,
approve
`0x0ca31b23670cc6a1c6a52eaf8998a09abbd0ac7d73e6db4265b2b032684d0ff0`,
deposit
`0xe8696cc29652173b1fdce601cfbd5d61649583bf811163d778d412739b78d2d3`
($2.00 deposited; 1,850,000 µUSDC available at last check).

Full-suite counts fluctuate run-to-run from live-network flakes — do
not cite a single exact count as stable. This round (2026-11-20
~21:04 UTC): 8,652 passed / 27 failed / 1 skipped of 8,680; zero Desk
failures (desk 23, policy 92, seed-plan 8 — all passed).
