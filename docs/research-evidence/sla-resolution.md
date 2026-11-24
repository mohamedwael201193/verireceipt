# SLA source resolution

Verified source snapshots captured 2026-11-23 around 21:29 UTC:

- https://www.githubstatus.com/api/v2/summary.json
- https://status.atlassian.com/api/v2/summary.json
- https://status.digitalocean.com/api/v2/summary.json

The existing GitHub/Cloudflare/OpenAI/Twilio/Reddit bindings remain. Atlassian and DigitalOcean bindings are added after real summary reads. Normalized alias spacing and verified full status hostnames are accepted. Explicit single-label `name.statuspage.io` hosts are supported as direct provider identifiers, not as arbitrary user URLs. No `status.<unknown>.com` host is invented.

Unknown service input returns HTTP 200, status=not_found, uptime_pct/sla_target_pct/compliant=null, confidence=0 and no provider lookup. The receipt records that this is a binding-list miss, not a factual assertion that a status page cannot exist. Supplied internal targets do not become network destinations.

Known pages are fetched over HTTPS and require HTTP/HTTPS page metadata identity matching the bound host. HTTP metadata URLs are normalized to HTTPS only on that same host. They require an actual components array. Current component snapshots and the exact summary body are included with the existing paginated incident evidence. The existing 1..90-day major/critical incident-union estimator remains. This is incident-log estimated uptime, not measured availability or reconstructed component uptime history. Current component state cannot establish historical availability. Target/compliance remain null because this endpoint has not established a machine-readable target, not because none can exist anywhere.

Eighteen SLA tests pass. They retain interval/count/freshness-window controls and add no-network unknowns, alias/hostname identity, raw summary evidence, malformed component arrays and source identity refusal. Three mutants killed: unknown-to-zero uptime, missing identity check and missing component-array check. Build passes.

Remaining scope: arbitrary company-to-custom-status-host discovery and 90-day per-component history are not provided by these sources. Adding guessed hosts or deriving historical component uptime from current states would be incorrect. No declaration, registration, deploy or signing change.

DigitalOcean source metadata declares an HTTP page URL despite the successful HTTPS fetch; handler-level captured-fixture regression covers normalization. Atlassian serves an empty components array, retained as empty rather than invented component history. Twenty SLA tests now pass.
