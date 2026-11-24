# Shared Yahoo acquisition

24November2026. Existing chart/search URLs only. One shared workflow for STOCK and FINANCIAL chart/search, >=1second between starts, FIFO16waiting callers,12second caller budget including queue/spacing, at most5seconds source fetch+body. Both routes use one project equity-observer UA and identical transport. No source retries, redirects, host/UA rotation or challenge workaround.429 cooldown is still shared and checked before queue, on slot acquisition and after spacing. Cache-first access still occurs before transport.

Real rejecting timeout,1MB streamed cap, no accepted late body. Abort-ignoring I/O keeps source ownership until actual settlement; new work refuses while draining and queued callers expire. Local capacity does not trigger the old server-error stale path. Existing actual429/5xx cache fallback remains5minute fresh/15minute absolute maximum. No timeout stale fallback, no new source, no live probe.

Existing stock/search cache contract tests isolate transport to avoid fake-clock deadlocks; dedicated transport tests exercise real pacing, bounds, cooldown, permanent body reads and actual STOCK late-response cache safety. Full STOCK/FINANCIAL suites still exercise their normal acquisition paths. Source deadlines are now route-independent,5seconds, rather than inheriting FINANCIAL10seconds when it wins coalescing.
