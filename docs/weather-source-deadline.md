# Weather-check required source budget

All weather-check source reads now share one nine-second budget, including geocoding, station directory expansion and METAR candidate attempts. Fetch and streamed body waits reject even when abort is ignored. Failed source reads retain the existing error mapping; no forecast/model substitute or temperature is invented.

At most four underlying operations per configured origin are admitted, with no queue. Healthy overlap is allowed. Timed-out operations retain their slots until real I/O settlement. Sources are the fixed Open-Meteo geocoder and NOAA aviation-weather origins. Each body is capped at2MB and redirects are refused. Receipt database persistence is outside the source budget.

Existing real METAR fixtures still produce the same station temperature and receipt evidence. Tests cover abort-ignoring fetch/body, all four slots held beyond caller timeout, actual settlement freeing one slot, healthy overlap, slow geocoder consuming all but one second, parseable oversized body and explicit redirect policy. Six mutations are rejected. No change to station selection, ambiguity policy, freshness window, numeric units or observed-versus-modeled doctrine. This is a transport fix, not a demonstrated cause of the rank gap.
