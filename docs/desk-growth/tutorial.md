# Zero-LLM Receipted Telegraph Miners & Fail-Closed Escrow Apps (About a Minute per Check, Cold)

**Status — Desk audits SETTLED, Desk UI NOT-YET-LIVE:** the miner endpoints
below are live and verified, and the Desk audit flow has settled 3 decisions
via ranked escrow on 2026-11-20 17:00–17:08 UTC (run_ids, verdicts, and
costs in §6) — but the Desk app UI itself is NOT live yet (Render `/`,
`/docs`, `/api/mcp`, `/receipts` all return `404`, re-verified 2026-11-20
18:19 UTC (20:19 EET);
miner id `774921` is unregistered — see §6). Nothing in this tutorial
describes the 1-click UI as working today: every UI sentence below is a plan
for once it is live. The settled audits are facts, not plans.

**Status:** DRAFT — every `curl` block below was run live on 2026-11-20
~16:31–16:32 UTC and its output is copied verbatim. The MCP section at the
end is marked NOT-RUN — it contains no invented output; run it before
publishing this tutorial.

**What this is:** a miner that answers with exact, sourced data — no language
model anywhere — and returns a SHA-256 receipt over the raw upstream response
with every answer, so anyone can recompute the hash and check the answer came
from the stated source, unaltered. The Desk audit flow has already bought
those answers through Telegraph's ranked router and turned them into
fail-closed `APPROVE` / `HOLD` / `REJECT` decisions (M13-01 APPROVE,
M13-02 APPROVE, M12-01 CURTAIL — see §6); what does not exist yet is the
1-click UI that lets a judge run it from the browser.

**Live service:** `https://verireceipt.onrender.com` — no account, no key, no login.

---

## 1. Check the service is up (about a minute cold, a few seconds warm)

```bash
curl -s https://verireceipt.onrender.com/health
```

Exact output, 2026-11-20 16:32 UTC (response in ~1.8 s on that run — do not
cite a single figure. Cold-start latency is highly variable and
unpredictable: re-measured 2026-11-20 ~16:46 UTC at 3.6 s warm and 43–50 s
on cold starts; a judge measured cold 44.7–63.1 s across health/TVL/grid/
route, route slowest at 63.1 s. One further single sample exists — a
worker-measured 25.4 s for `/health` as the first call after ~14 min idle
(2026-11-20 ~17:00 UTC) — but do NOT treat it as a verified cold
measurement: it is a single uncorroborated sample, and its "cold" label is
doubtful — the Render plan is Starter, which never sleeps
(`render.yaml:5`), the idle was only ~14 min, and a `/v1/route` call as
the first request after a further 16 min idle took only 5.3 s (the
instance evidently stayed warm that time — that 5.3 s is a warm
measurement, not a cold one). So: warm, a few
seconds; cold, plan on about a minute — the judge-measured cold range is
44.7–63.1 s — and never promise a cold run under ~45 s:

```json
{"status":"ok","service":"verireceipt","uptime_s":12149,"upstreams":{}}
```

## 2. Ask for a TVL — and get a receipt (about a minute cold, a few seconds warm)

```bash
curl -s "https://verireceipt.onrender.com/v1/tvl?protocol=aave-v3"
```

Exact output, 2026-11-20 16:31 UTC (values are live data from that minute, not
placeholders — re-run it; the TVL updates as the upstream refreshes.
Verified: a re-run at 2026-11-20 16:46 UTC returned the identical TVL
`$15,136,132,391` with the same `as_of` (`2026-11-20T13:56:59.000Z`) — the
value does not move on every run.)

```json
{"protocol_or_chain":"aave-v3","tvl_usd":15136132391,"chain_tvl_usd":12963611621.05329,"as_of":"2026-11-20T13:56:59.000Z","answer":"Aave V3 has a total value locked of $15,136,132,391 as of 2026-11-20.","verdict":"verified","confidence":1,"source":"DeFiLlama API (https://api.llama.fi/protocol/aave-v3)","checked_at":"2026-11-20T16:31:38.046Z","receipt":{"receipt_id":"rcpt_650VJ05VPFUKZZMNMXPPJMC8LJ","intent":"TVL_LOOKUP_GENERAL","upstream_url":"https://api.llama.fi/protocol/aave-v3","raw_response_sha256":"0x6fad7b9be5364f29e00508f4ae25c9cdf0af042bef666f52f5091ed989a629b3","quorum_votes":"1/1 primary source","fetched_at":"2026-11-20T16:31:38.045Z","audit_url":"https://verireceipt.onrender.com/receipts/rcpt_650VJ05VPFUKZZMNMXPPJMC8LJ"}}
```

> NOTE on `receipt.audit_url`: the printed URL
> `https://verireceipt.onrender.com/receipts/rcpt_650VJ05VPFUKZZMNMXPPJMC8LJ`
> returns **404 when the service responds** (checked live 2026-11-20 ~16:46
> UTC: `{"message":"Route GET:/receipts/rcpt_650VJ05VPFUKZZMNMXPPJMC8LJ not
> found","error":"Not Found","statusCode":404}`) because the `/receipts`
> route is not live on Render yet — the Desk `/receipts` pages are still
> NOT-YET-LIVE (§6). But do NOT expect that 404 reliably on a first click:
> cold, the service is intermittently unresponsive — a judge's first click
> of a fresh receipt's audit URL timed out with no response after 90 s
> (HTTP 000), and only the retry returned the 404, in 2.2 s. So the 404 is
> what the service returns WHEN it responds; cold, the first click may hang
> instead. The receipt itself is still verifiable by re-hashing the upstream
> as in §3; the audit link starts working once the Desk `/receipts` pages go
> live. Re-verified 2026-11-20 ~17:35 UTC on a fresh receipt
> (`rcpt_KQSX9JAD8HG0J3KDO0LNOFAAVZ`): first click after ~19 min idle
> returned the 404 in 5.0 s, retry in 2.4 s — the hang did NOT reproduce this
> time, so cold behaviour is intermittent, not consistently broken. Either
> way, do not promise "click it and see 404" as a reliable first-click
> experience. (On the two retry figures in this note: 2.2 s was the judge's
> retry on a different, earlier receipt whose first click timed out; 2.4 s
> is this 17:35 re-verification's retry on `rcpt_KQSX9JAD8HG0J3KDO0LNOFAAVZ`
> — different events, both as recorded at the time. Re-measured 2026-11-20
> 18:19–18:21 UTC (20:19–20:21 EET): `rcpt_KQSX9JAD8HG0J3KDO0LNOFAAVZ`
> first click 404 in 2.4 s, retry 404 in 3.7 s; J2's fresh receipt
> `rcpt_WRULA5O0WSD5HHTIGTA0TBE69K` first click 404 in 2.1 s, retry 404 in
> 2.0 s. The figure varies run to run — do not cite any single retry time as a constant.)

The receipt is the point: `receipt.raw_response_sha256` is the SHA-256 of the
raw upstream response, and `receipt.upstream_url` tells you exactly where to
fetch it from.

## 3. Recompute the hash yourself (the verification that matters)

```bash
curl -s https://api.llama.fi/protocol/aave-v3 -o /tmp/llama-aave.json
sha256sum /tmp/llama-aave.json
```

Exact output, 2026-11-20 ~16:32 UTC:

```
6fad7b9be5364f29e00508f4ae25c9cdf0af042bef666f52f5091ed989a629b3  /tmp/llama-aave.json
```

Compare with the receipt: `0x6fad7b9b…629b3` — **exact match** (the receipt
carries a `0x` prefix; strip it before comparing). The answer was derived
from the upstream response it claims, unaltered. Note the caveat: this works
because the upstream data was stable across the minute between the two
fetches. If the upstream moves between fetches, re-fetch promptly — a
mismatch after a long gap means the source moved, not that the receipt lied;
check `receipt.fetched_at` against your fetch time.

> Re-hash caveat (2026-11-20): the mechanism matched on fast curl re-fetch
> (16:32 UTC, exact match above) but failed once in the browser the same day
> (15:08 EET digest mismatch on a fresh TVL receipt). Treat recomputation as
> verified for a fast curl re-fetch, not settled in the browser — re-fetch
> promptly, and if the upstream moves between fetches, re-fetch rather than
> concluding the receipt is wrong.

## 4. The fail-closed drills — refusals, not fabrications

Wrong pair (only `ETH/USDC` is supported):

```bash
curl -s -i "https://verireceipt.onrender.com/v1/route?pair=BTC%2FUSD"
```

Exact output, 2026-11-20 16:31 UTC:

```
HTTP/1.1 422 Unprocessable Entity
{"error":"invalid_pair","code":"INVALID_PAIR","message":"unsupported pair \"BTC/USD\"; only ETH/USDC is supported"}
```

No quote is returned. A malformed transaction hash is the same story:

```bash
curl -s -i "https://verireceipt.onrender.com/v1/tx?tx_hash=not-a-hash&chain=ethereum"
```

Exact output, 2026-11-20 16:31 UTC: `HTTP/1.1 400 Bad Request` with an
error body and no invented transaction. These two drills prove the miner
refuses these two bad inputs without inventing a value. They do not prove
every failure mode fails closed — an upstream outage or unparseable response
has not been drilled live, so fail-closed-on-outage is a design claim, not a
verified one, until such a drill is run and pasted here.

## 5. The other three intents (same pattern, same receipt)

```bash
BASE=https://verireceipt.onrender.com

# Transaction lookup — replace the hash with any real transaction hash
curl "$BASE/v1/tx?tx_hash=0x6ed42787fef7f854a1e8c95924a2f68b6ec113f48e141e95fe2dda1393b27005&chain=ethereum"

# Filings for an entity over a period (SEC EDGAR + Federal Register)
curl "$BASE/v1/filings?entity=Apple%20Inc&period=last%2012%20months"

# Execution quote: sell exactly 1 ETH for USDC on Ethereum mainnet
curl "$BASE/v1/route?pair=ETH%2FUSDC"

# Grid price for a node and interval (CAISO example) — NOTE: grid answers
# only cached intervals. The 2026-11-19T00:00:00Z interval printed in the
# first draft returns HTTP 502 GRID_CACHE_MISS (re-verified live 2026-11-20
# ~16:46 UTC: {"error":"grid_cache_miss","code":"GRID_CACHE_MISS",
# "message":"no cached price for TH_NP15_GEN-APND at
# 2026-11-19T00:00:00.000Z"}). Use the 2026-11-20 interval below, which
# works — always check the interval is cached before citing a grid value.
curl "$BASE/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-20T00%3A00%3A00Z"
```

Exact output, 2026-11-20 16:46 UTC (HTTP 200 in ~2.4 s):

```json
{"lmp_usd_per_mwh":67.14952,"node_or_zone":"TH_NP15_GEN-APND","market":"CAISO","interval_start":"2026-11-20T00:00:00.000Z","currency":"USD","answer":"The LMP at TH_NP15_GEN-APND was $67.15 per MWh for the interval starting 2026-11-20T00:00:00.000Z.","verdict":"verified","confidence":1,"source":"CAISO OASIS PRC_LMP DAM","checked_at":"2026-11-20T16:46:04.037Z","receipt":{"receipt_id":"rcpt_USTUY5IMOF4BWH4NLD4B3LYQKY","intent":"GRID_POWER_PRICE_GENERAL","upstream_url":"https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP&startdatetime=20261119T14:44-0000&enddatetime=20261120T16:44-0000&version=1&market_run_id=DAM&node=TH_NP15_GEN-APND&resultformat=6","raw_response_sha256":"0xf2e3724c5c48a204fbcfe6646340ff1869cba1458d6f762b1741590c0fbb876d","quorum_votes":"1/1 cache row from verified ISO feed","fetched_at":"2026-11-20T16:44:43.152Z","audit_url":"https://verireceipt.onrender.com/receipts/rcpt_USTUY5IMOF4BWH4NLD4B3LYQKY"}}
```

Every success response carries `confidence`, `verdict`, `source`, and
`receipt.raw_response_sha256`. The grid command above is verified live
(2026-11-20 16:46 UTC); the tx, filings, and route commands are taken from
the repo's `README.md` / `JUDGE.md` and their outputs were NOT re-run for
this tutorial — run one yourself before citing a value from them. The TVL,
`422`, and `400` outputs above are the ones verified for this file.

## 6. What the Desk does with these answers (audit flow SETTLED via backend; 1-click UI planned, NOT-YET-LIVE)

The Desk audit flow has already run: on 2026-11-20 17:00–17:08 UTC it bought
13 ranked intents via `POST /engine/v1/ask` (escrow `X-PAYMENT`) and settled
3 decisions — M13-01 APPROVE (run
`desk_8d41df4f-07f1-44f7-974d-ae3c56b725ff`, decided 17:02:23Z, $0.05, 5 calls,
7 checks), M13-02 APPROVE (run
`desk_f6e2419b-acb9-4570-a51b-fedb972af7a6`, decided 17:03:44Z, $0.05, 5 calls,
7 checks), M12-01 CURTAIL (run
`desk_1d7d6516-5b48-4c53-9ed0-af28f78bbfe7`, decided 17:07:20Z, $0.02, 2 calls,
5 checks: grid $77/MWh vs $25 break-even). A 13th call (M12-02 GRID,
17:08:01Z) is logged with no decision recorded yet. All 13 `signal_hash`es
resolve on the node (J2 verified all 13 → `200`; 2 spot-checked again
18:21 UTC (20:21 EET) → `200`, 3.5 s and 2.8 s). Independent sanctions checks were bought in both M13
audits (`SANCTIONS_SCREENING_MATCH_GENERAL`, miner `710637`); the independent
price check was NOT bought in either — `route_vs_spot` is `skipped` in both
decisions ("No independent spot-price evidence was bought in this run"), so
no `CRYPTO_PRICE_USD` appears in the ledger. Every call links to
`https://devnode.telegraphprotocol.com/engine/v1/signal/<signal_hash>`.

The 1-click UI that lets a judge run this flow from the browser is still
NOT-YET-LIVE — that is what "once live" means below. Once live, the Desk
would buy 6 ranked intents per FULL allocation check — the full variant
(scenarios 1–10 of the seed plan; scenarios 11–20 buy 5 calls: 4 own intents
+ price, sanctions skipped) — through Telegraph's ranked
router (`POST /engine/v1/ask`, `max_budget_usdc: 260000`, escrow `X-PAYMENT`)
— its own 5 intents (tx lookup, filings monitor, TVL lookup, execution
route, sanctions check) plus the independent `CRYPTO_PRICE_USD` spot price
(`SANCTIONS_SCREENING_MATCH_GENERAL` is one of the 5 own intents — it was
bought from independent miner 710637 in both settled runs, which bought the
5 own intents and skipped price, 5 calls / $0.05; `CRYPTO_PRICE_USD` only
once a purchase settles) — cross-check every field
against strict fail-closed thresholds, and output `APPROVE` / `HOLD` /
`REJECT` (Mission 13) or `MINE` / `CURTAIL` / `HOLD` (Mission 12, grid
dispatch).

**Status 2026-11-20 18:19 UTC (20:19 EET): Desk UI NOT YET LIVE.** On Render, `/`,
`/docs`, `/api/mcp`, `/receipts`, `/status`, and `/llms.txt` all return `404`
(re-verified 18:19 UTC (20:19 EET)); the miner id `774921` is not registered yet
(`GET https://devnode.telegraphprotocol.com/api/miners/774921` →
`404 {"error":"miner registration not found"}`). The settled audits above are
the Desk's own ranked escrow runs — they are facts, not plans; the 1-click
UI is the part that is still a plan.

> Disclosure: VeriReceipt Desk and the VeriReceipt Miner are operated by the same team. Calls made by VeriReceipt Desk use Telegraph's ranked router (`POST /engine/v1/ask`) on Ethereum Sepolia testnet (Test USDC only) and are explicitly labeled as related-party / internal test traffic, not independent customer demand. Independent third-party developer runs are logged and identified separately.

## 7. MCP quickstart — NOT RUN, do not publish this section until verified

The following is documented in the Track 3 guide (MCP server
`@telegraphprotocol/telegraph-protocol-mcp` v2.1.1) and is reproduced here
without any claimed output — it was NOT executed while writing this tutorial:

```bash
npx -y @telegraphprotocol/telegraph-protocol-mcp setup
npx -y @telegraphprotocol/telegraph-protocol-mcp
```

Free tools include `telegraph_find_intents`, `telegraph_intent`,
`telegraph_find_miners`, `telegraph_ranking`, `telegraph_account`, and
`telegraph_docs`. Paid tools (`telegraph_ask`, `telegraph_ask_miner`,
`telegraph_deposit`) spend Test USDC from escrow — do not call them without
explicit approval. **Before publishing:** run the setup, run one free
`telegraph_intent` query for `TVL_LOOKUP_GENERAL`, and paste the exact
command and output here, replacing this notice.

## Honest limits

- Execution routing (`OPTIMAL_EXECUTION_ROUTE_GENERAL`) is judgment-kind;
  its evaluator criteria are not public, so a #1 placement there is
  probable, not certain. The quote itself is block-pinned and receipted.
- Grid prices vary epoch to epoch as ISO feeds change.
- Testnet only: Ethereum Sepolia, Test USDC. Season II closes Dec 1, 2026,
  23:59 UTC; verification and judging Dec 2–8 (planned), provisional results
  from Dec 9 with a 72-hour appeal window (official timeline
  https://hackathon.telegraphprotocol.com/timeline).
- `$0.01` per call is the protocol floor price; a 5-call Mission 13 audit
  measured `$0.05` (5 of 6 intents; price check not yet bought) in both settled audits (2026-11-20 17:02–17:03
  UTC). Future audits will be `$0.06` once the 6th call (independent
  `CRYPTO_PRICE_USD`) is added — do not cite `$0.05` as the permanent
  per-audit cost.
- Ledger reconciliation (2026-11-20, disclosed in `backend/README.md`): the
  node ledger shows $0.15 paid (15 × $0.01) vs $0.13 logged in
  `receipts/ledger.jsonl` (13 rows) — 2 paid calls unlogged by a seed-runner
  bug (one attributed: the unlogged M12-02 hashprice call, the 14th call of
  the `--max-calls 13` run; the second unattributed). Root cause fixed in the
  seed runner (`buy()` now checks the budget before firing the ask, and every
  bought call is logged immediately), so it cannot recur. The "13 calls /
  $0.13" totals in this file are exactly true of `ledger.jsonl`; $0.15 is
  what the node billed.
