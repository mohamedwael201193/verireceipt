# Bounded AIS adapter and receipt factory

Implementation only, no default approval, source wiring, HTTP route, declaration or registration. Builds on the reviewed position parser and its real captured event. The capture is replay evidence, not independent upstream authentication.

The adapter reads a single fixed-host HTTPS SSE stream by exact nine-digit ship MMSI and snapshot=1. It stops at the first supported decoded PositionReport, retains its exact JSON data field as raw evidence, then cancels and aborts the stream. Static/welcome frames never supply position facts. It refuses source error frames, malformed JSON/UTF-8, redirects, HTTP failures, wrong content type, absent/ended bodies, invalid events, excessive bytes and excessive data frames. No URL from a request is fetched. No retries or second-source averaging.

Limits: 2.5-second complete adapter deadline, 64KiB received bytes, 32data frames; parser32KiB event maximum remains. Outer observation runner3-second budget prevents a late receipt even if fetch ignores abort. Abort signals, reader cancellation, timer/listener cleanup and a late response body cancellation are covered. No ongoing subscription or repeated polling is started.

Handler factory takes reviewed SourceApproval configuration, not user input. There is no default grant and no licence booleans are set here. Tests use an explicitly synthetic risk-acceptance configuration. Production wiring requires verified owner authority and truthful terms recording, separately reviewed. Existing shared runner persists the observation envelope, exact raw event, timestamp, attribution, licence, synthesized disclosure and reviewed terms. Receipt hash covers exactly the stored evidence string. Storage failure propagates once without a second receipt.

Canonical fields: vessel, speed_knots, latitude, longitude, course_deg, observed_at. Extra disclosures use ais_source and observation_scope because source is reserved by the receipt envelope. Answer retains actual attribution and synthesized status. Five-minute source event age remains a local conservative limit, not guaranteed GPS fix freshness or a provider SLA. Not for navigation, no name/IMO resolution, no general/global coverage assertion.

Tests replay the recorded source event. Stream wrappers and failure/control payloads are synthetic, not new live observations. Sibling observation-runner, NOAA/weather and Aave persistence/deadline tests run alongside the vessel tests. No generic runner changes in this slice.
