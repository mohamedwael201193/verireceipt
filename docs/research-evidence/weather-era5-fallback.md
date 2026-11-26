# Past-day weather fallback

Primary NOAA NCEI remains a measured station archive. If unavailable, ineligible, or explicitly empty, Open-Meteo ERA5 daily reanalysis is tried for the same reviewed geographic binding and requested past date. There is no source averaging, field-level merging or cross-source consensus claim. A healthy NOAA record stops fallback.

ERA5 is a model-assisted reanalysis dataset, not an independent measured-station record. The fallback answer, source label, source_method, grid coordinates, UTC reporting period and evidence say so. station and station_name are null on reanalysis answers. Model is explicitly era5, not provider best-match. Daily temperature units must be Celsius, precipitation mm, timezone GMT, exactly one matching date. Returned grid coordinates must be within0.3degrees of the reviewed point. Any partial null, wrong units/date/location or malformed payload fails, never becomes an empty-record claim.

Null measures/no_record are returned only after both configured sources explicitly return no record. Transport, gate, validation and timeout failures do not prove no data. Receipt save failures propagate without another source/receipt. Default weather source deadline remains3seconds per source, maximum6seconds across the two legs. Unbound places still refuse; this does not add name/geocoder inference. Current weather is unchanged. Future dates remain400.

Coordinate bindings are the latitude/longitude of the already-reviewed NOAA GHCN stations, not new private user locations. Verified against https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt . Reanalysis grid can differ from the requested point. It is disclosed and not called that station's measurement.

Sources checked26November2026:
- https://open-meteo.com/en/docs/historical-weather-api , ERA5 reanalysis, daily aggregation, units and grid semantics.
- https://open-meteo.com/en/terms , rights not asserted; owner-approved source policy supplies scoped testnet risk acceptance. No payment, access block bypass or claim of a commercial licence.
- https://archive-api.open-meteo.com/v1/archive?latitude=30.08&longitude=31.29&start_date=2026-11-01&end_date=2026-11-01&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=GMT&temperature_unit=celsius&precipitation_unit=mm&models=era5 , retained exact Cairo fixture, max29.4C/min16.6C/precipitation0mm.

Bounded answer_class logs source attempt count0..2, gate eligibility and value/no_record/unavailable/gate. No location, date, raw provider text or numeric weather value enters those categories.
