# Live OSRM captures

Retrieved 2026-11-26 with identifying VeriReceipt User-Agent. Bodies are unchanged, not fabricated route observations. These replace unrelated route bodies in named-geocoder integration tests. Static driving estimates only; no traffic information.

- austin-calallen.json: https://router.project-osrm.org/route/v1/driving/-97.7431,30.2672;-97.3961,27.8006?overview=false&steps=false
- springfield-calallen.json: https://router.project-osrm.org/route/v1/driving/-93.29824,37.21533;-97.3961,27.8006?overview=false&steps=false
- dc-calallen.json: https://router.project-osrm.org/route/v1/driving/-77.0365525,38.8976387;-97.3961,27.8006?overview=false&steps=false

The Washington origin is the existing public-building geocoder fixture, not a person/address record. Existing Corpus Christi coastal fixture remains unchanged and accepted with its disclosed 9.7km snap. The endpoint consistency tolerance is an application sanity check (20m absolute or 2% of the reported snap, whichever is larger), not a route authenticity guarantee or a ban on large snaps.
