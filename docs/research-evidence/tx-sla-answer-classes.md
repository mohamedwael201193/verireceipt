# Transaction and SLA answer diagnostics

24November2026. Process-local response metadata only, no JSON/evidence field changes. Sanitization occurs on attachment and logging, fails open without changing answers.

ONCHAIN_TX_LOOKUP_GENERAL: status is confirmed/reverted/pending/not_found; chain is the handler's7supported canonical names only. quorum_votes is an integer0..3, derived from the internal winning-vote label, never the label or source URLs. retry_used records whether either one-repoll path ran. No transaction hash/address/error text retained.

SLA_COMPLIANCE_GENERAL: service_bound boolean and closed-map alias name, none when outside named map. Existing directly accepted statuspage tenants stay alias none. Exact covered result records window_covered=true; unavailable/unknown window omits it. No lower/upper bound is implemented in this slice. No service/period text or URLs retained.

Offline tests cover sanitization, actual TX initial/retry paths, unbound SLA HTTP logging, bound SLA handler metadata, persistence siblings and focused TX unit helpers. The longer pre-existing offline TX matrix did not finish within execution budget; no full-matrix pass claimed.
