# Bounded degraded threat screening

24 November2026. Contracts checked live:
- https://devnode.telegraphprotocol.com/engine/v1/intents/THREAT_INTELLIGENCE_INDICATOR : malicious bool, whether reported in threat feeds. No unknown boolean.
- https://devnode.telegraphprotocol.com/engine/v1/intents/URL_SCAN_VERDICT : safe bool, whether URL is safe to visit. No unknown boolean.
- https://devnode.telegraphprotocol.com/engine/v1/intents/URL_SAFE_GENERAL : Safe/Suspicious/Malicious/Unknown enum, detections is number of engines/databases flagging the URL.

These contracts do not require every configured feed. Partial positive evidence can establish a listing, but partial absence cannot establish a clean answer. Policy: at most1 of7 feeds unavailable and at least2 applicable feeds remaining. This threshold is our conservative operational policy, not a contract-specified quorum. Positive listings may return malicious=true, safe=false or Malicious, with exact matched entries and unavailable-feed disclosure. With no listing, THREAT and URL_SCAN still refuse. URL_SAFE returns Unknown and the observed available-feed detection count, explicitly incomplete, never Safe. Two missing feeds or fewer than2 applicable feeds refuse even with positive evidence.

Truncation floors remain. An empty/truncated response is unavailable, not a valid empty feed. No stale substitute or invented count. Complete cache remains6hours; a partial view has60-second cache TTL to avoid persisting outage state for6hours. Every partial response includes missing feeds, screening_complete=false, named available feeds and lower confidence. URL_SAFE names observed-only detections. Target URL is not contacted on a listed or unknown partial result.

Tests replay existing real list excerpts with clearly synthetic source failure/empty-body controls. They do not claim a new live outage capture. The reported historical blocklist.de outage is parent-supplied context, not a reconstructed source body. No new source, manifest or deployment.
