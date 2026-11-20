# VeriReceipt Desk — X Update Drafts (DRAFTS ONLY — the user posts these himself)

- **Disclosure rule (every post):** each draft below discloses that this is a
  Telegraph Hackathon Season II entry competing for prize money. Nothing is
  posted by any agent.
- **Numbers rule:** only numbers verified live on 2026-11-20 ~16:31 UTC appear
  as facts, plus the settled Desk audits verified from the ledger
  (2026-11-20 17:00–17:08 UTC): 13 ranked escrow calls — M13-01 APPROVE and
  M13-02 APPROVE at $0.05 each (5 calls each), M12-01 CURTAIL at $0.02
  (2 calls), M12-02 GRID at $0.01 (1 call, 17:08:01Z, no decision recorded
  yet) — $0.13 total; all 13 `signal_hash`es resolvable. Anything else is a `[FILL AFTER PROOF]`
  placeholder — fill it from a live run, never from the plan.
- **Style:** short, factual, humble. No scores, no ranks, no PnL claims, no
  competitor names, no "first" or "best" claims.
- **Verified facts available to all three drafts:** miner base
  `https://verireceipt.onrender.com`; `/health` returns `200 {"status":"ok"}`;
  TVL for `aave-v3` is `$15,136,132,391` as of `2026-11-20T13:56:59Z` with a
  receipt hash that re-computes exactly; a wrong-pair request returns HTTP
  `422` with no invented quote; `$0.01` per call is the protocol floor price.
  Miner id `774921` / slug `verireceipt` is NOT registered yet (internal target
  Nov 21 EOD — not an official deadline; the only hard deadline is Dec 1,
  23:59 UTC) — do not claim registration until it is live.

---

## Update #1 — Nov 22, 2026 (problem + working proof)

> VeriReceipt Desk — update 1/3. Building for the Telegraph Hackathon Season II
> (Apps & Agents track, Mission 13 Asset Management). Prize money is at stake;
> this is our entry, not independent demand.
>
> The problem: before an allocation moves, four questions need re-checkable
> answers — is the counterparty tx real, is the issuer clean in the filings,
> how big is the protocol, what does execution cost.
>
> What works today: our zero-LLM miner answers four intents live at
> https://verireceipt.onrender.com — e.g. Aave V3 TVL $15,136,132,391 as of
> Nov 20, each answer carrying a SHA-256 receipt over the raw upstream
> response. The fifth intent (grid) answers cached intervals only. We
> re-fetched the source and the hash matched exactly on a fast re-fetch —
> the same check failed once in the browser the same day, so we present the
> mechanism as verified for fast re-fetch, not settled.
>
> What does not work yet: the Desk 1-click UI itself and miner registration
> (internal target Nov 21 slipped; registration still pending — re-checked
> 2026-11-20 19:56 UTC, still unregistered). Nov 21 was our internal target,
> not an official deadline; the only hard deadline is Dec 1, 23:59 UTC. The
> audit flow behind the UI has already settled 3 decisions
> via ranked escrow on Nov 20 (M13-01 APPROVE, M13-02 APPROVE, M12-01
> CURTAIL — 12 calls, $0.12 total; plus a 13th call, M12-02 GRID, $0.01,
> no decision recorded yet). Next: the 1-click preset UI, then
> miner registration.
>
> Try it: `curl "https://verireceipt.onrender.com/v1/tvl?protocol=aave-v3"`
> Docs: [FILL AFTER PROOF — /docs URL once it returns 200]

> BEFORE POSTING #1 (Nov 22): RE-CHECK the registration state first —
> `GET https://devnode.telegraphprotocol.com/api/miners/774921`. If the GET
> times out or errors, retry; do not post until it returns a definitive 200
> (`active`) or 404 — never apply either branch on a timed-out check. Nov 21 was
> our INTERNAL target, not an official deadline (the only hard deadline is
> Dec 1, 23:59 UTC), and it has passed by the post date — the copy above
> already says so ("internal target Nov 21 slipped; registration still
> pending"), so update only the re-check timestamp if registration is still
> not live, and never present Nov 21 as an official deadline or as still
> open. If registration IS live (`activation_status: "active"`) by then, change
> ALL THREE registration-status statements in the post copy above — a minimal
> swap leaves the post self-contradictory: (1) in "What does not work yet: the
> Desk 1-click UI itself and miner registration (internal target Nov 21
> slipped; registration still pending — re-checked 2026-11-20 19:56 UTC, still unregistered)."
> delete " and miner registration (internal target Nov 21 slipped; registration still pending — re-checked 2026-11-20 19:56 UTC, still unregistered)" so the sentence reads "What does not work
> yet: the Desk 1-click UI itself." and add after it the new sentence "Miner
> registration is live: [live activation link]."; (2) in "Nov 21 was our
> internal target, not an official deadline; the only hard deadline is Dec 1,
> 23:59 UTC." replace it with "The only hard deadline is Dec 1,
> 23:59 UTC."; (3) in "Next:
> the 1-click preset UI, then miner registration." delete ", then miner
> registration" so it reads "Next: the 1-click preset UI."

## Update #2 — Nov 26, 2026 (working purchase + receipts + failure drill)

> VeriReceipt Desk — update 2/3. Telegraph Hackathon Season II entry
> (Apps & Agents, Mission 13); prize money is at stake.
>
> The Desk's audit flow has settled live (12 ranked escrow calls on Nov 20
> for the 3 decisions settled — $0.12 total; plus a 13th call, M12-02 GRID,
> $0.01, no decision recorded yet — [FILL AFTER PROOF — updated count/total at posting time, M13/M12
> split]); the 1-click UI proof below is still missing — do not post this
> update until the live Desk URL exists: [FILL AFTER PROOF
> — number of settled ranked calls so far] ranked escrow calls at $0.01 each,
> [FILL AFTER PROOF — total Test USDC spent], every answer with a
> `signal_hash` you can resolve on the node.
>
> What we also show: the failure drill. Ask for a pair we do not support
> and you get HTTP 422 with no quote — verified live, no invented number.
>
> Honest limits: testnet only (Sepolia, Test USDC). Desk calls are
> related-party test traffic — same team runs the miner and the Desk.
> Tutorial: [FILL AFTER PROOF — tutorial link once published]
> Live app: [FILL AFTER PROOF — Desk URL once the 1-click preset works]

## Update #3 — Nov 29, 2026 (results + honest limitations)

> VeriReceipt Desk — update 3/3. Telegraph Hackathon Season II entry
> (Apps & Agents, Mission 13 + Mission 12); prize money is at stake.
>
> Results so far: [FILL AFTER PROOF — total ranked calls, decisions settled,
> M13/M12 split, total Test USDC spent, and the live ledger link]. Every call is
> logged with its `signal_hash` and receipt.
>
> Demo video (3 min, recorded from the running app): [FILL AFTER PROOF —
> video link once uploaded]
>
> What is not proven: [FILL AFTER PROOF — ranked positions after the
> grace period ends (Nov 28 per the blueprint — NOT on the official
> timeline page, so verify the date before citing it), read off the live
> leaderboard; if a position is not yet recorded, say so instead of
> claiming one]. Execution-route ranking is judged, not certain; grid
> prices vary by epoch.
>
> Try it yourself, no account needed: [FILL AFTER PROOF — live Desk URL]
> — and if you run a check, reply with your `signal_hash`; independent
> runs are logged separately from our own test traffic.

---

## Posting notes (for the user)

- Post in order, on the dated days. Do not backdate.
- Before posting #2, the `[FILL AFTER PROOF]` items need: settled-call count
  from `receipts/ledger.jsonl`, total Test USDC spent, tutorial link, Desk URL.
- Before posting #3, the items need: final call totals, ledger link, video
  link, ranked positions post-grace (Nov 28+ per the blueprint — NOT on the
  official timeline page; verify the date before citing it), live Desk URL.
- Each post discloses the hackathon/prize incentive in its first lines —
  keep that disclosure when editing.
- Note: blueprint §10 Day 9 says "Update #3 (Nov 28)" while §9.1/§11 say
  Nov 29. This package uses Nov 29 (the task's date); if the Nov 28 date
  is preferred, post #3 on Nov 28 and correct the date here.
