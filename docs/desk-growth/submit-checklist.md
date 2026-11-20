# VeriReceipt Desk — Submission Checklist (DRAFTS ONLY — the user files everything himself)

**Deadlines:** miner registration Nov 21 EOD (internal target — NOT an official deadline; no Nov 21 event appears on the official rules or timeline pages). The only hard deadline is Season II closing
**Dec 1, 2026, 23:59 UTC** — official submissions on
`https://hackathon.telegraphprotocol.com` at least 12 hours before that.
Verification and judging Dec 2–8 (planned); provisional results from Dec 9
with a 72-hour appeal window (official timeline
https://hackathon.telegraphprotocol.com/timeline; repo README.md:102 agrees).
**No agent submits anything.** Post nothing; file nothing.

**Mechanics (Track 3 guide §b/§e):** builders post `/progress` updates and
`/submit` on the mission's bounties issue
(`https://github.com/telegraphprotocol/bounties/issues/<number>`); the
bounties post is belt-and-braces — the official H2 website submission is the
real filing. One submission per track, not per mission: **5 Track 1
submissions (1 per intent) + 1 Track 3 submission (VeriReceipt Desk)**.
Star `github.com/telegraphprotocol/bounties` first (rules §5, required) and
note the GitHub username that starred it — the form asks for it.

**Status 2026-11-20:** miner id `774921` NOT registered yet
(`GET https://devnode.telegraphprotocol.com/api/miners/774921` →
`404 {"error":"miner registration not found"}`, re-verified 2026-11-20 18:19 UTC (20:19 EET)).
Settled Desk audits DO exist: 13 ranked escrow calls 2026-11-20 17:00–17:08
UTC — 3 decisions settled: M13-01 APPROVE 17:02:23Z ($0.05), M13-02 APPROVE 17:03:44Z ($0.05),
M12-01 CURTAIL 17:07:20Z ($0.02); M12-02 partial (1 call, $0.01, no decision yet);
all 13 `signal_hash`es resolvable. What is still NOT live: the Desk 1-click
UI (Render `/` and `/docs` → `404`, re-verified 2026-11-20 18:19 UTC (20:19 EET)) and miner
registration. Do NOT post `/claim` or `/submit` until the gates in each
draft pass — the gates that remain are the live-UI and registration gates,
not a settled-audit gate.

---

## 1. `/claim` — Mission 13, bounty #201 (primary)

**Where:** comment on `https://github.com/telegraphprotocol/bounties/issues/201`.
**When:** Nov 22 (blueprint Day 3) — only after miner registration is live
(`GET /api/miners/774921` → `activation_status: "active"`).

**Exact comment text (copy-paste):**

```
/claim

VeriReceipt Desk — claiming Mission 13 (Asset Management) for Track 3
(Apps & Agents), Season II.

App: [FILL AFTER PROOF — live Desk URL once the 1-click preset works]
Miner: verireceipt (id 774921) — [FILL AFTER PROOF — registration tx / activation link]
Repo: https://github.com/mohamedwael201193/verireceipt [VERIFY repo URL before posting]
Live miner: https://verireceipt.onrender.com — five zero-LLM intents, every
answer with a SHA-256 receipt over the raw upstream response.

Settled (2026-11-20 17:00–17:03 UTC): the audit flow behind the 1-click
preset has run twice via ranked escrow — M13-01 APPROVE 17:02:23Z and
M13-02 APPROVE 17:03:44Z, 5 ranked intents each at $0.05, every
`signal_hash` resolvable on the node. Still to prove live: the 1-click
preset UI at the filed URL. 1-click pre-allocation & counterparty gate.
The Desk would buy 6 ranked Telegraph intents per FULL allocation check (its 5
own intents — tx lookup, filings monitor, TVL, execution route, sanctions
check — plus the independent price check; the 6-intent standard is the full
variant, scenarios 1–10 — scenarios 11–20 of the seed plan buy 5 calls: 4 own
intents + price, sanctions skipped) via ranked POST /engine/v1/ask (max_budget_usdc: 260000,
escrow X-PAYMENT) and output APPROVE / HOLD / REJECT with an Explainability
Why Box and per-check receipts. (In the settled runs the independent price
check was skipped — `route_vs_spot: skipped`, no `CRYPTO_PRICE_USD` bought
yet; sanctions checks were bought in both.)

Disclosure: VeriReceipt Desk and the VeriReceipt Miner are operated by the same team. Calls made by VeriReceipt Desk use Telegraph's ranked router (`POST /engine/v1/ask`) on Ethereum Sepolia testnet (Test USDC only) and are explicitly labeled as related-party / internal test traffic, not independent customer demand. Independent third-party developer runs are logged and identified separately.
```

## 2. `/progress` — Mission 13, bounty #201 (primary)

**Where:** comment on issue #201. **When:** within the progress window after
`/claim` (blueprint Day 6, Nov 25) — only after ≥70 verified receipts exist
in `receipts/ledger.jsonl` AND only after miner registration is live
(`GET /api/miners/774921` → `activation_status: "active"`).

**Exact comment text (copy-paste):**

```
/progress

VeriReceipt Desk — Mission 13 progress update (Nov 25).

- Miner registered: verireceipt (774921), activation_status active.
  [FILL AFTER PROOF — activation link; verify `GET /api/miners/774921` →
  `active` before posting]
- Ranked escrow calls so far: [FILL AFTER PROOF — count from receipts/ledger.jsonl]
  across [FILL AFTER PROOF — number] allocation scenarios; total spent
  [FILL AFTER PROOF — Test USDC].
- Every call logged with signal_hash, resolvable at
  https://devnode.telegraphprotocol.com/engine/v1/signal/<signal_hash>.
- Fail-closed drill verified live: unsupported pair returns HTTP 422 with no
  quote (curl output in the repo JUDGE.md).
- Receipt re-hash verified: Aave V3 TVL $15,136,132,391 (Nov 20), hash
  6fad7b9be5364f29e00508f4ae25c9cdf0af042bef666f52f5091ed989a629b3,
  re-fetched and re-hashed to an exact match.
- Live app: [FILL AFTER PROOF — Desk URL] | Tutorial: [FILL AFTER PROOF — link]
- Independent developer reproduction: [FILL AFTER PROOF — name/link, or
  "none yet" — do not claim one until it exists]

Disclosure: VeriReceipt Desk and the VeriReceipt Miner are operated by the same team. Calls made by VeriReceipt Desk use Telegraph's ranked router (`POST /engine/v1/ask`) on Ethereum Sepolia testnet (Test USDC only) and are explicitly labeled as related-party / internal test traffic, not independent customer demand. Independent third-party developer runs are logged and identified separately.
```

## 3. `/claim` + `/progress` — Mission 12, bounty #200 (secondary)

**Where:** comment on `https://github.com/telegraphprotocol/bounties/issues/200`.
**When:** only after the Mission 13 claim is live and ≥1 Mission 12 dispatch
check has settled (buying `GRID_POWER_PRICE_GENERAL` +
`MINING_HASHPRICE_VERIFY_GENERAL` via ranked ask, output `MINE` / `CURTAIL` /
`HOLD`). [Dispatch condition MET 2026-11-20 17:07:20 UTC — M12-01 `CURTAIL`
settled via 2 ranked calls ($0.02). The Mission 13 claim + live Desk URL
gates still hold.] Mission 12 is secondary — do not claim it before Mission 13 is
moving.

**Exact comment text (copy-paste, claim):**

```
/claim

VeriReceipt Desk — claiming Mission 12 (Mining & Power) as a secondary
Track 3 mission, Season II.

App: [FILL AFTER PROOF — live Desk URL]
Settled (2026-11-20 17:07:20 UTC): M12-01 `CURTAIL` via 2 ranked calls
($0.02, grid $77/MWh vs $25 break-even). Still to prove live: the 1-click
preset UI at the filed URL. Real-time dispatch gate. The Desk would buy
GRID_POWER_PRICE_GENERAL + MINING_HASHPRICE_VERIFY_GENERAL via ranked
POST /engine/v1/ask and output MINE / CURTAIL / HOLD — fail-closed if the
interval is unfinished or the location mismatches.

Disclosure: VeriReceipt Desk and the VeriReceipt Miner are operated by the same team. Calls made by VeriReceipt Desk use Telegraph's ranked router (`POST /engine/v1/ask`) on Ethereum Sepolia testnet (Test USDC only) and are explicitly labeled as related-party / internal test traffic, not independent customer demand. Independent third-party developer runs are logged and identified separately.
```

**Progress comment (copy-paste, post when ≥30 Mission 12 calls are logged):**

```
/progress

VeriReceipt Desk — Mission 12 progress update.

- Ranked escrow calls so far: [FILL AFTER PROOF — count, target 30 across
  15 grid dispatch scenarios]; total spent [FILL AFTER PROOF — Test USDC].
- Decisions logged in receipts/decisions.jsonl (MINE / CURTAIL / HOLD).
- Fail-closed drill: [FILL AFTER PROOF — wrong-location / unfinished-interval
  HOLD case, with receipt link]

Disclosure: VeriReceipt Desk and the VeriReceipt Miner are operated by the same team. Calls made by VeriReceipt Desk use Telegraph's ranked router (`POST /engine/v1/ask`) on Ethereum Sepolia testnet (Test USDC only) and are explicitly labeled as related-party / internal test traffic, not independent customer demand. Independent third-party developer runs are logged and identified separately.
```

## 4. `/submit` — bounty #201 (primary) and #200 (secondary)

**Where:** comment on issue #201 (primary) and #200 (secondary).
**When:** Nov 30 – Dec 1, only after the official H2 website submissions are
filed. The bounties post is additional, not a substitute.

**Exact comment text (copy-paste, #201):**

```
/submit

VeriReceipt Desk — final submission, Mission 13 (Asset Management),
Track 3 Apps & Agents, Season II.

- Live app: [FILL AFTER PROOF — Desk URL]
- Demo video (3 min): [FILL AFTER PROOF — video link]
- Repo: https://github.com/mohamedwael201193/verireceipt [VERIFY repo URL before posting]
- Miner: verireceipt (774921) — [FILL AFTER PROOF — /api/miners/774921 link]
- Tutorial: [FILL AFTER PROOF — tutorial link]
- Ledger: [FILL AFTER PROOF — receipts/ledger.jsonl link] —
  [FILL AFTER PROOF — total] ranked escrow calls (M13 [FILL] / M12 [FILL]),
  [FILL AFTER PROOF — total Test USDC] spent.
- Public updates: Nov 22 [link], Nov 26 [link], Nov 29 [link].
- Independent developer reproduction: [FILL AFTER PROOF — link, or "none yet"]
- Official H2 website submission filed: [FILL AFTER PROOF — date/time + screenshot archived]

Disclosure: VeriReceipt Desk and the VeriReceipt Miner are operated by the same team. Calls made by VeriReceipt Desk use Telegraph's ranked router (`POST /engine/v1/ask`) on Ethereum Sepolia testnet (Test USDC only) and are explicitly labeled as related-party / internal test traffic, not independent customer demand. Independent third-party developer runs are logged and identified separately.
```

For #200, post the same text with "Mission 12 (Mining & Power)" and the
Mission 12 call counts.

## 5. Official hackathon-site submission — copy-paste-ready form content

File at `https://hackathon.telegraphprotocol.com` (user files it himself).
**Track 3 submission (1× — VeriReceipt Desk).** Per rules §8 the pack is, in
order: project details, short demo, how to run it, evidence, short public
summary, showcase permission, plus the Apps & Agents short commercial summary
(five short questions, answered in the same form). (Per rules §8, verified
live 2026-11-20 18:12 UTC: the short commercial summary IS an official form
section — "Apps & Agents: answer five short questions in the same form."
Only Q1 is shown on the rules page; Q2–Q5 live in the form, not the page
text — see the commercial brief below, which marks what is confirmed vs
to-confirm at filing time.)

**Project details**

- Project name: VeriReceipt Desk
- Track: Apps & Agents (Track 3)
- Missions: Mission 13 Asset Management (primary, bounty #201); Mission 12
  Mining & Power (secondary, bounty #200)
- Intents consumed: ONCHAIN_TX_LOOKUP_GENERAL,
  REGULATORY_FILING_MONITOR_GENERAL, TVL_LOOKUP_GENERAL,
  OPTIMAL_EXECUTION_ROUTE_GENERAL, GRID_POWER_PRICE_GENERAL,
  MINING_HASHPRICE_VERIFY_GENERAL, plus independent miners'
  SANCTIONS_SCREENING_MATCH_GENERAL (2 settled purchases, 2026-11-20
  17:02–17:03 UTC). `CRYPTO_PRICE_USD` is NOT listed — no Desk run has
  bought it yet (`route_vs_spot: skipped` in both settled M13 audits);
  add it only once a purchase settles with a resolvable `signal_hash`.
- Live URL: [FILL AFTER PROOF — Desk URL once the 1-click preset works]
- Repo: https://github.com/mohamedwael201193/verireceipt [VERIFY repo URL before filing]
- GitHub username that starred `telegraphprotocol/bounties`:
  mohamedwael201193 [VERIFY star before filing]

**Short demo**

- 3-minute narrated video, to be recorded from the running app once the
  1-click preset works: problem → 1-click Mission 13 audit → signal_hash +
  SHA-256 recomputation → 422 fail-closed drill → live Epoch leaderboard →
  /api/mcp + local run + honest limits. Link: [FILL AFTER PROOF — video link]

**How to run it** — [TO-FILL — verify the 1-click preset live at the filed
URL before filing. Settled audits already exist (13 ranked escrow calls,
2026-11-20 17:00–17:08 UTC: M13-01 APPROVE, M13-02 APPROVE, M12-01 CURTAIL,
plus M12-02 GRID — 1 call, $0.01, no decision yet; all 13 `signal_hash`es resolvable) — what is NOT yet proven end-to-end is the
1-click preset UI at the filed URL. This gate waits on the UI, not on a
settled audit.]

- Open the live URL — no account, no wallet, no key. Click a preset; the
  Desk would buy the checks and return APPROVE / HOLD / REJECT with the Why Box
  and per-check receipts. Or run one check yourself, no login:
  `curl "https://verireceipt.onrender.com/v1/tvl?protocol=aave-v3"` and
  recompute the receipt hash with
  `curl -s https://api.llama.fi/protocol/aave-v3 | sha256sum`
  (verified exact match, Nov 20). Costs: $0.01 per ranked call (protocol
  floor); a 5-call Mission 13 audit measured $0.05 (5 of 6 intents; price
  check not yet bought) in the two
  settled audits (2026-11-20 17:02–17:03 UTC) — future 6-call audits will
  be $0.06 once the independent price call is added. Spending limits: 5 free live checks / IP / day, $2.00 / day global
  cap. Known limitations: testnet only (Sepolia, Test USDC); execution-route
  ranking is judged, not certain; grid prices vary by epoch; Desk calls are
  related-party test traffic (see disclosure).

**Evidence**

- [FILL AFTER PROOF — receipts/ledger.jsonl link]: ranked escrow calls with
  signal_hash links (target 140: 110 M13 + 30 M12).
- [FILL AFTER PROOF — receipts/decisions.jsonl link]: APPROVE/HOLD/REJECT
  and MINE/CURTAIL/HOLD decisions.
- Live endpoints: `https://verireceipt.onrender.com/health` (200),
  `/v1/tx`, `/v1/filings`, `/v1/tvl`, `/v1/route`, `/v1/grid-price` — each
  with `receipt.raw_response_sha256`.
- Fail-closed drills: HTTP 422 on unsupported pair, HTTP 400 on malformed
  hash (both verified live Nov 20; outputs in repo JUDGE.md).
- Settled-run verification — use ONLY `receipts/decisions.jsonl` (3 decisions: M13-01 / M13-02, 7 checks each; M12-01, 5 checks). Do NOT cite §6 of `backend/JUDGE.md` ("VeriReceipt Desk (Track 3)") as settled-run evidence: that file lives in the backend work clone (`backend/JUDGE.md`), is uncommitted and not on GitHub, and the growth repo's own in-repo `JUDGE.md` has no §6 at all (§§1–5 only). §6 describes the CURRENT policy code, and its figures are FALSE as a description of the settled runs: (1) its worked example is a $0.06 / 6-call M13 audit incl. an independent spot price — the settled M13 audits measured $0.05 / 5 calls each; (2) it presents `route_vs_spot` as computed against a bought `CRYPTO_PRICE_USD` (not skipped) — both settled M13 decisions record `route_vs_spot: "skipped"` ("No independent spot-price evidence was bought in this run") and the 13-row ledger contains 0 `CRYPTO_PRICE_USD` rows; (3) it presents a $0.06 M13 run cap with 8-check M13 / 7-check M12 verdicts incl. a `tx_hash` binding check (M13) and `interval_match` / `hashprice_block` (M12) — the settled runs carry 7-check M13 / 5-check M12 verdicts with no `tx_hash` check. (§6 itself notes the settled runs do not satisfy the current-code description — which is exactly why it must not be cited as settled-run evidence.) Current code — `backend/src/desk/policyM13.ts` / `policyM12.ts`, revised after the 17:02–17:07 UTC runs — does emit 8 / 7 checks; see the provenance row in `JUDGE-desk-draft.md` §3. A judge re-running the current files would get 8-check / 7-check verdicts, not the settled 7-check / 5-check ones. For the settled runs, cite `receipts/decisions.jsonl` only.
- Miner: verireceipt (774921) — [FILL AFTER PROOF — /api/miners/774921 link].

**Short public summary**

[TO-FILL AT FILING — the settled-audit condition is MET (13 ranked escrow
calls, 2026-11-20 17:00–17:08 UTC, all `signal_hash`es resolvable), so the
capability sentences below are facts, not plans. Do NOT file until the live
Desk URL and the 1-click preset are verified live at the filed URL — the
gate that remains waits on the UI, not on a settled audit.]

VeriReceipt Desk is a zero-wallet workbench that gates institutional DeFi
allocations (Mission 13) and mining dispatch (Mission 12) on paid, receipted
Telegraph intelligence. Its audit flow has settled live: 13 ranked escrow
calls on 2026-11-20 (M13-01 APPROVE and M13-02 APPROVE at $0.05 each;
M12-01 CURTAIL at $0.02; plus a 13th call, M12-02 GRID at $0.01 with no
decision recorded yet — $0.13 total), every answer carrying a `signal_hash` resolvable
on the node. Once the 1-click preset is live at the filed URL, one click
will buy 6 ranked intents per FULL allocation check (full variant,
scenarios 1–10; scenarios 11–20 buy 5 calls: 4 own intents + price,
sanctions skipped) through the ranked router, cross-check every
field against fail-closed thresholds, and return a verdict with the evidence
attached — every answer carrying a SHA-256 receipt anyone could recompute.
Testnet only. Public updates: Nov 22, Nov 26, Nov 29 [FILL — links].
Tutorial: [FILL — link]. Independent developer testing: [FILL — link, or
"none yet"].

**Showcase permission**

- The user decides at filing time which text, images, recordings, tutorials,
  or experiences may be shared publicly, and whether buyer introductions are
  welcome. (These choices do not affect technical scores.)

**Commercial brief (official §8 form section — "Apps & Agents: short commercial summary": five short questions, answered in the same form)**

Verified live 2026-11-20 18:12 UTC (rules §8): "Apps & Agents: answer five
short questions in the same form." Only Q1 is shown on the rules page; Q2–Q5
live in the form, not the page text — so Q2–Q5 below are this checklist's own
questions, marked TO CONFIRM against the form at filing time. Do NOT cite
their wording as official. Answers are filed in the form; §6 L219–220
cross-references this summary ("The short commercial summary in Section 8")
as helping judges assess commercial viability.

1. Q1 — CONFIRMED verbatim from rules §8: "Who is the user or buyer, and how often do they have this problem?" Treasury ops and allocation committees deciding on DeFi
   deployments; mining operators deciding dispatch.
2. Q2 — TO CONFIRM against the form at filing (wording not on the rules page): What does it improve? Four separate manual checks would become one click with
   re-checkable receipts, instead of a spreadsheet nobody can verify.
3. Q3 — TO CONFIRM against the form at filing (wording not on the rules page): What does it do today? Live autonomous ranked Telegraph purchases +
   verifiable receipts + fail-closed policy engine — settled 2026-11-20
   17:00–17:08 UTC: 13 ranked escrow calls, decisions M13-01 APPROVE (run
   `desk_8d41df4f-07f1-44f7-974d-ae3c56b725ff`), M13-02 APPROVE (run
   `desk_f6e2419b-acb9-4570-a51b-fedb972af7a6`), M12-01 CURTAIL (run
   `desk_1d7d6516-5b48-4c53-9ed0-af28f78bbfe7`); plus a 13th call, M12-02
   GRID (1 call, $0.01, no decision yet); all 13 `signal_hash`es
   resolvable. (Miner still unregistered; 1-click UI not yet live.)
4. Q4 — TO CONFIRM against the form at filing (wording not on the rules page): Why adopt it? $0.01 per check; $0.05 per 5-call audit (5 of 6 intents; price check not yet bought) measured
   2026-11-20 17:02–17:03 UTC ($0.06 once the 6th price call is added).
5. Q5 — TO CONFIRM against the form at filing (wording not on the rules page): How to try it? [FILL — live zero-wallet URL + 1-click presets + keyless MCP/CLI
   command, once live, at filing]

**Related-party disclosure (verbatim — include in README, UI footer, and submission):**

> Disclosure: VeriReceipt Desk and the VeriReceipt Miner are operated by the same team. Calls made by VeriReceipt Desk use Telegraph's ranked router (`POST /engine/v1/ask`) on Ethereum Sepolia testnet (Test USDC only) and are explicitly labeled as related-party / internal test traffic, not independent customer demand. Independent third-party developer runs are logged and identified separately.

---

## 6. Pre-filing checklist

- [ ] Desk 1-click preset verified live at the filed URL (click a preset
      end-to-end). [SATISFIED 2026-11-20 — the settled-audit half of this
      item: 2 M13 audits + 1 M12 dispatch with resolvable signal_hashes.
      The preset UI itself is what remains.]
- [ ] `bounties` repo starred as mohamedwael201193 (verify before filing).
- [ ] Miner `774921` registered; `/api/miners/774921` → `active` (internal target Nov 21 EOD; the only hard deadline is Dec 1, 23:59 UTC).
- [ ] ≥140 ranked escrow calls logged (110 M13 + 30 M12) with resolvable signal_hashes. [PROGRESS: 13/140 as of 2026-11-20 18:20 UTC (20:20 EET) — ledger re-read.]
- [ ] Demo video uploaded (YouTube + X); link pasted in all drafts.
- [ ] Tutorial published; link pasted in all drafts.
- [ ] 3 X updates posted (Nov 22, 26, 29) with incentive disclosure; links archived.
- [ ] ≥1 independent developer reproduction logged separately (or "none yet" stated honestly).
- [ ] Payer wallet funded ≥ $1.00 for Dec 2–8 verification/judging.
- [ ] `/claim` posted on #201 (Nov 22); `/progress` on #201 (Nov 25); `/claim` + `/progress` on #200.
- [ ] 5 Track 1 submissions (1 per intent) + 1 Track 3 submission filed on the
      H2 website ≥12h before Dec 1, 23:59 UTC; screenshots archived.
- [ ] `/submit` posted on #201 and #200 after the website filings.
- [ ] No competitor named in any comment, form field, doc, or UI string.
