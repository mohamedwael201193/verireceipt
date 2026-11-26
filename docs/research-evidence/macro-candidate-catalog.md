# Rejected macro indicator candidate diagnostics

Source: https://api.worldbank.org/v2/indicator?source=2&format=json&per_page=20000

Captured26November2026. Source2 is the WDI catalog. The response reports1498 entries, one page. src/data/wdiIndicators.json contains only public id/name pairs, sorted by ID, no user context. The catalog is a fixed diagnostic snapshot, not current observation data. Catalog refreshes require review.

Rejected indicator diagnostics record at most three catalog IDs as candidate_series_1 through candidate_series_3. Ranking uses matched non-noise words, then overlap divided by the larger input/catalog token count, then ID for deterministic ties. Only positive-overlap leads are retained. These are lexical search leads, not semantic equivalence claims or eligible fallback mappings. Unknown, empty and over1024-character input receives no default candidates. No raw input, country, arbitrary ID-like string or catalog name is retained in telemetry. The sanitizer independently checks every ID against this fixed catalog.

No indicator mapping was widened. Unmapped qualified indicators still receive the existing coverage-only no_data result, not an observation. Existing explicit qualified aliases and exact catalog discovery are unchanged. The original graded failing phrase was not recorded, so automatic catalog_best_match selection is deferred until a known failing phrase provides a grounded case. Candidate diagnostics are process-local metadata only; they do not enter response fields, receipts or evidence. This patch adds no source request or timeout. Existing exact-catalog discovery still performs its original requests where applicable.
