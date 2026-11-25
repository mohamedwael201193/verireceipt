# Personal agent heartbeat

Status: self-hosted local CLI, Ethereum Sepolia testnet only. Not a hosted
service. Hosted spend and hosted retention stay off; the payer key lives in
the operator's local secrets file and every purchase is test USDC.

## What it is

The personal-agent heartbeat (hackathon mission issue #197, Route 1) is a
real agent loop with a wallet budget, logging and limits. The operator
declares a set of watches; on each tick the agent reuses a still-fresh
verified answer or buys a new one from escrow, verifies it end to end,
optionally cross-checks a second provider, evaluates the declared rule and
appends a dated memo with the checked result, its source and uncertainty,
the receipts and the running day cost.

The agent never acts on the world. The memo is the deliverable; any external
effect (sending a message, placing a trade, filing a form) is the operator's
own explicit decision. This is the mission's required posture of explicit
permission for external effects.

## The customer and the workflow

A self-hosted assistant user wants fresh, priced facts without babysitting a
terminal: is NP15 power still under the dispatch ceiling, is BTC still above
the treasury floor. Today those checks are either free stale dashboards or
manual paid calls. The heartbeat turns each question into a declared watch
with a budget and a freshness window, and answers it with a verified
purchase instead of a cached page.

Run one tick:

    DESK_SECRETS_FILE=~/desk.secrets DESK_PAYER_ADDRESS=0x... \
      npx tsx scripts/run-heartbeat.ts watches.json out/

`watches.json` is a `Watch[]` (see `examples/heartbeat-watches.example.json`).
Each watch names an intent, params, the decision field, a rule
(`gte` / `lte` / `eq` against an exact decimal string), a freshness window
in seconds, and a rationale. A watch may name a cross-check: a second
provider (engine miner id) bought for the same intent and params, with a
tolerance in basis points.

`out/memos.jsonl` (mode 0600) accumulates one memo per watch per tick.

## The tick

1. Freshness. The newest PASS memo younger than the window is reused: a
   REUSED memo records the decision, no purchase is made and nothing is
   signed. Paying twice for a still-fresh answer is waste the loop is
   designed to avoid.
2. Budget. A stale or absent answer is bought from escrow. The quote is
   reserved in the shared spend journal under the file lock BEFORE the
   payment message is signed, so the heartbeat joins the same cross-agent
   daily cap as the desk, gate and benchmark. A reservation failure refuses
   the signature; the agent cannot overdraw.
3. Verification. The paid answer is verified end to end (`verifyPurchase`):
   signal hash re-derivation, stored delivery bytes, receipt binding and
   field reconciliation. An answer that fails verification is never served.
4. Cross-check. When declared, a second provider is bought and verified the
   same way. The two verified values must agree within the declared
   tolerance (exact decimal comparison, basis points of the larger
   magnitude).
5. Memo. The rule is evaluated on the verified value with exact decimal
   comparison (no floats). The memo records the value, rule outcome, source
   line, uncertainty line, receipts (miner, nonce, receipt hash, charge) and
   this agent's running day cost.

## Budget and cost per useful outcome

Each call is a flat 10,000 micro-USDC (0.01 test USDC). A watch bought at
the edge of a 30-minute window costs at most 48 calls, 0.48 test USDC per
UTC day; reuse and wider windows reduce that linearly. A cross-checked
watch costs two calls per buy. The shared daily cap (default 100,000
micro-USDC) bounds every agent that joins the ledger directory, and the
memo's `day_cost_uusdc` field reports this agent's own running total so the
cost per useful outcome is visible per tick, not reconstructed later.

## Failure cases

| Case | Behaviour |
| --- | --- |
| Stale local answer | Re-bought; a stale cached answer is never served as fresh. |
| No budget | SKIP memo with the cap reason; nothing is signed. |
| Failed payment or refusal | HOLD memo with the transport reason; no invented answer. |
| Conflicting provider answers | HOLD memo naming both verified values and the measured difference; both receipts recorded; no value served until a human reviews. |
| Paid answer fails verification | HOLD memo; the charge is recorded honestly and the answer is not served. |
| Cross-check provider unavailable | HOLD memo; the primary answer is not served alone when a cross-check was declared. |

Every HOLD and SKIP is a memo with receipts and day cost, so the log is a
complete account of what the agent spent and why it said what it said.

## What it never does

No mainnet, no real-money spend, no acting on the world, no serving
unverified or stale answers, no signing past the daily cap, no hiding a
failed purchase. The heartbeat is not a hosted service and does not create
retention: memos stay on the operator's disk.
