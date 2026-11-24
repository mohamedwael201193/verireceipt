# Reserve and metric observability

Parameter-key logs now recognize asset and metric names, never values. Metric route-to-intent logging is registered; it previously emitted no request rows. An empty reserve parameter-key list previously did not prove the asset parameter was absent.

Reserve successful answers log asset_known (boolean), source_kind (por_feed or coverage_only) and numeric_vs_null (numeric or null). Missing asset remains 400. Unsupported asset still returns coverage-only null without a receipt; metadata remains observable without adding a receipt or changing the answer.

Metric success logs metric_kind, leg=quorum and result=value. Refusal logs leg=none, result=refused and a closed refusal_reason. Reasons are deadline, insufficient_providers, hash_mismatch, balance_mismatch, nonce_mismatch, invalid_input or other. Deadline takes precedence; otherwise completed-provider disagreement is categorized in hash, balance, nonce order. This is one aggregate diagnostic, not a complete causal trace or per-provider report. Capacity/unusable upstream evidence is grouped under insufficient_providers.

Metadata lives outside serialized answers/evidence. Only closed enums, booleans and existing opaque receipt IDs are logged. Provider URLs, addresses, assets, balances, nonces and raw errors are not logged. Quorum doctrine, numeric contracts and source selection do not change.
