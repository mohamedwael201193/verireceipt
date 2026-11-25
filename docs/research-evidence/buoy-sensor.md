# Boston buoy sensor parser

Parser only, no network source, implemented cache, route, declaration or registration. Hourly caching is a requirement for a later source, not a claim that this parser caches anything.

## Captured primary sources

- https://www.ndbc.noaa.gov/data/realtime2/44013.txt direct HTTPS200, newest row 2026-11-25T01:00Z, sea surface temperature11.4degC, air5.5degC. Complete recorded table preserved, no reconstructed data. A readable-page fetch held older Nov24 content, so only the direct captured body supplies this fixture.
- https://www.ndbc.noaa.gov/station_page.php?station=44013 direct HTTPS200, title/canonical URL and site metadata bind station44013, Boston16NM east of Boston, coordinates42.346N70.651W and NDBC ownership. Metadata HTML retained.
- https://www.ndbc.noaa.gov/faq/measdes.shtml defines UTC file times, standard header and units, WTMP sea surface temperature, ATMP air temperature, MM missing. Station IDs can be reused for deployments within the same one-degree square, so this identifies a station, not a permanent physical instrument serial.
- https://www.ndbc.noaa.gov/faq/rt_data_access.shtml documents public HTTPS flat files, automated realtime QC and minimal retrieval guidance, most stations hourly. Future adapter must cache by station for at least one hour, preserve original observation age, refuse stale data and bound all reads. This slice has no retrieval loop.

## Honest scope

Only sensor NDBC:44013 and metrics water_temperature/air_temperature. Exact source and metadata URLs, title/canonical/site/coordinates/operator checks. Table has no embedded station ID, so trusted fetch URL/metadata association is necessary; parser cannot authenticate arbitrary caller-supplied table bytes. No claim that metadata proves the measurements originated there. Replayed bytes are not independent authentication.

Exact standard columns and metric units, every data row shape and timestamp validated. Strict descending timestamps, no duplicate newest report. Newest row only; if MM/invalid, never replace with an older valid reading. Observation time stays distinct from fetch and metadata update time. Local conservative90minute observation bound, no future allowance. Temperatures outside-50to60degC refuse. No broad device, rack, weather forecast or datacenter support. Output discloses automated gross-error checks only, not final post-processed quality assurance, subject to revision.

USGS modern sensor API was also checked: it works keyless for occasional probes, but official migration guidance asks an API key beyond a few queries/hour, unsuitable for an unkeyed evaluator-facing source. Latest-per-series responses also mix discontinued and current series, so station-level first-row extraction is unsafe. No key or signup initiated; production candidate parked. https://api.waterdata.usgs.gov/docs/ogcapi/migration/ .

Real replay plus explicitly synthetic mutation controls test exact bindings, units, timestamps, newest-MM refusal, bounds, changed numeric extraction and zero. No new source facts are inferred from test controls.
