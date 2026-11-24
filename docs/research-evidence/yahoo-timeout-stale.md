# Yahoo timeout-only stale fallback

24November2026. Shared transport's real source deadline now carries a closed internal timeout marker. A prior validated exact quote/search observation may be served after that timeout only when age is strictly below the existing15minute absolute limit.5minute fresh TTL unchanged. Original body/acquisition/exchange time retained, stale reason names Yahoo source timeout, existing stale answer prefix/verdict/confidence0.5 retained. No time or price extrapolation.

Cold/expired timeout still refuses. Network errors without timeout marker, local capacity/drain/queue refusal,403and invalid successful body remain ineligible. Existing429/5xx policy unchanged. Late responses cannot cache or answer and source slot stays owned until underlying I/O settles; permanent I/O blocks later source starts rather than bypassing concurrency. No retries/new source/live probes.

Offline quote/search controls use real shared transport with abort-ignoring requests, exact body/time checks, subsequent drain-capacity refusal and late-success poisoning check. Actual STOCK handler control verifies stale evidence/receipt time/price/disclosure/confidence. Cold/exact15minute expiry/ordinary-network cases refuse. Tests are in scratch SQLite.
