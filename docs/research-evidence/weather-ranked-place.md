# Weather provider-ranked place resolution

24 November2026. WEATHER_FORECAST_GENERAL requires city/place names and1..240 hours. Bare Cairo and Tokyo live geocoder results produced multiple same-name matches, which the prior forecast handler refused. This is a reproducible acceptance gap, not a proven explanation for any historical score.

Use existing parseRankedLocation validation, as storm-alert does. Select provider rank1, disclose the chosen label/coordinates, count and lack of confirmed uniqueness. Country-qualified retry still filters by that country before rank1 selection. Invalid top coordinates, malformed results and empty matches remain refusals. Coordinates bypass geocoding. Existing forecast window/model aggregation is unchanged. Place input validation now follows the256 UTF8-byte transport slot instead of an extra200-character limit.

Receipt evidence includes original geocoder body as well as its existing digest and explicit selection policy. Existing recorded Cairo captures replay the successful forecast; no invented source capture or forecast. CODE_PATCH handler and manifest unchanged. No new endpoint or deployment.
