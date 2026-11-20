# VeriReceipt Desk — 3:00 Demo Video Script (DRAFT — DO NOT FILM UNTIL EVERY GATE PASSES)

- **Length:** 3:00, narrated screen recording from the running app. No slides for the purchase.
- **Rule:** every beat below is filmed from the live service only. A beat marked
  `TO-FILM-AFTER-PROOF` has no footage yet — do not narrate it, stage it, or
  record a placeholder for it until its gate (listed in the beat) passes.
- **Sources:** blueprint §7 + §9.2 + §10 Day 10; Track 3 guide §e.2 (demo flow:
  problem → Telegraph request → intelligence + provider evidence → observed
  cost → completed result → how to try it).
- **Verified live on 2026-11-20 ~16:31 UTC** (numbers already true then):
  `https://verireceipt.onrender.com/health` returns
  `200 {"status":"ok","service":"verireceipt","uptime_s":12149}`; TVL for
  `aave-v3` is `$15,136,132,391` as of `2026-11-20T13:56:59Z` with
  `receipt.raw_response_sha256 =
  0x6fad7b9be5364f29e00508f4ae25c9cdf0af042bef666f52f5091ed989a629b3`, and a
  fresh fetch of `https://api.llama.fi/protocol/aave-v3` re-hashed to exactly
  `6fad7b9b…629b3` — recomputation VERIFIED. A `422` refusal drill is verified:
  `GET /v1/route?pair=BTC%2FUSD` returns HTTP `422 {"error":"invalid_pair",
  "code":"INVALID_PAIR","message":"unsupported pair \"BTC/USD\"; only
  ETH/USDC is supported"}`. A `400` drill is verified:
  `GET /v1/tx?tx_hash=not-a-hash&chain=ethereum` returns HTTP `400`.
- **Also already true (2026-11-20 17:00–17:08 UTC):** 13 ranked Desk
  escrow calls — 3 decisions settled: M13-01 APPROVE 17:02:23Z ($0.05, 5 calls),
  M13-02 APPROVE 17:03:44Z ($0.05, 5 calls), M12-01 CURTAIL 17:07:20Z ($0.02,
  2 calls) — plus a 13th call, M12-02 GRID 17:08:01Z ($0.01, 1 call, no
  decision recorded yet) — $0.13 total; all 13 `signal_hash`es resolvable
  on the node.
- **Not yet live (2026-11-20 ~16:32 UTC):** miner id `774921` is NOT
  registered — `GET https://devnode.telegraphprotocol.com/api/miners/774921`
  returns `404 {"error":"miner registration not found"}` (registration —
  internal target Nov 21 EOD, not an official deadline; the only hard
  deadline is Dec 1, 23:59 UTC). On Render, `/`, `/docs`, `/api/mcp`, `/receipts`, `/status`,
  `/llms.txt` all return `404` — the Desk pages are not live there yet.
  `https://verireceipt.vercel.app/` returns `200`, but its in-app navigation
  failed a click-test on 2026-11-20 15:08 EET (URL changes, old page stays).

---

## 0:00–0:25 — Problem (25s)

- **Visual:** title card, then the mission's buyer in one line on screen. No
  footage of the app yet.
- **Narration:** "Before an institution moves money into a DeFi protocol, it
  has to answer four questions: is the counterparty transaction real, is the
  issuer clean in the filings, how big is the protocol, and what does the
  execution cost. Today that is four tabs, four vendors, and a spreadsheet
  nobody can re-check."
- **On-screen text:** "One allocation. Four questions. Zero re-checkable
  evidence — until now."
- **Gate:** none — problem statement only, no claim to prove.

## 0:25–1:15 — Live 1-click Mission 13 audit + streaming cost (50s)

- **Visual:** `TO-FILM-AFTER-PROOF` — open the live Desk, click one preset,
  watch the checks arrive one at a time, each named, timed, and priced; the
  verdict banner lands `APPROVE` / `HOLD` / `REJECT` with the Explainability
  Why Box. The running cost line stays visible throughout.
- **Narration (draft, do not record until the gate passes):** "One click. The
  Desk would buy the checks from the ranked router — the transaction lookup, the
  filings monitor, the TVL lookup, the execution route, plus independent
  price and sanctions checks — and each answer would arrive with its own receipt.
  [FILL AFTER PROOF: exact per-check cost line as shown on screen.]"
  (Note for the narrator: the settled runs bought sanctions but SKIPPED the
  independent price check — `route_vs_spot: skipped`, no `CRYPTO_PRICE_USD`
  bought. Narrate "price" only once a 6-call run with the price bought has
  settled.)
- **On-screen text:** the live cost line as rendered by the app; the verdict
  as rendered by the app. No cost figure is spoken or shown unless it is on
  screen from a live run.
- **Gate (all must pass before filming):** (1) a 1-click preset runs
  end-to-end with no wallet prompt — STILL OPEN (UI not live, re-verified
  2026-11-20 18:19 UTC (20:19 EET)); (2) SATISFIED 2026-11-20 17:02–17:03 UTC — two 5-call
  Mission 13 audits settled (5 of 6 intents; price check not yet bought) via ranked `POST /engine/v1/ask` (M13-01 APPROVE,
  M13-02 APPROVE), every `signal_hash` resolvable;
  (3) the per-audit cost shown is the measured total — MEASURED: `$0.05` per
  settled 5-call audit (2026-11-20 17:02–17:03 UTC). Do NOT narrate the old
  blueprint plan price of `$0.04` — it was arithmetic from the floor,
  superseded by the measured `$0.05`. State the `$0.05` figure with its date
  and 5-call count, never as the permanent per-audit cost: future audits add
  a 6th call (independent price) and will cost `$0.06`.

## 1:15–1:55 — signal_hash & raw_response_sha256 recomputation (40s)

- **Visual:** the receipt drawer for one check from the audit above. Click
  the `signal_hash` link (resolves on the node), then in a terminal run the
  recomputation against the receipt's `upstream_url` and compare the hash.
- **Narration (draft):** "Every answer carries a receipt. The hash is the
  SHA-256 of the raw upstream response — not of our summary of it. One
  command, and you can check it yourself — allow about a minute cold for
  the fetch; warm, it takes seconds."
- **On-screen text:** the exact commands, typed live:
  `curl -s "https://api.llama.fi/protocol/aave-v3" | sha256sum`
- **Verified anchor (already true, usable as the filmed example if the Desk
  receipt is not yet ready):** the miner-level recomputation is already
  proven — TVL `$15,136,132,391`, hash
  `6fad7b9be5364f29e00508f4ae25c9cdf0af042bef666f52f5091ed989a629b3`,
  re-fetched and re-hashed 2026-11-20 ~16:32 UTC with an exact match. If the
  film uses this anchor instead of a Desk receipt, the narration must say
  so: "this is the miner's own TVL receipt" — never present it as a Desk
  audit receipt.
- **Gate:** if the film shows a Desk audit receipt, that receipt's hash must
  recompute to an exact match on camera. `TO-FILM-AFTER-PROOF` for the Desk
  version; the miner-level anchor is verified and filmable now. Caveat to
  carry in the narration: the recomputation matched on fast curl re-fetch
  (2026-11-20 ~16:32 UTC) but failed once in the browser the same day
  (15:08 EET digest mismatch) — present the mechanism as verified for fast
  re-fetch, not settled, and note the time-window rule on camera: if the
  upstream moves, re-fetch promptly.

## 1:55–2:20 — 422 fail-closed refusal drill (25s)

- **Visual:** terminal, live, no cuts. Run the wrong-pair request and show
  the `422` with no quote returned.
- **Narration:** "When the input is not supported, there is no answer. No
  invented quote, no fallback number — a refusal, on the record."
- **On-screen text (exact, verified 2026-11-20 16:31 UTC):**
  `curl -i "https://verireceipt.onrender.com/v1/route?pair=BTC%2FUSD"`
  → `HTTP/1.1 422 Unprocessable Entity` +
  `{"error":"invalid_pair","code":"INVALID_PAIR","message":"unsupported
  pair \"BTC/USD\"; only ETH/USDC is supported"}`
- **Gate:** none — verified live. This is the only drill in the film that is
  filmable today. (The `400` malformed-hash drill is likewise verified and
  may be shown as a second refusal if time allows.)

## 2:20–2:40 — Live Epoch leaderboard & /api/miners/<id> (20s)

- **Visual:** `TO-FILM-AFTER-PROOF` — the live Epoch leaderboard for the
  five intents, then `GET /api/miners/774921` showing
  `activation_status: "active"` with matching `miner_address` and `yaml_hash`.
- **Narration (draft, do not record until the gate passes):** "After the
  grace period ends on November 28, the ranked positions are final. [FILL AFTER
  PROOF: the recorded positions per intent, read off the live leaderboard —
  no position is spoken until it is on screen.]" (Nov 28 is blueprint-sourced
  — it is NOT on the official timeline page; verify the date before filming.)
- **On-screen text:** the leaderboard rows and the `/api/miners/774921`
  JSON, as served live.
- **Gate (all must pass before filming):** (1) miner registered (internal target Nov 21 EOD — not an official deadline; the only hard deadline is Dec 1, 23:59 UTC) and `GET /api/miners/774921` returns `activation_status: "active"`;
  (2) grace period ended Nov 28 (per the blueprint — NOT on the official
  timeline page; verify before filming); (3) ranked positions captured from
  the live leaderboard for the epoch shown. No rank, score, or position may
  be claimed before this gate — the miner is currently unregistered.

## 2:40–3:00 — /api/mcp + local run (about a minute cold) + honest limits (20s)

- **Visual:** `TO-FILM-AFTER-PROOF` — `/docs` open, copy the `curl` snippet,
  run it locally; cold, allow about a minute for the receipted answer
  (judge-measured cold 44.7–63.1 s across health/TVL/grid/route on 2026-11-20; varies
  run to run — do not cite any single retry time as a constant; warm, a few seconds).
  Closing card with the honest limits.
- **Narration (draft, do not record until the gate passes):** "No account, no
  key. Copy one command, run it, and the answer comes back with its receipt.
  [FILL AFTER PROOF: the exact command as shown on /docs.]"
- **On-screen text (honest limits, always on the closing card):**
  "Testnet only — Ethereum Sepolia, Test USDC. Desk calls are related-party
  test traffic (same team runs the miner and the Desk). Execution-route
  ranking is judged, not certain. Grid prices vary by epoch."
- **Gate:** `/api/mcp`, `/docs`, and `/llms.txt` all return `200` with no
  login, and the filmed local run completes against the live service — with
  the cold latency stated on camera (about a minute; judge-measured cold 44.7–63.1 s
  on 2026-11-20 — varies run to run),
  never "under 30 seconds". All three returned `404` on Render at 2026-11-20 ~16:32 UTC.

---

## Filming checklist (before any recording session)

- [ ] Miner `774921` registered; `GET /api/miners/774921` → `active`.
- [x] ≥1 settled Mission 13 audit with resolvable `signal_hash` — SATISFIED
      (2 settled, 2026-11-20 17:02–17:03 UTC, all `signal_hash`es resolvable).
- [ ] Desk 1-click preset runs end-to-end (UI not live, re-verified
      2026-11-20 18:19 UTC (20:19 EET)).
- [ ] Desk receipt re-hash recomputes to an exact match on camera (or use
      the verified miner-level TVL anchor and label it as such).
- [ ] `422` drill re-run on camera (verified 2026-11-20; re-check before filming).
- [ ] Leaderboard positions captured post-grace (Nov 28+ per the blueprint —
      NOT on the official timeline page; verify the date before citing it).
- [ ] `/api/mcp` + `/docs` + `/llms.txt` live; local run filmed, cold
      latency stated on camera (about a minute, judge-measured cold 44.7–63.1 s on
      2026-11-20 — varies run to run).
- [ ] No competitor named in narration, on-screen text, or credits.
- [ ] Related-party disclosure spoken or shown once (see submit-checklist.md
      for the verbatim wording).
