# Storm global forecast window, 2026-11-24

Recorded registry contract version 1: location string, window_hours integer 1..240;
risk_score [0,1], risk_level LOW/MODERATE/HIGH/SEVERE; off-chain peak gust [0,500]
km/h, precipitation [0,5000] mm, assessed window. It supplies no risk thresholds.
Source: https://devnode.telegraphprotocol.com/engine/v1/intents/STORM_ALERT_GENERAL
No new registry retrieval was attempted after the earlier HTTP 403.

The previous slice answered only inside NWS coverage and returned null forecast
numerics. This slice adds a complete Open-Meteo hourly model forecast and
retains NWS alert evidence. Forecast failure/invalid/capped/backoff falls back to
the existing NWS-only score when NWS is available, explicitly with unknown gust
and rain fields and forecast-unavailable disclosure. Without either valid source
it refuses; no source failure becomes an unqualified LOW. NWS outside coverage,
transport/HTTP failure, timeout or malformed data is explicitly forecast-only,
not proof no official warnings exist. NWS existing active-now and expiry-inside-
window scoring is unchanged, and its mismatch with the aligned forecast window
is recorded. That policy is a separate review item.

Open-Meteo docs say both precipitation and gusts represent the PRECEDING hour.
Therefore an assessment starts at the next full UTC hour (up to almost 1h delay),
ends exactly window_hours later, and requests interval end timestamps from
start+1h through end inclusive. Both answer and receipt disclose this aligned
window. We do not label partial/past rain as future rain or extrapolate missing
hours. All timestamps must be exactly contiguous and complete, all values finite
and in range, and source units and UTC offset must match. Grid coordinates are
retained, not rewritten as exact user-point observations.

Disclosed VeriReceipt heuristic, NOT an official warning or contract formula:
gust >=60/90/120 km/h OR maximum rolling-24h rain >=25/50/100 mm produces scores
0.5/0.75/1 and levels MODERATE/HIGH/SEVERE, else LOW 0. For windows shorter than
24h the rain window is shorter too. Output precipitation_mm is the total across
the full assessed window, distinct from rolling rain used for risk. Final score
is maximum of the forecast heuristic and available NWS score. This formula is
an implementation choice, not a claim of meteorological validation or score gain.

Sources checked:
- https://open-meteo.com/en/docs : hourly variable definitions, units, time ranges.
- https://open-meteo.com/en/terms : data CC BY 4.0, free endpoint non-commercial.
- https://open-meteo.com/en/pricing : free evaluation/prototyping, commercial plan.
The answer attributes model data and transformations to Open-Meteo/VeriReceipt.
CC BY data does not grant commercial free-endpoint access. This use is scoped to
evaluation/prototyping; production commercial eligibility needs a paid endpoint
or a separate permitted source before commercial traffic. No money spent here.

Fetch controls: max 256KB, redirects refused, 4s abort plus 4.1s hard deadline.
Transient 5xx, timeout, parse and transport failures fail only that request;
explicit HTTP 403/429 pauses new forecast reads for one hour then permits a new
read. No immediate retry or alternate path. The one-hour recovery is not a claim
that a provider granted fresh access. Source refusal triggers the same backoff.
Budgets are 2,000 new URL reads per rolling day, 300/hour, 30/minute, below the
published free maxima 10,000/day, 5,000/hour, 600/minute read on 2026-11-24.
A 500-entry 10-minute cache coalesces requests within 0.01-degree lat/lon cells,
retaining actual source URL, raw body and model-grid coords. Nearby coordinates
can share a body; answer/receipt disclose this spatial approximation. Cache hits
retain acquisition time. Budgets/cache/backoff are process-local; other weather
handlers do not share them, so no multiworker/global guarantee is made.
Optional NWS read has a 4.1s combined deadline and abort; no retry. Model issue
time is absent, so acquisition time is not called model issuance time.

Real Cairo 24h and 240h bodies, exact URL, time, hash and window are in the fixture provenance.
Unmodified exact replay and persisted evidence are tested. Other weather windows
and threshold tests are explicitly synthetic mutations/retiming controls, not
claims of actual severe weather. A surviving rain-unit mutant exposed a missing
control; that control was added and all five final mutants must be red.
