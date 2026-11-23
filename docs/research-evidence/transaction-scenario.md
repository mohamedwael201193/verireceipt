# Transaction-risk input modes

Contract read 2026-11-23: https://devnode.telegraphprotocol.com/engine/v1/intents/TRANSACTION_RISK_GENERAL

The request accepts a transaction hash or details. Complete 64-hex hashes now normalize case and accept an optional 0x prefix. Malformed hash-shaped strings still fail strict validation. Hash-mode RPC quorum, sanctions fetch, score and receipts are unchanged.

Free text uses a separate scenario mode with no network calls. It applies only the existing published weights to narrowly recognized declarative clauses: transaction reverted, contract creation, zero value with zero logs, or an ETH transfer value of at least 100. The heuristic-only cap remains 0.4. Unsupported, conditional, prospective and negated details do not become positive signals. Unsupported prose returns the rubric's zero score with an explicit no-recognized-signals notice, never a safety claim.

Scenario assertions are not evidence of an actual transaction. The response says no RPC lookup or sanctions screening occurred, marks assessment_mode=scenario, sanctions_screened=false, verdict=unverified and confidence=0. The receipt records the exact supplied description, recognized assertions and rubric. Its local source marker is not an upstream URL. The numeric score is a rubric total, not a probability of fraud or loss. No claimed sanctions status in prose can receive the ground-truth sanctions weight.

Two thousand printable characters is the description limit. Storage failure refuses the answer. There is no model, new score table or new external source.

## Validation

32 transaction-risk tests pass, including 22 new input/scenario cases. Combined event and transaction suites pass, 50 tests. Real captured mainnet tx/receipt fixtures exercise uppercase and prefix-free hash normalization. Text scenarios are test descriptions, not fabricated upstream data. Independent receipt digest verification passes. Cap, malformed-hash, large-value threshold and sanctions-disclosure mutants are killed. Build passes.

Known limit: this is a narrow scenario rubric, not a general semantic fraud detector. Unknown descriptions remain explicitly unassessed. Positive sanctions claims require the existing actual-hash source-backed route.
