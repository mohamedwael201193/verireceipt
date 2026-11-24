# Privacy-bounded request diagnostics

24 November2026. request_start records fixed route-derived intent, known key names and route-owned closed enum values only. Chain, DNS record type, a fixed currency set, and the generated fixed SEC form vocabulary are allowed on their owning routes; everything outside those sets becomes other. Filings period_kind is a finite lexical category, not a resolved period or date. It is diagnostic shape, not a statement that the parser accepted it. No free-text input, unknown key, personal/contact/account identifier, wallet/hash, coordinate, URL, query, amount, raw error or header/body is emitted. Own data properties avoid executing getters. Unknown routes do not log. Failures cannot change responses.

request_complete remains the status source, with a closed expanded filing-error vocabulary. Start events intentionally have no final status, which is unknowable at arrival. Filings math and response contract untouched. No deployment.

## Separate form-filter design, not implemented

The live REGULATORY_FILING_MONITOR_GENERAL contract requires entity+period, not form_type. Optional filters must not be silently ignored: an explicit10-K/10-Q ask answered with all forms is wrong. An honest multi-form design would parse a finite list of verified exact EDGAR forms, count the union of unique accessions, preserve original/amendment separation, disclose each requested form and per-form count, and retain conflict checks against entity/period form clauses. It needs a discriminated form-set type and sibling replay, not a catch-and-fallback to all forms. Annual report is ambiguous across domestic10-K, foreign20-F/40-F and amendments; use a disclosed eligible annual-form family based on issuer identity only after that doctrine is reviewed, or keep an actionable refusal. A generic label cannot safely mean10-K for every filer.

Contract source: https://devnode.telegraphprotocol.com/engine/v1/intents/REGULATORY_FILING_MONITOR_GENERAL . These are proposed semantics, not contract-mandated mappings. No form-filter behavior changed here.
