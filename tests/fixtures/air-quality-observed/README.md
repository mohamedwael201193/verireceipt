# London AQI source evidence

Retrieved2026-11-26. london-model.json is an exact Open-Meteo/CAMS model response, not station data:
https://air-quality-api.open-meteo.com/v1/air-quality?latitude=51.5074&longitude=-0.1278&current=us_aqi,european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone&timezone=UTC

london-sensors.json is transformed evidence from the documented preferred box endpoint:
https://data.sensor.community/airrohr/v1/filter/box=51.417467,-0.272292,51.597333,0.016692
Only the selected outdoor sensor id/type, distance-provenance coordinates, timestamp and PM readings are retained. Provenance file records original source body hash and counts. Other sensors and indoor locations were discarded. Source coordinates can be personal data; publication is minimized to the necessary selected-sensor provenance. No owner identifiers are added.

Sensor.Community contributors, DbCL1.0. API documentation: https://github.com/opendata-stuttgart/meta/wiki/APIs . PM EPA2024 breakpoints: https://aqs.epa.gov/aqsweb/documents/codetables/aqi%5Fbreakpoints.html . Snapshot conversion is an indicative PM-only equivalent, not24-hour AQI or NowCast. Perturbations in tests are named controls, not claimed observations. Credential-pattern scan has zero hits.
