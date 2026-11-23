# Storm place-name ranking, 2026-11-24

This small slice replaces strict ambiguity refusal with the same provider-order
selection rule reviewed for ROUTE_ETA: select the first Open-Meteo result and
state its label, coordinates, returned result count, rank 1 and that uniqueness
is unconfirmed. The accepted actual Springfield capture is replayed unchanged.
Malformed top results refuse, even if a later row is valid. Empty results still
refuse. No Photon fallback or new geocoder calls are added. Exact raw geocoder
bytes are included in the receipt, with their SHA-256 and selection description.

All NWS coverage, risk scoring, window semantics and null gust/precipitation
fields remain unchanged in this slice. Global forecast coverage and weather-risk
policy require separate source/contract review. No scoring benefit is claimed.

Geocoder source terms remain those reviewed on 2026-11-24 for the existing
Open-Meteo use: https://open-meteo.com/en/terms . Data attribution is Open-Meteo /
GeoNames, CC BY 4.0. The free endpoint does not grant commercial use; data licence
and endpoint eligibility are distinct. Existing request volume is unchanged.
