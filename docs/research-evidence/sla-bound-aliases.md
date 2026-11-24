# SLA status-page bindings and acquisition

24 November2026. Existing arithmetic and shallow-history refusal unchanged.12new bound names: vercel, netlify, discord, dropbox, npm, figma, coinbase, shopify, sentry, mongodb, circleci, snowflake. Privately attached full summary captures identify their exact status-page hosts. Real incident captures supplied separately on the same date cover a30day window under JavaScript ISO date parsing, including mixed UTC offsets. notion and supabase remain unbound because their incident records lacked started_at. Blocked, redirected and other unverified hosts remain excluded.

Alias matching removes only case/whitespace, trailing .com/.io and whole trailing API/status/inc/service/cloud tokens, and requires exact membership. It does not use substring similarity. Exact bound status hostnames and the existing strict statuspage.io tenant shape remain supported. Punctuation near-misses do not become aliases.

Body cache is bounded128entries,5minutes, per exact source URL, with same-URL in-flight coalescing and no failure cache. Source starts are spaced>=1second per host; more than5seconds of queued spacing refuses without a request. Each source body is capped1MB, redirects refused, project SLA User-Agent retained. Existing maximum5incident pages remains. Summary and incident acquisition times persist alongside unchanged bodies; response discloses possible5minute cached age. Oldest acquisition time is not relabelled as fresh.

No upper-bound computation or logging enum included. Existing rule continues to union major/critical incident intervals and refuse incomplete history. Uptime from a shorter covered span is not a mathematical bound on full-window uptime. Any later bound must use known downtime/full requested duration and state its assumptions, with separate wording review.

All behavior tests are offline. Existing arithmetic/route suites isolate the acquisition module; separate cache/pacing controls and12derived-shape handler replays exercise the real acquisition module under a fake clock. No live uptime or evaluator-score claim is made.

Committed fixtures are reduced test shapes, not exact source captures. Unused fields and vendor free text are removed; name/id labels are synthetic, timestamp/status/impact/array shapes retained. Full original summary and incident bodies are private review attachments for independent offline handler replay.
