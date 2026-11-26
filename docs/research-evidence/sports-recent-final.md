# Most recent completed official pair game

Only when no ISO/relative date is specified, exactly two public MLB or NHL team identities resolve uniquely to one league, and the existing today/yesterday window has no matching game, consult the official schedule. MLB searches200UTC calendar dates including today; NHL searches60. NHL fetches at most two season schedules if the window crosses July. Local filtering enforces both exact team IDs, names bound to the public league identity snapshot, actual valid source date in range, Final status and integer nonnegative scores. Select latest actual source date/start time, then game ID. No date is invented or opponent substituted. Explicit dates and existing single-team lookup remain unchanged.

Answers disclose Most recent completed game, the bounded dates, and not live or today's score. Source bytes and URLs are receipt evidence. Empty bounded schedules yield null not_found, not zero. Schedule errors do not prove not_found. Added schedule reads reject at3seconds including headers/body with4MB streaming cap and redirect refusal. No blocked provider route is used.

Real unedited fixtures checked26November2026:
- https://statsapi.mlb.com/api/v1/teams?sportId=1&season=2026 , public team IDs/names used to derive the fixed MLB registry.
- https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=147&startDate=2026-05-10&endDate=2026-11-26&hydrate=linescore , Yankees schedule. Local200day test window startsMay11, soMay10 records cannot pass.
- https://api-web.nhle.com/v1/club-schedule-season/NYR/20262027 , official NHL season games, full32-team identity projection and recent Final fixture.
- https://api-web.nhle.com/v1/club-schedule-season/NYR/20252026 , prior season retained for boundary review.

No claim that the unknown graded phrase is reproduced. This fixes the structural offseason coverage gap for unambiguous two-team questions. No source-derived date or score is modified in retained fixtures.

Review correction: validate every MLB dates/games container and team-ID candidate shape before absence. Malformed relevant dates, status fields, identities or Final scores throw source unavailable, not not_found. Whole-phrase alias spans are matched longest-first across both leagues, require exactly two mentions, and reject extra matchup separators, including repeated teams. Ambiguous third-team input never invokes history or produces a score.
