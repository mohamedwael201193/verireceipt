# Evidence-bound fraud screening

Contract: https://devnode.telegraphprotocol.com/engine/v1/intents/FRAUD_DETECTION_GENERAL

Endpoint: `/v1/fraud-detection?subject=...`. This implementation does not declare the intent in miner.yaml or change registration. Those steps require separate manifest and registration review.

Supported source reads:

- Exact EVM address: complete OFAC SDN Digital Currency Address entries. An exact match returns SUSPICIOUS, not FRAUD. Its score 1 reuses the existing sanctions-exposure rubric weight, expressly not a fraud probability. Non-match is INCONCLUSIVE with null score, not legitimate or zero risk.
- IPv4/domain/URL: the existing complete threat-feed loader and exact matching rules. A match returns SUSPICIOUS; absence is INCONCLUSIVE, never clearance. The score is null because these lists do not measure fraud probability. Feeds retain their existing truncation floors and six-hour cache. Earliest source acquisition time is retained. The input URL itself is never fetched.
- Unsupported prose: INCONCLUSIVE, null score, no external lookup. Claims of fraud or sanctions inside a description do not establish either fact.

All results label assessment_status=unverified and confidence=0. Screening membership cannot prove a fraudulent act or legitimacy. Receipt evidence includes exact OFAC bytes or threat-feed hashes, timestamps and matching entries. Unsupported prose retains its supplied subject and lack-of-evidence notice.

## Sources and capture

https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV

Captured 2026-11-23 around 21:23 UTC, HTTP 200 after the official export redirect, 5,855,269 bytes and 100 crypto-address entries. The full body is committed as a real fixture. No signed redirect URL or temporary token is retained. OFAC fetch is capped at 12 MB / 8 seconds and refuses fewer than 50 extracted address entries.

Existing threat-feed sources and their full-load floors remain unchanged. No authority is inferred from repository comments. This is a source-bound implementation, not a general semantic fraud detector.

52 fraud/transaction/threat tests pass, including actual positive and negative source controls, hash recomputation, exact bytes, incomplete/degraded sources, prose uncertainty and storage failure. Four mutants are killed: always-listed, negative-to-legitimate, invented zero probability and missing floor. Build passes. No manifest, registration, deployment or signing change.
