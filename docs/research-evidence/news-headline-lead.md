# Headline answer lead

The zero-score diagnosis that answer form matters is a hypothesis, not a proven scoring cause. This slice changes presentation only: answer begins with up to five unique available headline titles, source-reported publisher or named index, and full ISO source date. It never pads a short result set. The scored top_headline rule, source calls, windows, receipt bytes and headlines/urls arrays are unchanged. headline_details adds the exact displayed title/outlet/date/URL records.

Existing captured real source fixtures are replayed from tests/fixtures/news. Their provenance is recorded in the existing news source/test files. No new current-news factual claim is made from these historical fixtures. Search/index coverage remains explicitly limited and degraded sources remain named. When no publisher is supplied, the index name is shown rather than an invented outlet.

Thirty news tests pass, including existing zero-result, all-down, malformed-source, recency, scored-top and receipt controls. Two new controls check five unique source-dated items and no padding of a single item. Three mutants killed: one-only lead, dropped dates and dropped deduplication. Build passes.
