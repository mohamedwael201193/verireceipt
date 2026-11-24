# Independent MLB final fallback

Only starts after every covered ESPN scoreboard fails, never after a primary success or partial no-match. This is MLB-only coverage, not restored NFL/NBA/NHL coverage. No alternate ESPN host, authentication workaround or proxy.

The fixed MLB-owned endpoint is https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-24 . The retained fixture was downloaded directly with HTTP200 on 2026-11-24 and independently inspected. It carries officialDate 2026-10-24, Milwaukee Brewers 5, Tampa Bay Rays 4, official final status and consistent winner flags. Date is MLB officialDate, not UTC start date.

Exact requested official date and unique matching teams are required. Doubleheaders are refused rather than picked by finality. Four final-state fields, integer scores, game ID, tie flag and both winner flags must agree. The actual raw source string is receipted unchanged. No partial or coverage-only scored response. A source or persistence failure cannot create a verified result.

The existing 6-second network response budget is preserved. MLB gets at most1500ms and only the primary budget remainder. Primary timeouts start no new source. A rejecting deadline covers headers and body even when I/O ignores abort, and late work cannot persist. A process-local 20-start/minute guard never queues requests.

Terms: https://gdx.mlb.com/components/copyright.txt limits use to individual non-commercial/non-bulk use absent permission. This testnet implementation uses the owner's standing terms-risk waiver dated 2026-11-23, not a provider licence or a claim of redistribution rights. NBA and NHL ordinary direct probes returned403 and were not retried or bypassed. NFL has no freshly verified independent source in this change.
