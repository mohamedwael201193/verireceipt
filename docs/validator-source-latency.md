# Validator source latency policy

The handler still waits for every started source that can answer inside the current request budget. A late in-budget dissent remains a conflict. Two agreeing sources are required, and recognized absence still needs two absence votes with no returned validator.

A root-bound source taking at least 3 seconds enters a 60-second slow-source cooldown. This applies to valid slow responses, including an in-budget dissenter, as well as hung calls. It is a general slow-source exclusion policy for later requests, not a claim that a slow source is wrong. An attempt timeout also starts the cooldown.

Ownership spans root resolution, root binding, and the underlying fetch/body workflow until it settles. A caller deadline does not free an unresolved source for another call. After cooldown, a normal probe can recover the source; another slow probe starts the cooldown again.

When fewer than two sources are otherwise eligible, an inactive slow source can be retried to preserve a possible quorum. This never bypasses an active call or a 429 cooldown. Rate-limit and slow cooldowns cannot shorten each other. The optional performance sample budget remains 900 milliseconds.

This is process-local pacing, not a guarantee of a response under a particular latency. A request can still fail closed when current finalized-root or validator quorum is unavailable.

## Retryable error latency and optional enrichment

A root-bound leg ending with a retryable HTTP error after1500ms opens the same60second slow-host cooldown. Successful records retain the3000ms threshold. This affects later request eligibility only. A retryable HTTP attempt that has already consumed1000ms is not retried, including root-bind attempts. Existing quorum, root binding, dissent, absence and wait-for-all rules are unchanged.

Optional epoch balance-delta reads share400ms, skip active or slow-marked required-source hosts, and can be omitted without changing the verified balance verdict, primary receipt evidence or balance answer. The900/400/timeout comparison is test-only; no HTTP query can override the production400ms enrichment budget.

## Finalized-root single flight

Concurrent requests that need a finalized root share one resolution; a joiner waits no longer than its own request deadline and receives only a root that two non-optimistic sources agreed on. A failed or conflicting resolution fails every joiner closed, and the next request starts a fresh one. A root agreed within the last 12 seconds is reused whatever the hosts' cooldown or ownership state; it is never reused at or after 12 seconds, and no last-known root is served as current. Leg-level source rate limits and ownership are unchanged, so a burst of different validators can still lose legs to per-source budgets.
