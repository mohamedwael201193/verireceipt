# Optional validator performance sample strictness

24 November 2026. Existing optional balance-delta enrichment uses two sources at two finalized slots, not an attestation effectiveness percentage. It is omitted when sources cannot supply the historical states. Verified validator balance/status answer remains independent.

Header and balance samples must now explicitly report execution_optimistic=false, and the header must explicitly report finalized=true. Missing flags are not evidence of finality. Sample balances use the same uint64 bound as the verified validator parser; an arbitrarily large digit string is not a usable beacon balance.

Negative mutations extend the independent beacon stub tests, not evaluator examples or invented source captures. Missing/false finality, missing optimistic flags and uint64 overflow omit only the optional enrichment and preserve the independently verified base answer. No metric, source coverage, manifest, registration or deployment change.
