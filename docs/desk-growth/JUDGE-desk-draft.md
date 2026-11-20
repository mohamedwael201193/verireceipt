# JUDGE.md (Desk draft) — VeriReceipt Desk acceptance walkthroughs

**For the Track 3 judge.** Every link below was checked live on 2026-11-20
~16:31–16:32 UTC and is labeled LIVE or NOT-YET-LIVE as of that check. Do not
trust a label — click the link; if it does not resolve as described, the
claim it supports is unproven. **Re-checked 2026-11-20 18:19 UTC (20:19 EET):**
Render `/` and `/docs` still `404`, `/health` still `200`, miner `774921`
still unregistered; both receipt audit URLs still `404` (re-measured
18:19–18:21 UTC). **NEW since
the 16:32 check: the Desk audit flow has settled live — 13 ranked escrow
calls, 2026-11-20 17:00–17:08 UTC (3 decisions settled: M13-01 APPROVE,
M13-02 APPROVE, M12-01 CURTAIL; plus a 13th call, M12-02 GRID 17:08:01Z,
$0.01, no decision recorded yet; see §1–§2).** Settled audits and the live 1-click UI are two
different things in this file: settled audits = TRUE (they happened);
the 1-click UI at a public URL = NOT YET LIVE.

**Entry:** VeriReceipt Desk — Track 3 Apps & Agents, Season II.
Primary mission: Mission 13 Asset Management (bounty #201). Secondary:
Mission 12 Mining & Power (bounty #200). Testnet only: Ethereum Sepolia,
Test USDC.

> Disclosure: VeriReceipt Desk and the VeriReceipt Miner are operated by the same team. Calls made by VeriReceipt Desk use Telegraph's ranked router (`POST /engine/v1/ask`) on Ethereum Sepolia testnet (Test USDC only) and are explicitly labeled as related-party / internal test traffic, not independent customer demand. Independent third-party developer runs are logged and identified separately.

---

## 0. What is already verifiable today (no Desk needed)

These checks work right now against the live miner service. They prove the
receipt machinery the Desk is built on.

| # | What the judge clicks / runs | What they see | Status |
|---|---|---|---|
| 1 | `curl -s https://verireceipt.onrender.com/health` | `200 {"status":"ok","service":"verireceipt","uptime_s":12149,"upstreams":{}}` | LIVE (2026-11-20 16:32 UTC) |
| 2 | `curl -s "https://verireceipt.onrender.com/v1/tvl?protocol=aave-v3"` | Aave V3 TVL `$15,136,132,391` as of `2026-11-20T13:56:59Z`, `verdict: "verified"`, `confidence: 1`, plus `receipt.raw_response_sha256: 0x6fad7b9b…629b3` | LIVE (2026-11-20 16:31 UTC) |
| 3 | `curl -s https://api.llama.fi/protocol/aave-v3 \| sha256sum` | `6fad7b9be5364f29e00508f4ae25c9cdf0af042bef666f52f5091ed989a629b3` — exact match with the receipt (strip the `0x` prefix) | LIVE — recomputation VERIFIED (2026-11-20 16:32 UTC) |
| 4 | `curl -i "https://verireceipt.onrender.com/v1/route?pair=BTC%2FUSD"` | `HTTP 422 {"error":"invalid_pair","code":"INVALID_PAIR","message":"unsupported pair \"BTC/USD\"; only ETH/USDC is supported"}` — no quote | LIVE (2026-11-20 16:31 UTC) |
| 5 | `curl -i "https://verireceipt.onrender.com/v1/tx?tx_hash=not-a-hash&chain=ethereum"` | `HTTP 400` error body, no invented transaction | LIVE (2026-11-20 16:31 UTC) |
| 6 | https://github.com/mohamedwael201193/verireceipt | Public repo | LIVE (verified via API 2026-11-20) |
| 7 | https://github.com/telegraphprotocol/bounties/issues/201 | "Mission 13 — Asset Management — Season II", open | LIVE (verified via API 2026-11-20) |
| 8 | https://github.com/telegraphprotocol/bounties/issues/200 | "Mission 12 — Mining & Power — Season II", open | LIVE (verified via API 2026-11-20) |

**Not yet live (checked 2026-11-20 ~16:32 UTC):**

| Artifact | Check | Result |
|---|---|---|
| Miner registration `774921` | `GET https://devnode.telegraphprotocol.com/api/miners/774921` | NOT-YET-LIVE — `404 {"error":"miner registration not found"}` (internal target Nov 21 EOD — not an official deadline; the only hard deadline is Dec 1, 23:59 UTC; re-verified 2026-11-20 18:19 UTC (20:19 EET) — still `404`, 4.4 s) |
| Desk app on Render | `GET https://verireceipt.onrender.com/` | NOT-YET-LIVE — `404` (re-verified 2026-11-20 18:19 UTC (20:19 EET) — still `404`, 2.5 s) |
| `/docs`, `/api/mcp`, `/llms.txt` | `GET` each on Render | NOT-YET-LIVE — all `404` (re-verified `/docs` 2026-11-20 18:19 UTC (20:19 EET) — still `404`, 2.5 s) |
| `/receipts`, `/status` on Render | `GET` each on Render | NOT-YET-LIVE — all `404` |
| `/api/health` on Render | `GET https://verireceipt.onrender.com/api/health` | NOT-YET-LIVE — `404` (health lives at `/health`, not `/api/health`) |
| Desk on Vercel | `GET https://verireceipt.vercel.app/` and `/receipts` | LIVE as HTTP 200 — BUT in-app navigation failed a click-test 2026-11-20 15:08 EET (URL changes, old page stays). Treat as NOT-YET-LIVE for navigation until re-tested. |
| Bounties star | `gh api user/starred/telegraphprotocol/bounties` | UNVERIFIED in this pass — verify before filing. |

---

## 1. Mission 13 walkthrough (primary) — what a judge clicks

**Goal:** a judge with no account, no wallet, and no key runs an allocation
audit and verifies every answer.

1. **Open the Desk.** [NOT-YET-LIVE — Desk URL to be filled after the
   1-click preset works.] The page would load with no wallet prompt and show
   a live payer-USDC runway ticker.
2. **Click one preset** (e.g. the healthy-allocation preset). The Desk would
   buy 6 ranked intents via `POST /engine/v1/ask` (`max_budget_usdc: 260000`,
   escrow `X-PAYMENT`): its 5 own intents (tx lookup, filings monitor, TVL
   lookup, execution route, sanctions check) plus the independent price
   check. Checks would arrive one at
   a time, each named, timed, and priced; the running cost line stays visible.
   [1-click UI NOT-YET-LIVE — but the audit flow behind the button HAS
   settled twice: M13-01 APPROVE (run
   `desk_8d41df4f-07f1-44f7-974d-ae3c56b725ff`, decided 2026-11-20T17:02:23Z,
   $0.05, 5 calls, 7 checks) and M13-02 APPROVE (run
   `desk_f6e2419b-acb9-4570-a51b-fedb972af7a6`, decided 2026-11-20T17:03:44Z,
   $0.05, 5 calls, 7 checks), all 10 `signal_hash`es resolvable on the node.
   Note: both settled runs bought the sanctions check but SKIPPED the
   independent price check (`route_vs_spot: skipped` — no `CRYPTO_PRICE_USD`
   bought in either run).]
3. **Read the verdict.** The banner would show `APPROVE` / `HOLD` / `REJECT` with
   the Explainability Why Box stating which check drove the decision.
   [UI banner NOT-YET-LIVE; the verdicts themselves are SETTLED — APPROVE in
   M13-01 and M13-02, with a Why Box in `receipts/decisions.jsonl`.]
4. **Open the receipt drawer** for any check. Each entry would link to
   `https://devnode.telegraphprotocol.com/engine/v1/signal/<signal_hash>`.
   Before epoch close the delivery link would show a "Pending hourly epoch
   finalization" badge, never a broken `404`. [NOT-YET-LIVE — the drawer UI;
   the links themselves resolve: all 13 `signal_hash`es returned
   `200` when J2 resolved them, and 2 were spot-checked again 2026-11-20
   18:21 UTC (20:21 EET) → `200` (3.5 s and 2.8 s).]
5. **Recompute one receipt.** Take a check's `receipt.upstream_url` and
   `receipt.raw_response_sha256`, fetch the upstream, and compare hashes —
   exactly as in §0 check 3 above, which is already verified live for the
   miner's TVL receipt. [Desk version NOT-YET-LIVE; miner anchor VERIFIED]
6. **Run the refusal drill.** Use the preset with an unverifiable input
   (e.g. a reverted counterparty tx); the Desk UI would have to return `HOLD`
   or `REJECT`, never an approval on missing evidence. What the settled runs
   prove so far: `APPROVE` only on fully passing evidence (M13-01, M13-02)
   and `CURTAIL` on dispatch economics (M12-01) — no settled Desk `HOLD` or
   `REJECT` exists yet, so the UI refusal drill is still unproven. The
   miner-level refusal is already verified (§0 check 4: HTTP `422`, no quote).
   [Desk version NOT-YET-LIVE]
7. **Check the ledger.** Open `/receipts` and confirm every call is logged
   with `signal_hash`, cost, and decision. [NOT-YET-LIVE — `/receipts`
   returns `404` on Render; Vercel `/receipts` returns `200` but its
   navigation is unproven.]

**Mission 13 acceptance bar:** 110 ranked escrow calls across 20 allocation
scenarios (10 scenarios × 6 calls + 10 scenarios × 5 calls — scenarios 11–20
skip the sanctions screen; seed plan 140 calls total incl. 30 M12), all in
`receipts/ledger.jsonl` with resolvable `signal_hash`es;
decisions in `receipts/decisions.jsonl`. [PROGRESS 2026-11-20 17:03:44 UTC:
10 M13 calls across 2 scenarios settled (M13-01 APPROVE, M13-02 APPROVE,
$0.05 each); target 110 calls / 20 scenarios still open. 1-click UI
NOT-YET-LIVE.]

## 2. Mission 12 walkthrough (secondary) — what a judge clicks

1. **Open the Desk, pick the Mission 12 preset** (mining facility pricing
   node + settlement interval + hashprice break-even in $/MWh).
   [NOT-YET-LIVE]
2. **The Desk would buy** `GRID_POWER_PRICE_GENERAL` +
   `MINING_HASHPRICE_VERIFY_GENERAL` via ranked ask and output `MINE` /
   `CURTAIL` / `HOLD`. [1-click UI NOT-YET-LIVE — but M12-01 already settled
   `CURTAIL` via 2 ranked calls (run `desk_1d7d6516-5b48-4c53-9ed0-af28f78bbfe7`,
   decided 2026-11-20T17:07:20Z, $0.02: grid $77/MWh vs $25 break-even). M12-02
   has 1 `GRID_POWER_PRICE_GENERAL` call logged (2026-11-20T17:08:01Z) with no
   decision recorded yet.]
3. **Break it:** a future (unfinished) interval or a wrong location must
   produce `HOLD`, never a price. The miner-level equivalent is verified:
   a future grid interval returns HTTP `422` (see repo `JUDGE.md`).
   [Desk version NOT-YET-LIVE]

**Mission 12 acceptance bar:** 30 ranked escrow calls across 15 grid
dispatch scenarios, including at least one wrong-location `HOLD` and one
unfinished-interval `HOLD`, all logged. [PROGRESS 2026-11-20 17:08:01 UTC:
3 M12 calls logged (M12-01 `CURTAIL` settled; M12-02 partial — 1 call, no
decision yet). Target 30 calls / 15 scenarios, including the two `HOLD`
drills, still open. 1-click UI NOT-YET-LIVE.]

## 3. Rubric map — every point to a verifiable artifact

Track 3 rubric (rules §6, Apps & Agents tab — verified live 2026-11-20
18:12 UTC on https://hackathon.telegraphprotocol.com/rules, corroborated by
bounties #201 and #200): Technical quality and mainnet readiness 35 (min
24/35), Commercial viability 25, Genuine independent adoption and retention
10, Telegraph network integration and usage quality 5, Reproducibility,
demo/tutorial, and verifiable proof 5, Organic growth 20 (Content and education 5, Ease of adoption 5, Organic distribution 5, Community growth and activation 5). Total /100, need ≥70 + technical
quality ≥24/35.

| Rubric axis | Points | How this entry earns it | Artifact (status) |
|---|---|---|---|
| Technical quality and mainnet readiness | 35 (min 24/35) | Zero-wallet workbench, 5 one-click presets [PLAN — blueprint §7.2 line 550; no preset enumeration in backend `scenarios.ts`; blueprint names 4 outcome types; 5th preset's outcome unspecified], real M2M escrow purchases [TRUE — 13 ranked escrow purchases, 3 decisions settled, 2026-11-20 17:00–17:08 UTC], deterministic APPROVE/HOLD/REJECT + MINE/CURTAIL/HOLD [PARTLY TRUE — APPROVE ×2 and CURTAIL ×1 settled; no settled HOLD/REJECT yet]; Missions 13 (primary, #201) + 12 (secondary, #200); fail-closed drills verified (422 unsupported pair, 400 malformed hash); no wallet wall, runway ticker, Why Box, receipt drawer with pending-epoch badge (zero `404` links) [UI NOT-YET-LIVE]; spending caps ($2/day, 5 free/IP/day) and per-miner latency in UI [NOT-YET-LIVE] | Live Desk URL [NOT-YET-LIVE]; `src/desk/policyM13.ts`, `policyM12.ts` [EXIST in the backend work clone (`backend/src/desk/`, 21,354 B / 15,138 B, revised 2026-11-20 21:29 UTC (M13) / 19:31 UTC (M12)), imported by `scenarios.ts` (`evaluateM13`/`evaluateM12`) — NOT yet on GitHub (uncommitted; `gh api` 404 at main `8ee2e64`); UI/Render deployment NOT-YET-LIVE. PROVENANCE — these files do NOT reproduce the settled decisions: they were revised 21:29 UTC (M13) / 19:31 UTC (M12), AFTER the settled runs (17:02–17:07 UTC), and the current files emit 8 M13 checks (incl. a `tx_hash` check) / 7 M12 checks (incl. `interval_match`, `hashprice_block`), while the settled decisions carry 7 / 5 checks from the pre-revision evaluators, recorded in `receipts/decisions.jsonl` (M13-01, M13-02: 7 checks, no `tx_hash`; M12-01: 5 checks, neither `interval_match` nor `hashprice_block`). A judge re-running the current files would get 8-check / 7-check verdicts, not the settled 7-check / 5-check ones]; policy tests [EXIST in the backend work clone (`tests/policy.test.ts`, imports `evaluateM13`/`evaluateM12`) — same GitHub/deployment status]; `GET /desk/stats` [NOT-YET-LIVE] |
| Commercial viability | 25 | Clear buyer (treasury ops / allocation committees deciding DeFi deployments; mining operators deciding dispatch), genuine problem (re-checkable allocation/dispatch evidence instead of an unverifiable spreadsheet), sensible costs measured ($0.01/check floor; $0.05 per 5-call audit — 5 of 6 intents, price check not yet bought; $0.06 once the 6th price call is added); short commercial summary answered in §8 of the submission (Q1 confirmed verbatim from the rules page; Q2–Q5 to confirm against the form — see submit-checklist.md §5). NO independent-customer evidence yet — no paying user, no third-party buyer; the adoption gate below is what would produce it | This file §1–§2; `receipts/decisions.jsonl` [LIVE — 3 decisions]; submit-checklist.md §5 commercial brief |
| Genuine independent adoption and retention | 10 | NONE YET — zero independent third-party runs; all 13 settled calls are related-party test traffic (see disclosure). Gate: ≥1 independent developer reproduction logged separately, or independently funded customer activity | Independent reproduction [NONE YET] |
| Telegraph network integration and usage quality | 5 | Ranked `POST /engine/v1/ask` only (never hardcoded single-miner ask), 7 intent types in the settled runs, all via independent miners (own miner 774921 unregistered, 0 purchases), `signal_hash` + delivery proofs | `receipts/ledger.jsonl` [LIVE — 13 rows, all `signal_hash`es resolvable]; `src/desk/telegraphClient.ts` [EXISTS in the backend work clone (`backend/src/desk/telegraphClient.ts`, 20,307 B, 2026-11-20 17:11), imported by `scenarios.ts` (type-only: `TelegraphClient`/`AskResult`) — NOT yet on GitHub (uncommitted; `gh api` 404 at main `8ee2e64`); UI/Render deployment NOT-YET-LIVE] |
| Reproducibility, demo/tutorial, and verifiable proof | 5 | README, this JUDGE.md, tutorial (about a minute cold — see tutorial §1), receipt re-hash verified live (miner TVL anchor, §0 check 3); `/docs`, `/api/mcp`, `/llms.txt` [NOT-YET-LIVE]; Desk receipt re-hash on camera still unproven; 3-min demo video [NOT-YET-LIVE] | Tutorial `docs/desk-growth/tutorial.md` [DRAFT — curl parts verified, MCP part NOT-RUN]; `/docs` + `/api/mcp` + `/llms.txt` [NOT-YET-LIVE] |
| Organic Growth | 20 | 3-min video + tutorial + 3 dated updates (Nov 22, 26, 29) + ≥1 independent developer reproduction | Video [NOT-YET-LIVE]; X drafts `docs/desk-growth/x-updates.md` [DRAFT — unposted]; independent reproduction [NONE YET] |

## 4. Honest limits (read before scoring)

- Testnet only: Ethereum Sepolia, Test USDC. No real money moves.
- Desk calls are related-party test traffic (same team runs the miner and
  the Desk) — see the disclosure at the top. Independent runs are logged
  separately; none exist yet.
- Execution-route ranking is judged, not certain; a #1 there is probable,
  not certain. Grid prices vary by epoch.
- The `$0.05` per-audit figure is now MEASURED, not arithmetic: each settled
  5-call Mission 13 audit cost $0.05 (M13-01, M13-02, 2026-11-20 17:02–17:03
  UTC). Future audits add a 6th call (independent price) and will cost $0.06
  — do not cite $0.05 as the permanent per-audit cost.
- Miner `774921` is unregistered as of 2026-11-20 (re-verified 18:19 UTC
  (20:19 EET) — still `404`); ranked positions do not exist until after registration
  (internal target Nov 21 EOD — not an official deadline; the only hard deadline is Dec 1, 23:59 UTC) and the grace period ends (Nov 28 per the blueprint — NOT on
  the official timeline page; verify the date before citing it).
- Ledger reconciliation (2026-11-20, disclosed in `backend/README.md`): the
  node ledger shows $0.15 paid (15 × $0.01) vs $0.13 logged in
  `receipts/ledger.jsonl` (13 rows) — 2 paid calls unlogged by a seed-runner
  bug (one attributed: the unlogged M12-02 hashprice call, the 14th call of
  the `--max-calls 13` run; the second unattributed). Root cause fixed in the
  seed runner (`buy()` now checks the budget before firing the ask, and every
  bought call is logged immediately), so it cannot recur. The "13 calls /
  $0.13" totals in this file are exactly true of `ledger.jsonl`; $0.15 is
  what the node billed.
