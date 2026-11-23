# Route estimate source-value validation

24 November 2026. Existing OSRM capture in tests/fixtures/route-eta/osrm-corpus-to-calallen.json is retained unchanged. Source remains router.project-osrm.org, single-source static driving model without live traffic or closure information.

Duration no longer clamps out-of-contract source values into plausible answers. A source duration below one second or above one million seconds refuses. Null, blank, boolean or string numeric values are not real numeric observations. Distance and both snapped waypoint coordinates/distances must be finite numbers with valid coordinate/range checks. Large valid snap distances remain disclosed, not silently treated as exact endpoints.

Named-endpoint evidence now retains the exact geocoder response bodies beside their SHA256 hashes, allowing source reconstruction. No additional geocoder request is added. Tests use the real route body, with explicitly negative mutations for invalid fields. Place-name timing, geographic coverage and model scope are unchanged. No manifest, registration or deployment change.
