# Route endpoint selection, 2026-11-24

This change explicitly reverses ROUTE_ETA's old strict ambiguity refusal.
For city/place text, the first result in Open-Meteo's returned order is used,
not a fabricated confidence winner. Every answer and receipt says which place
was chosen, the number of matches returned (up to ten, not the global total),
rank 1/provider order, that uniqueness is not confirmed, and exact coordinates.
Coordinate inputs bypass geocoding. Malformed coordinate-like values and
out-of-range coordinates return 400, never a remote place-name search.

A successful empty Open-Meteo result can fall through to Photon for a free-form
street/place search. A provider failure, invalid top result or refusal never
triggers that fallback. Photon likewise uses its first result with the returned
count and full coordinates disclosed. Only empty results from both sources
return 422 PLACE_NOT_FOUND. OSRM can still independently return NO_ROUTE or
NO_USABLE_ROUTE. Source failures are 502. Missing inputs are 400.

The source terms were read in full:
- https://photon.komoot.io/ (complete Terms of Use section)
- https://www.openstreetmap.org/copyright
- https://opendatacommons.org/licenses/odbl/1-0/
- https://open-meteo.com/en/terms

Photon explicitly permits project API use subject to fair use. Extensive use
may be throttled, with no service guarantee and terms subject to change. There
is no claimed numeric entitlement. The application adds conservative limits:
at most 100 distinct upstream geocoding reads per rolling day per process,
at least 1100ms between starts, bounded queueing, a one-day/1000-key exact-body
cache, and same-key coalescing. These caps are safeguards, not a promise that
the operator will regard every such workload as fair. Transport errors halt
further reads until process restart. No alternate host, proxy or retry bypass.
Abort at 3s plus hard response deadline at 3.1s; redirects refused and body size
bounded. This is process-local: multiple workers sharing one application must
share a limiter/cache or restrict geocoding reads to one worker. Restarts reset
the in-memory budget/cache/halt. This must be considered before scaling.

Open-Meteo's existing free-service noncommercial restriction is inherited,
not removed or recast as commercial permission. The existing project source-risk
decision is not a new source licence. This slice adds no payment or subscription.
It does not call the public Nominatim service or set up an instance.

Answers/evidence attribute Open-Meteo/GeoNames and Photon/OpenStreetMap with
ODbL copyright/licence URLs. The geocoding source captures and derived geocoder
fields are offered under ODbL 1.0 with attribution; application code remains
under the repository licence. ODbL share-alike applies to any derivative OSM
geocoding database, not to independent code or the separate OSRM result. Raw
captures, transformation code and acquisition times remain available in the
receipt and public source. This implementation does not claim ownership of OSM
source data or strip source notices.

Real captures include ten returned Springfield matches, a public White House
street query with an empty city response and ranked Photon results, and an
empty Photon control. Metadata records exact URLs, HTTP statuses and times.
Route integration tests replay a separately captured OSRM body to inspect
field/evidence mapping. They do not claim that this separate route is an actual
White House route. The ETA remains OSRM's static car-profile estimate, without
live traffic or closures, and snapped waypoints remain explicit.
