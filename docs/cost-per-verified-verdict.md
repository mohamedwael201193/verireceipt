# Cost per verified correct verdict

Status: self-hosted local CLI, Ethereum Sepolia testnet only. No production
earnings are claimed or implied; every purchase is test USDC.

## What it is

The model-economy harness (hackathon mission issue #198, Route 1) answers a
procurement question with paid evidence instead of static benchmarks: what
does a verified correct verdict cost, per provider, right now?

The customer is a model host or coding-agent developer choosing an
evaluation provider. Today they pick on published benchmarks or token
price; neither measures cost per correct, demonstrably completed result on
their own tasks. The harness runs a fixed, disclosed evaluation set across
the supported providers of `LLM_OUTPUT_EVALUATION_GENERAL`, verifies every
purchase end to end, checks each returned rating against the disclosed key
with an exact comparator, and reports spend and cost per verified correct
verdict per provider, with receipts.

## What the numbers mean (read before quoting them)

- The set is 6 synthetic cases (3 keyed pass, 3 keyed fail), each run once.
  There is no statistical significance.
- The keys are the author's judgement, not ground truth; every case carries
  its rationale in `desk/eval/cases.json`.
- The harness measures how an evaluator's rating matches those keys. It
  does not measure whether the provider is a good answering model.
- "Verified" means delivery and receipt integrity (the paid answer
  re-derives from the on-chain signal and the stored evidence bytes, and
  the signal's recorded request params are exactly the `{task, output}`
  sent). "Correct" means the rating matches the key band.
- Ratings are not repeated; one noisy run can move a ranking.
- `cost_per_correct_uusdc` is in micro-USDC, truncated to 2 decimals.
- `spend_uusdc` is recorded receipts only. `reserved_uusdc` is the
  journaled reservation total; a reservation stands even when its call
  fails, so reserved can exceed spend.
- A `skipped-budget` case was not run (the shared daily cap refused the
  purchase) and is excluded from every comparison.

## Method

The case set (`desk/eval/cases.json`) is fixed and disclosed: self-contained
(task, output) pairs, including a wrong answer, a partial answer, an honest
"cannot be determined" on an unanswerable task (unknown is not incorrect)
and a fabricated answer on the same task. Keys are bands over the published
rating enum: pass is Excellent/Good/Acceptable, fail is Poor/Fails. The
comparator is exact set membership; there is no judge model and no float
scoring on our side.

For every provider x case the harness buys one escrow call (flat 10,000
micro-USDC), reserving the quote in the shared spend journal under the file
lock before anything is signed, so the run joins the same cross-agent daily
cap as the desk, gate, benchmark and heartbeat. The CLI refuses before any
spend when providers x cases x unit price exceeds the remaining cap, and
prints the numbers. Under the default 100,000 micro-USDC shared cap the
pre-flight allows at most 10 calls, so one provider (6 cases = 60,000
micro-USDC) per UTC day; a multi-provider comparison needs a raised cap
(DESK_EVAL_CAP_UUSDC, bounded above by the desk-wide 2,000,000 micro-USDC
daily cap) or several days, and other desk spend that day reduces what is
available. The paid answer is verified end to end
(`verifyPurchase`: signal hash, stored delivery bytes, receipt binding,
field reconciliation) and bound to the question: the signal's recorded
request params must equal the `{task, output}` sent (compared key-order
independently; extra or missing keys fail), else the case is
`failed-verification`. Only a verified, in-enum rating is classified. A
missing or non-enum rating is `unusable`, the unknown bucket, and is never
counted as incorrect. Failed payments and failed verifications are recorded
with their receipts; a charge that stands is reported as spend.

## What the report contains

Per provider: cases run, correct, incorrect, unusable, failed payment,
failed verification, skipped budget, spend, reserved total, and cost per
verified correct verdict (null when there were none). The report
(`eval-report.json`, mode 0600) carries this disclosure block, every
verdict with its rating, key, per-call latency in milliseconds and
receipts, plus the total spend and reserved figures. It derives no further
statistics.

## Failure cases

Wrong verdict (rated against the key), partial answer, fabricated answer on
an unanswerable task, unusable answer (missing or off-enum rating), failed
payment, failed end-to-end verification with the charge standing, and
budget exhaustion (the run refuses to sign past the shared daily cap and
records the cases it did not run). Each is a tested path.

## What it never does

No mainnet, no real-money spend, no production earnings claims, no judge
model grading judges, no acting on the results, no serving an unverified or
unverifiable verdict as evidence.
