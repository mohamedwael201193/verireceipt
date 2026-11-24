# Explicit-date measured weather readiness

24 November 2026. Contract https://devnode.telegraphprotocol.com/engine/v1/intents/WEATHER_FORECAST_VERIFY_GENERAL requests a past date and recorded high/low/precipitation. A model or reanalysis is not a substitute for recorded station data.

Three real NOAA NCEI daily-summaries requests for 2026-11-01 were captured with exact source URLs and bytes in tests/fixtures/weather-history/source-capture.json. Cairo Abbassia and Heathrow returned empty arrays. JFK returned a quality-accepted measured record: 14.4 C high, 5.6 C low, 0.0 mm precipitation. Empty arrays refuse rather than turning into zero or a forecast fallback. Existing five exact station bindings remain unchanged; this slice does not claim broad city coverage.

The archive source deadline is now three seconds instead of 900ms. The bounded source body reader already honors cancellation. A 1200ms deterministic replay of the real JFK body succeeds and preserves its exact bytes in the receipt. A hung archive read aborts at the total deadline and cannot persist an observation.

No manifest, registration or deployment change. Current-weather deadline unchanged. Station climate-day, trace-precipitation, quality and missing-condition disclosures unchanged.
