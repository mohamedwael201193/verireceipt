# Dated flight-level source, November 26, 2026

Primary source: FlightStats direct public flight-tracker page. No browser, script execution, authentication, API key or block bypass. One page request per status attempt. Uses only the literal JSON substring assigned to __NEXT_DATA__. Receipt stores the exact substring plus the SHA-256 of the downloaded page. Full HTML is not committed because third-party page scripts can contain credentials; fixtures keep only the source data needed to replay parsing.

Real probes returned HTTP200 for AA100, BA117 and MS985. AA100 was Departed, On time, provider delay0; BA117 was Arrived, Delayed by1h45m, provider delay105; MS985 was Arrived, Delayed by52m, provider delay52. All are source-selected departure occurrences on November25, with exact UTC schedule dates disclosed. AA100's projected arrival is November26. No user-supplied departure date is inferred.

Parser binds query carrier/flight, ticket identity, result identity, origin/destination and actual scheduled UTC dates. Schedule timestamps require exact real UTC ISO calendar roundtrips, no Date.parse normalization. Recent/current window: departure within48h past or36h future, arrival within24h past or60h future. Nonfinal status requires an explicit source update age of at most60minutes. Final flight exemption requires consistent terminal fields: Arrived/L with both landed flags; Canceled/C with canceled flag; or Diverted/D with diverted flag. A final flag alone never bypasses update-age validation. Final flight status remains historical, within the recent schedule window. Provider classification (delayed, canceled/cancelled, diverted, or explicit On time) is used as stated, not inferred from airport conditions or thresholded timestamp arithmetic. Unknown classification is unverified, never false. Delay minutes are provider-classified delay, not guessed from departure/arrival differences.

Cache capacity64, TTL60seconds, identity includes request flight URL and current UTC day. Source-selected departure day remains explicit in the cached observation and is revalidated on reuse. This is not a day-long status cache. Shared source starts30/minute, maximum4 active underlying reads.3s abort plus3.1s hard caller bound; abort-ignoring I/O retains active ownership.403/429 triggers a5minute FlightStats cooldown, no retry or alternate host bypass.

If no primary record resolves, the public adsbdb callsign database is tried once. IATA and ICAO identifiers supported; returned callsign must match exactly. Unknown string responses remain unresolved. For an ICAO identifier, an exact returned IATA mapping can select the one FlightStats URL. This is an undated route database claim, never a dated itinerary. Any US endpoint is checked with the existing FAA NAS airport adapter. Airport conditions appear only in airport_disrupted, airport_delay_minutes, airport_reason and airport_statuses; disrupted remains null. The parent receipt retains the route body plus the subordinate FAA receipt reference. No absence of airport evidence becomes a normal flight verdict. Subordinate FAA receipt persistence failure propagates rather than being swallowed by the optional fallback.

Caller-supplied flight-plus-airport routes now also preserve the distinction: flight disrupted is null, while airport_disrupted reports the existing airport evidence. Airport-only inputs retain existing behavior.

Sources:
- https://www.flightstats.com/v2/flight-tracker/AA/100
- https://www.flightstats.com/v2/flight-tracker/BA/117
- https://www.flightstats.com/v2/flight-tracker/MS/985
- https://www.adsbdb.com/
- https://api.adsbdb.com/v0/callsign/AAL100
- https://api.adsbdb.com/v0/callsign/BAW117
- https://api.adsbdb.com/v0/callsign/MS985
- https://nasstatus.faa.gov/api/airport-status-information
- https://devnode.telegraphprotocol.com/engine/v1/intents/TRAVEL_DISRUPTION_GENERAL

Production-host outbound accessibility has not yet been proven by a deployed request. Local direct HTTP success is not a promise that the service will allow the production host. If blocked in production, the handler discloses it and does not bypass it.
