# Macro observation cache and deadline

Trade, trade openness and trade share of GDP resolve to NE.TRD.GNFS.ZS. The answer states exports plus imports of goods and services as a percentage of GDP. Series metadata and observation bytes are the existing captured fixtures in tests/fixtures/macro-series, not new measurements.

The process-local cache uses the full fixed upstream URL, binding country, series and requested-year/latest selector. Only selected finite numeric observations enter it. Fresh TTL is15minutes, absolute stale limit24hours, maximum128entries. No prewarm, disk cache, startup calls or background polling. Null/no-data responses remain no-data and never replace a good entry. Malformed responses can fall back to a prior good entry but never enter cache. Process restart loses the cache.

A stale fallback names its observation year, original acquisition time and acquisition age in seconds in the answer. It carries stale=true, verdict=stale and confidence0.5. Exact raw bytes and original receipt fetched_at remain unchanged. Fresh cache hits preserve acquisition timestamps too; checked_at remains the current response time. Every answer still requires successful evidence persistence.

Source work shares20seconds from handler entry, including country catalog acquisition. Each indicator attempt has an18second rejecting deadline clipped to that remainder, including full body reads. There is at most one retry after200ms if more than250ms remains. No retry on429or other4xx. The existing country catalog TTL remains1hour, with a12second read ceiling clipped to the same deadline. Eight underlying URL-owned reads may exist, including ones that ignore abort. No request retries a URL that still has an unresolved owner. Non-OK response bodies are cancelled, and ownership is retained until cancellation settles, even when cancellation ignores abort. Late completion never enters observation cache. Cache and ownership are per process, not shared across workers. Database persistence and event-loop stalls are outside the source-work budget.

## Platform deadline evidence and limitation

Checked25November2026:

- https://devnode.telegraphprotocol.com/engine/v1/intents/MACRO_ECONOMIC_INDICATOR_GENERAL has no timeout field. It describes the judgment family, indicator request and scored rate_pct field.
- https://github.com/telegraphprotocol/telegraph-docs/blob/main/miners/validation-api.md says the endpoint sandbox uses30seconds on the default node configuration. This is sandbox evidence, not proof of the daemon evaluator deadline.
- https://github.com/telegraphprotocol/telegraph-docs/blob/main/using/engine-ask.md documents a60second overall default ask deadline and caller overrides from2to60seconds. A shorter caller deadline can still expire before a cold answer.

The docs checkout was9753e972af5368a5c6e41848248b96df199aa3b2. The20second source budget is below these default public limits but is not asserted to satisfy an independently verified production evaluator timeout. No paid probe, deploy, registration or transaction was made for this slice. No score gain is claimed.

Tests use recorded real observation bytes and synthetic faults/clocks. Cross-country/series/year selector requests in isolation tests exercise key identity, not simulated published data for those requests. Real fixture replay remains the unit/series control. Controls cover cache-hit silence, stale disclosure and original bytes/time, absent/null cache refusal, expired stale refusal, malformed data, retries, cumulative catalog-plus-source deadline, abort-ignoring ownership/capacity and alias mapping. Existing persistence suites replay the added fetched_at and stale=false fields explicitly.

V2 adds129validated distinct-key eviction/refetch coverage and an error-body cancellation ownership regression, with separate eviction-removal and cancellation-removal mutants.

V3 preserves the original HTTP status retry classification when error-body cancellation rejects. Explicit429cancel-rejection refuses after one fetch;500cancel-rejection retries at most once. Both controls have isolated RED mutants; hung cancellation still retains ownership.
