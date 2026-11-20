# VeriReceipt

**VeriReceipt** is a zero-LLM, deterministic miner for the Telegraph network.
It answers five intents with exact, sourced data — no model, no guessing, no
hallucinated numbers. Every answer carries a **SHA-256 receipt** over the raw
upstream response, so anyone can recompute the hash and verify the answer
came from the stated source, unaltered.

- **Base URL:** `https://verireceipt.onrender.com`
- **Docs / health:** `https://verireceipt.onrender.com/docs`
- **Config:** [`miner.yaml`](miner.yaml) (Telegraph miner registration file)

## The five intents

| Intent | Endpoint | What it returns |
| --- | --- | --- |
| `ONCHAIN_TX_LOOKUP_GENERAL` | `GET /v1/tx` | Transaction status, from/to, block, value — from a 2-of-3 archive-RPC quorum (incl. OP-stack L1 data fee) |
| `REGULATORY_FILING_MONITOR_GENERAL` | `GET /v1/filings` | SEC EDGAR + Federal Register filings for an entity over a period |
| `TVL_LOOKUP_GENERAL` | `GET /v1/tvl` | DeFi TVL (USD) for a protocol or chain, via DeFiLlama |
| `OPTIMAL_EXECUTION_ROUTE_GENERAL` | `GET /v1/route` | Block-pinned quote for selling exactly 1 ETH for USDC on Ethereum mainnet (Uniswap V2/V3, SushiSwap V2, Curve) |
| `GRID_POWER_PRICE_GENERAL` | `GET /v1/grid-price` | Wholesale locational marginal price (USD/MWh) from official ISO feeds (CAISO, NYISO, ENTSO-E/Elering) |

Every response includes `receipt.raw_response_sha256` — the SHA-256 of the raw
upstream response the answer was derived from. See
[JUDGE.md](JUDGE.md) for the 30-second recomputation check.

## 30-second examples

```bash
BASE=https://verireceipt.onrender.com

# 1. Transaction lookup (replace the hash with a real transaction hash)
curl "$BASE/v1/tx?tx_hash=0x6ed42787fef7f854a1e8c95924a2f68b6ec113f48e141e95fe2dda1393b27005&chain=ethereum"

# 2. Filings for an entity over a period
curl "$BASE/v1/filings?entity=Apple%20Inc&period=last%2012%20months"

# 3. TVL for a protocol
curl "$BASE/v1/tvl?protocol=aave-v3"

# 4. Execution quote: sell exactly 1 ETH for USDC
curl "$BASE/v1/route?pair=ETH%2FUSDC"

# 5. Grid price for a node and interval (CAISO example)
curl "$BASE/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-19T00%3A00%3A00Z"
```

### Response shape

Shape only — values are placeholders, not live data (the block number and
hash below are illustrative, not a real transaction):

```json
{
  "tx_hash": "0x6ed4…",
  "status": "success",
  "from": "0x…",
  "to": "0x…",
  "block_number": 23710000,
  "value_eth": "0.5",
  "confidence": 1.0,
  "verdict": "confirmed",
  "source": "archive-rpc-quorum",
  "receipt": {
    "raw_response_sha256": "<sha256-of-raw-upstream-response>",
    "upstream_url": "https://…",
    "fetched_at": "2026-11-20T06:00:00Z"
  }
}
```

Field names vary per endpoint; `confidence`, `verdict`, `source`, and
`receipt.raw_response_sha256` are present on every success response.

## Registration facts

- **registrationId:** TBD — filled in after registration
- **Diamond (Telegraph):** `0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b`
- **Typical ask price:** $0.01 per call (per Telegraph docs, "usually $0.01 in USDC")
- **Miner id / slug:** `774921` / `verireceipt`

## How it works

1. A request hits one of the five deterministic endpoints.
2. The server queries the official upstream source(s) directly — archive
   RPCs, SEC EDGAR, the Federal Register, DeFiLlama, on-chain DEX pools,
   official ISO price feeds. No language model is involved anywhere.
3. The raw upstream response is hashed (SHA-256) and the hash is returned
   as `receipt.raw_response_sha256` alongside the parsed answer.
4. If an upstream is down, slow, or returns something unparseable, the
   endpoint fails closed with an error — it never invents a value.

## Limits (honest)

- **Execution routing is judgment-kind.** `OPTIMAL_EXECUTION_ROUTE` is scored
  by an evaluator whose exact criteria are not public, so a #1 placement on
  that intent is probable, not certain. What is certain is the quote itself:
  block-pinned, computed from live pool state, and receipted.
- **Grid prices vary epoch to epoch.** `GRID_POWER_PRICE` scores depend on
  which ISO feeds are reachable and fresh in a given epoch; availability of
  individual feeds can change between epochs.
- **Timeline.** Season II closes Dec 1, 23:59 UTC; verification/judging Dec 2–8 (planned) — see the [rules page](https://hackathon.telegraphprotocol.com/rules).
- **Free tier.** The public desk endpoint allows a small number of free
  receipt checks per IP per day; paid calls go through the Telegraph escrow
  flow.

## VeriReceipt Desk (Track 3)

Deterministic M13 (asset allocation) + M12 (mining dispatch) gates over
ranked Telegraph escrow calls. The Desk buys intelligence from the
ranked router and applies pure, fail-closed policies — no LLM anywhere.

- **Routes (no `/api` prefix):** `POST /desk/run`, `GET /desk/ledger`,
  `GET /desk/stats`, `GET /desk/verify`, `POST /mcp`, `GET /llms.txt`.
  The Vite dev proxy and the Vercel rewrites strip a leading `/api`,
  so the old `/api/desk/*` and `/api/mcp` paths do not exist.
- **Costs:** $0.01 per ranked call; M13 run = 6 calls = **$0.06**
  (5 own intents + independent `CRYPTO_PRICE_USD` spot, bought in
  every M13 run through the current code — the ≤2% route-vs-spot
  check is always computed, never skipped, on such a run; the settled
  runs bought 5 calls and no spot, so `route_vs_spot` is skipped
  there — see the Cost framing note below); M12 run = 2 calls = **$0.02**.
- **Caps (enforced identically on `POST /desk/run` and on the MCP
  `run_*` tools, same counters):** 5 free checks / IP / day;
  $2.00 / day global, counted from the per-call SQLite ledger plus
  reservations made up front (a request reserves its expected cost
  before its first call, so concurrent requests cannot overshoot).
  Reservation is at the $0.01/call floor; if a miner ever billed
  above the floor the cap could overshoot by the excess — the ledger
  is authoritative after the fact.
- **Per-IP limitation (honest):** the per-IP counters live in process
  memory only. They reset on restart and are not shared across
  instances. The $2/day global cap does not have this problem — it is
  counted from the SQLite ledger, which survives restarts.
- **Client IP:** `request.ip` only, as resolved by Fastify with
  `trustProxy: (_address, hop) => hop === 0` (`src/server.ts:61`) —
  only the immediate socket peer (Render's proxy) is trusted, so
  `request.ip` is the **last** `X-Forwarded-For` entry, i.e. the address
  Render appended; a client-sent entry further left is ignored
  (verified against the installed proxy-addr: `XFF: 1.2.3.4, 203.0.113.7`
  resolves to `203.0.113.7`, while `trustProxy: true` lets the spoof win
  and `trustProxy: 1` leaves `request.ip` as the socket peer for every
  XFF value — Fastify 5 treats a numeric `trustProxy` as trust-nothing).
  `X-Forwarded-For` is never read directly. **Conditional, not proven
  live:** per-IP safety rests on Render appending the real client IP
  last — unverified (no endpoint echoes `request.ip`, no live quota
  burned to test it); the $2/day global cap is the backstop (≤ ~33 M13
  runs/day even with fresh IPs).
- **Seed plan:** 140 calls = $1.40 (110 M13 across 20 scenarios +
  30 M12 across 15). The merged 7:3 call queue buys 7 M13 + 3 M12 in
  the first 10 calls and 10 M13 + 3 M12 in the first 13 (dry-run
  trace: `npx tsx scripts/seed-desk-runs.ts --plan`). The 7:3 pattern
  holds only for the first 100 calls; jobs 101–140 are all M13 once
  the 30 M12 calls are exhausted (overall ratio 110:30 = 11:3).
  Scenarios 11–20 buy only 4 own intents + `CRYPTO_PRICE_USD`
  (no sanctions screen). This is a blueprint-sanctioned softening,
  not a silent cut: §7.1 allows 4–5 intents, and this plan's own
  arithmetic (110 M13 / 140 total / $1.40) drops the screen there —
  blueprint §7.3 (ll. 556–558) itself plans 90 M13 calls / 120+ total / ~$1.20 and
  mandates nothing about which scenarios drop sanctions; the policy
  records sanctions as "skipped" and names it in the Why box.
  Cost framing: blueprint §9.2's Cost & Latency row (l. 608) quotes $0.04 per full
  allocation audit (4 × the $0.01 floor); its Mission Fit row (l. 607) prints a
  $0.04–$0.05 range, but the $0.05 end is not 4-call arithmetic — $0.05
  is the measured cost of each settled 5-call audit (M13-01/M13-02,
  2026-11-20 17:02–17:03 UTC). The Desk's audit buys 6 calls (5 own +
  independent spot) at the measured $0.01/call floor, so $0.06.

### Known gap: $0.02 of unlogged spend (2026-11-20, disclosed)

The 2026-11-20 run logged 13 calls / **130,000 µUSDC** in
`receipts/ledger.jsonl` and in SQLite `desk_runs` (the two agree
exactly), while the node ledger for the payer shows **charged
150,000 µUSDC** (unbilled 0; deposited 2,000,000, available 1,850,000
at last check, 2026-11-20, epoch 25) — a gap of **$0.02 = 2 paid
calls** missing from every client-side record. The gap still
reconciles exactly (charged 150,000 vs logged 130,000); the field has
moved from unbilled to charged since the first check. One orphan is
attributed: M12-02 `MINING_HASHPRICE_VERIFY_GENERAL` (the 14th call of
the `--max-calls 13` run **under the pre-fix sequential call order the
settled runs used** — under the merged queue, job 14 is M13-02
`SANCTIONS_SCREENING_MATCH_GENERAL` and M12-02 `HASHPRICE` is job 18).
The second is unattributed in any surviving record; the queue
simulation shows a `--max-calls 10` run would orphan M13-02
`OPTIMAL_EXECUTION_ROUTE_GENERAL` — consistent with, but not proof of,
that attribution (that run's records were reset).

Root cause (fixed 2026-11-20): the seed runner's `buy()` received
the ask as an eagerly-created promise, so the ask fired
(challenge → sign → paid POST) **before** the budget guard ran.
When the cap was hit mid-scenario the extra ask ran to completion
unawaited, unlogged, unverified, uncounted. `buy()` now takes a
thunk and checks the budget **before** invoking it, so no paid call
can ever fire past the cap; and every bought call is logged to the
ledger immediately after it is bought (per-call logging on the HTTP,
MCP, and seed paths), so a throw mid-run cannot lose bought spend.
The fixed code cannot produce more orphans. The $2/day cap counts
logged spend, which post-fix is complete by construction.

### Funding (verified read-only on Sepolia, 2026-11-20)

Payer `0xf76e6B0920e9332fF4410f6dD53F01722AbC71a3`,
Diamond `0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b`,
Test USDC `0xcc194e1a843B658526D0D5C431f670028582Ae17`:

| Step | Tx hash | Result |
| --- | --- | --- |
| mint Test USDC | `0xfacf3a8de2712b7520c234753d089f1027b32832f27b6bd4ffde141efc777232` | success, block 12176451 |
| approve Diamond | `0x0ca31b23670cc6a1c6a52eaf8998a09abbd0ac7d73e6db4265b2b032684d0ff0` | success, block 12176452 |
| deposit $2.00 escrow | `0xe8696cc29652173b1fdce601cfbd5d61649583bf811163d778d412739b78d2d3` | success, block 12176453 |

Node ledger at last check (2026-11-20, epoch 25): deposited 2,000,000 µUSDC, available
1,850,000 µUSDC, charged 150,000 µUSDC, unbilled 0 µUSDC (the $0.02 gap above is
the difference between charged and the 130,000 logged). Snapshot retained
in-tree: `receipts/node-ledger-snapshot-2026-11-20.json` (live read-only GET,
fetched 2026-11-20T20:50:08Z, HTTP 200, body verbatim).

### Fail-closed map (omitted field → HOLD/REJECT, never a pass)

Every check always emits a non-empty reason. The single named
exception is a check whose evidence was deliberately not bought
(sanctions in scenarios 11–20; see above) — it is "skipped" and
named in the Why box, never a silent pass. A missing spot price is
NOT an exception: it is "unverifiable" and blocks APPROVE.

| Omitted / mismatched evidence | Result |
| --- | --- |
| tx status / chain / tx_hash missing | unverifiable → HOLD |
| tx chain ≠ requested chain | reject → REJECT |
| tx_hash ≠ requested hash | reject → REJECT |
| filings entity missing | hold → HOLD |
| filings entity ≠ requested / count missing or 0 | unverifiable → HOLD |
| TVL protocol name missing | hold → HOLD |
| TVL protocol ≠ requested / TVL missing / below $1M | unverifiable / hold → HOLD |
| route quote missing / out of declared range | unverifiable / hold → HOLD |
| route pair missing | unverifiable → HOLD |
| route pair ≠ requested pair | reject → REJECT |
| spot price missing (not bought) | unverifiable → HOLD |
| spot price symbol missing / ≠ ETH | unverifiable / hold → HOLD |
| route deviates >2% from independent spot | hold → HOLD |
| sanctions match verdict missing | unverifiable → HOLD |
| sanctions name missing / ≠ requested issuer | unverifiable → HOLD |
| sanctions matched | reject → REJECT |
| grid interval missing / ≠ requested interval | hold → HOLD |
| hashprice block missing / ≠ tip height used for the ask | hold → HOLD |
| expected block height not supplied | unverifiable → HOLD |
| grid node missing / ≠ requested node | unverifiable / hold → HOLD |
| grid price missing / currency missing / non-USD currency | unverifiable / hold → HOLD |

Evidence is bound to the request from the answer body only
(`result.chain`, `result.tx_hash`, `result.interval_start`,
`result.block_height`). The node's echoed `input` is never used as
evidence — it is our own request echoed back, so a check read from
it would always pass by construction.

### Which verification path applies to which evidence

A Desk call records **all** receipt identifiers the ask response
provides per call: `signal_hash`, `receipt_hash`, `miner_id`,
`miner_name`, the full `payments` rows, and the raw `receipt`
object (see `receipt` in `GET /desk/ledger` rows). It does **not**
carry a miner receipt id (`rcpt_…`) or a `raw_response_sha256` —
those exist only on receipts **our miner** issued. So:

- **Desk-call evidence** verifies via the devnode signal + delivery:
  `GET /engine/v1/signal/<signal_hash>` (`verification.verified`)
  and the payment rows in the ledger. That is the verify piece for
  every Desk decision.
- **Stored-bytes `GET /receipts/:id/raw`** applies **only** to
  receipts our miner issued, when the `receipt_id` is known. There
  is no `receipt_hash` → receipt-id mapping in the data, and none
  is invented here: a Desk `receipt_hash` cannot be addressed at
  that endpoint.

### Pending: `receipt_json` migration on the live DB

The `desk_runs.receipt_json` column migration is code-verified
(`src/desk/ledger.ts` adds it in place to pre-fix databases, and it
was exercised on a copy of the pre-fix DB), but the live database
(`data/verireceipt.sqlite`, PRAGMA-checked) still lacks the column:
no post-fix run has touched the real DB yet. The migration will land
on the live DB the first time a post-fix run writes to it; the
re-proof run that would do that is held (no payer key, miner not
active), so this stays pending — no action is possible until then.

## Running locally

```bash
npm ci
npm run build
npm start
```

> **Node version for local tests:** run tests with Node 24 (the default
> `node`, v24.22.1). The prebuilt `better-sqlite3` binding targets Node 24;
> under Node 20 the grid tests fail at `new Database` (binding compiled for
> NODE_MODULE_VERSION 137, Node 20 needs 115). Production is unaffected:
> Render runs `npm ci` at deploy and rebuilds the binding natively for its
> own Node version. Do not run `npm rebuild better-sqlite3` locally — other
> test runs depend on the Node 24 binding.

See [`JUDGE.md`](JUDGE.md) for the independent 2-minute verification guide.
