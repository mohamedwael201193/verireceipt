# Boston buoy sensor route

GET /v1/sensor-telemetry?sensor=NDBC:44013&metric=water_temperature (or air_temperature). Exact station and reviewed metrics only. Missing/unsupported input400before network, stale/MM/source failure502without receipt or fabricated reading. Automated gross-error QC and subject-to-revision scope retained.

Module-level singleton handler owns exactly one source instance shared across requests, both metrics and every server build in this process. It must not be moved into request handler or buildServer: that resets the hourly budget. Multi-process scaling requires shared budget/cache first. Restart resets in-memory cache, not claimed as restart-proof. Source pair attempts hourly even on failure, no periodic/background watch. Original observation/fetch times retained,90min maximum age rechecked.

Terms: false commercial/redistribution booleans, owner's existing23November testnet terms-risk record independently verified on trusted channel, opaque date pointer only. Not licence permission. No deploy or registration. Declaration is separate and must pass third review. Route tests replay original recorded NOAA bytes, not a live-production claim. Two server builds/concurrent metrics and later cache hit prove one source instance; stale and outage paths give502without added receipt or rapid retries.
