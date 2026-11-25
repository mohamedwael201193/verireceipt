# Bounded AIS position event, 25 November 2026

Implementation only. No source adapter, route, manifest, registration or live coverage.

## Sources and recorded observation

- https://openwaters.io/api/ais/ documents anonymous SSE subscriptions, decoded position fields, event timestamps, cached envelope positions on static messages, missing-value sentinels, and synthesized events. No token or signup used.
- https://openwaters.io/ais/ describes coverage and operating limits. This is an aggregator, not independent vessel authentication. Beta availability and uneven coverage must not become global coverage claims.
- https://www.kystverket.no/en/sea-transport-and-ports/ais/access-to-ais-data/ describes public Norwegian AIS, coverage exclusions, and NLOD terms.
- Captured one bounded read from https://ais.openwaters.io/v1/stream?mmsi=257635500&snapshot=1 . Actual BarentsWatch PositionReport event at 2026-11-25T01:44:57.8644366Z, MMSI 257635500, speed 0 knots, course 203.8 degrees, latitude 59.590720000000005, longitude 5.154825. Fixture retains original event fields, attribution, NLOD-2.0 and synthesized=true. Replaying bytes does not independently authenticate upstream authorship or GPS accuracy.

## Scope and binding

Only exact nine-digit ship MMSI with initial digit 2 through 7, source barentswatch, PositionReport IDs 1/2/3, decoded Valid=true and matching decoded/envelope identity. Name and IMO resolution are unsupported. Coordinates, SOG and COG come from the decoded message, not cached GeoJSON. Envelope coordinates must agree. Missing, nonnumeric, out-of-range or AIS sentinel values refuse. Zero speed remains valid; null-island default refuses.

Source event time must be valid UTC, no future time, no older than five minutes. This conservative local limit is not a vendor SLA or protocol mandate. The source may use receive time when its original timestamp is implausible; event time is not guaranteed GPS fix time. Raw VHF reception is not claimed. The captured event is reconstructed from BarentsWatch JSON and says synthesized=true.

A GeoJSON last-seen timestamp is insufficient: cached coordinates can survive newer static or invalid-position messages. Reviewed source revision f4e60f87e19a278893a749c2748ee1ac9b796324 maintains separate position and message clocks, while GeoJSON exposes the message clock. Hence no snapshot-based freshness path.

Terms are recorded, not silently approved. Open Waters documents personal free access and a commercial contact route; source-data terms are per provider, not one blanket licence. This slice preserves the returned credit and NLOD label; it sets no legal/redistribution booleans and makes no licence-compliance claim. No purchase, account or outbound contact.

## Tests and limits

Real captured fixture positive replay plus explicitly synthetic mutation controls, including a changed-count equivalent for numeric extraction (nonzero SOG, changed coordinates and COG), stale/future/invalid-calendar clocks, identity drift, static packets, missing values, source/credit/licence drift, sentinels and boundary freshness. Synthetic controls are not new live observations. A later source adapter must bound stream duration/body/events and close on success/timeout, preserve attribution, handle service limits, and refuse safely. This parser does not establish general query coverage or evaluator success.
