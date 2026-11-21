# Retrospective paid-policy demonstration

This is a read-only report over the canonical Desk ledger. It connects a paid,
re-verified historical answer to an explicit policy rule without rewriting the
purchase or executing a dispatch, trade or allocation.

## Run

```bash
cd desk
npm ci
npm run typecheck
npm test
npm run policy --silent > policy-report.json
```

No key is loaded. No payment challenge is signed. The command only reads local
purchase evidence and public verification endpoints. The ledger is unchanged.
An unavailable endpoint, missing delivery, mismatched identity, bad proof shape
or failed signal/raw-byte verification produces HOLD for a covered rule and a
nonzero process exit. Inspect `evidence_ok` for every row, including rows without
a demo rule. Do not treat a partially verified report as complete.

## Demo rules, version demo-paid-policy-v1

These numbers were chosen **after** the purchases to demonstrate the mechanism.
They are not user instructions, precommitted operating thresholds, official
mission requirements, financial advice or evidence that a real-world action
happened.

| Task | Historical measurement | Illustrative rule | Result labels |
| --- | --- | --- | --- |
| M12 CAISO NP15 / NYISO Zone J | USD per MWh | Price <=100 | RUN, otherwise CURTAIL |
| M13 Aave V3 | Protocol TVL, USD | TVL >=10,000,000,000 | PASS, otherwise HOLD |

Invalid/nonfinite values and failed verification always HOLD for covered tasks.
Negative grid prices are valid market data. Negative TVL is not valid.
The M13 rule is only a TVL screen, not a complete asset-management decision.
TX, filing, route and validator purchases are re-verified but marked
NOT_APPLICABLE because this policy defines no rule for them.

## Evidence and limits

Each report records its generation time, policy version and thresholds, exact
ledger SHA-256, paid amount, purchase time, receipt hash, signal hash, miner
receipt id, actual re-derived numeric value, rule, outcome and public inspection
URLs. It uses the existing live signal/raw-byte verifier and ledger consistency
checks, exact included delivery identity/epoch and proof shape. It does not
independently walk a Merkle tree. The paid response's receipt-to-signal binding
cannot be fully re-derived from public endpoints.

Re-verifying old bytes now does not make their data current. RUN and PASS mean
only that the historical measurement satisfies this illustrative rule. They
must never trigger current dispatch, trading or allocation. Every purchase is
related-party/direct testnet activity, not independent adoption or evidence of
rank-selected routing. No full Mission12/13 completion or judged score is
claimed.
