# Yield health attribution fix

Bookkeeping only, no answer/status/receipt semantics changed. Success from yield receipt records aave-v3-evm-rpc at receipt fetched_at instead of generic host-derived evm-rpc. Other intent receipts keep existing host mapping. Missing/STALE DISCLOSED receipt cannot mark OK.

Yield route records failures only for exactly one reviewed reserve binding under the same input normalization as its source. Missing/unsupported inputs keep existing400/502behavior and do not create upstream outage evidence because no RPC request was made. Supported upstream outage still records APPROVED_SOURCES_UNAVAILABLE. No source failures suppressed for valid bindings. Existing registry last_err remains historical; a later last_ok does not erase it. No generic error messages/private inputs logged.

Regression tests cover unbound project/asset/chain and missing parameter, supported outage, actual captured safe-head receipt success, unchanged generic receipt mapping and stale receipt exclusion. Existing server/finance/Aave/mapping/diagnostic siblings run. Health artifact alone was not proof of a current Aave outage; fresh direct supported-query validation is still required for deployment readiness. No deploy or registration.
