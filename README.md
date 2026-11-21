# VeriReceipt

**VeriReceipt** is a zero-LLM, deterministic miner for the Telegraph network.
It answers six intents with exact, sourced data — no model, no guessing, no
hallucinated numbers. Every answer carries a **SHA-256 receipt** over the raw
upstream response, so anyone can recompute the hash and verify the answer
came from the stated source, unaltered.

- **Base URL:** `https://verireceipt.onrender.com`
- **Docs:** `https://verireceipt.vercel.app/docs`
- **Health:** `https://verireceipt.onrender.com/health`
- **Config:** [`miner.yaml`](miner.yaml) (Telegraph miner registration file)

## The six intents

| Intent | Endpoint | What it returns |
| --- | --- | --- |
| `ONCHAIN_TX_LOOKUP_GENERAL` | `GET /v1/tx` | Transaction status, from/to, block, value — from a 2-of-N archive-RPC quorum (the API body also carries the OP-stack L1 data fee on OP-stack chains) |
| `REGULATORY_FILING_MONITOR_GENERAL` | `GET /v1/filings` | SEC EDGAR filing titles (newest first) for a company over a period, optionally of one EDGAR form type |
| `TVL_LOOKUP_GENERAL` | `GET /v1/tvl` | DeFi TVL (USD) for a protocol or chain, via DeFiLlama |
| `OPTIMAL_EXECUTION_ROUTE_GENERAL` | `GET /v1/route` | Block-pinned quote for selling exactly 1 ETH for USDC on Ethereum mainnet (best quote across Uniswap V2/V3, SushiSwap V2) |
| `GRID_POWER_PRICE_GENERAL` | `GET /v1/grid-price` | Wholesale locational marginal price (USD/MWh) from official public feeds (CAISO OASIS day-ahead, NYISO real-time, Elering 15-minute prices converted EUR→USD) |
| `VALIDATOR_PERFORMANCE_VERIFY_GENERAL` | `GET /v1/validator` | Effective balance (gwei) of an Ethereum beacon-chain validator at the finalized state, from a 2-of-4 public beacon API quorum |

Every response includes `receipt.raw_response_sha256` — the SHA-256 of the raw
upstream response the answer was derived from. See
[JUDGE.md](JUDGE.md) for the 30-second recomputation check.

A `/v1/validator` answer waits only for source replies that arrive inside the
4.5 s request budget. A response that arrives after the budget is not counted:
it cannot complete a quorum and it cannot flip a verified pair into a conflict.

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

- **registrationId:** `6152` on Ethereum Sepolia (chainId 11155111). Node status `active` at
  `GET https://devnode.telegraphprotocol.com/api/miners/6152` (checked 2026-11-21 14:08 Africa/Cairo).
  Created by `updateMiner(6150, …)` in tx
  [`0x775fcc05adca9be05188554e0487b46e09f207bc5ea1de89a2fd86e2b79f07cb`](https://sepolia.etherscan.io/tx/0x775fcc05adca9be05188554e0487b46e09f207bc5ea1de89a2fd86e2b79f07cb)
  (block 12181672). The earlier registration 6150 is superseded and shows `deregistered` on the node.
- **Registered YAML:** [`miner.yaml` @ `4f471e4`](https://raw.githubusercontent.com/mohamedwael201193/verireceipt/4f471e48296d7225a482ef70025352e954b9cf5d/miner.yaml),
  SHA-256 `0x1653f3c00f8ee983bc2d2b36579c665c94ce2215ab1bb0d526564a9aec183e9f`
- **Diamond (Telegraph):** `0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b`
- **Floor price (on-chain):** `minPriceUsdc = 10000` = $0.01, the protocol minimum (getMiner(6152)).
  Telegraph docs (using/api-keys.md): a request costs "usually about $0.01" per miner call.
- **Bond (on-chain):** $1.50 Test USDC = `minerBond(6152)` = `quoteMinerBond(6)` = 1,500,000 base units
  ($1.00 first intent + 5 × $0.10, per `minerBondParams()`), read 2026-11-21.
- **Miner id / slug:** `774921` / `verireceipt`

## How it works

1. A request hits one of the six deterministic endpoints.
2. The server queries the official upstream source(s) directly — archive
   RPCs, SEC EDGAR, DeFiLlama, on-chain DEX pools,
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
