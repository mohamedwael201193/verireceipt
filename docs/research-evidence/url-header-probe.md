# Bounded URL header observation

24 November 2026. URL_SCAN retains its existing feed-screening safe value and source fields. An unlisted target may additionally receive a bounded header-only observation. This is not a malware sandbox, page rendering, JavaScript execution or safety clearance. A listed target is not contacted.

Every hop passes the existing public-target guard: all DNS answers must be public; TCP is pinned to a validated address; ordinary TLS hostname/certificate checks remain enabled; credentials, private targets and non-80/443 ports refuse. Up to three response-header observations; request budget four seconds plus at most one bounded two-second DNS resolution already in progress. No page body is consumed. HTTP 403/429 stops immediately. Same-host redirects remain subject to the existing one-target-per-minute limiter, so such a chain is observed but not followed past the first redirect. Probe errors are disclosed and never inflate the safe value.

Exact allowed header values retained: Date, Server, Content-Type, Location, Strict-Transport-Security. Cookie and authentication headers are never retained. The committed capture from https://example.com/ contains those allowed response headers only, with DNS addresses, HTTP status and verified TLS flag. No credentials, authenticated request, challenge bypass or automatic retry used. The pre-existing health probes keep their exact status/latency result shape via a compatibility wrapper.

Tests cover private redirect destinations, mixed public/private DNS, credentials, ports, pacing, redirect cap, TLS failure, HTTP blocks, no body read and cookie-header exclusion. Real allowed header observations replay separately from negative controls. No manifest, registration or deployment change.
