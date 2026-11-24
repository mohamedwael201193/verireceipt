# Explicit multi-form filing union

24 November2026. Optional form_type/form fields accept2..10 nonempty exact known SEC form tokens separated by comma, semicolon, pipe, plus, ampersand, and/or. Every token must parse; unknown/missing/all-list components refuse. Deduplicate requested forms; match the union once per accession using existing accession deduplication. Original/amendment forms stay separate unless both named. Existing renamed families stay intact. Separate form fields/entity/period clauses must name the same family set, never silently widen. Multiple forms embedded only in entity/period remain refused; use the explicit list.

Responses disclose requested_forms, exact forms_counted, per-form counts and union/amendment policy. Single-form/all-form responses preserve existing behavior. Annual report stays refused, since a universal10-K mapping would misidentify20-F/40-F issuers. No manifest/source/registration or deployment change.

Existing complete real Apple capture replays10-K+10-Q=4 and8-K+8-K/A=9, with exact distinct accessions and sibling refusal controls. This is recorded-source evidence, not a new live SEC capture.

Contract https://devnode.telegraphprotocol.com/engine/v1/intents/REGULATORY_FILING_MONITOR_GENERAL requires entity+period and number of matching filings; form_type is optional provider behavior. It does not prescribe this union interpretation, which is explicitly disclosed. Never substitute unfiltered counts for invalid filters.
