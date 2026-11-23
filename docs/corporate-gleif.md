# Corporate registry source expansion, 2026-11-24

US queries still use SEC EDGAR first. A completed SEC crosswalk miss falls
through to GLEIF. An SEC outage or missing SEC identification does not become
a negative company result. Other jurisdictions use GLEIF directly.

GLEIF maps entity.legalName.name, registeredAs, entity.status, jurisdiction,
legalAddress and entity.creationDate to the existing corporate fields.
Active means entity status ACTIVE, not LEI renewal, solvency or good standing.
Creation is not the LEI initial registration date. Missing or invalid creation
dates remain null. A dated field is the calendar date reported in that source.
GLEIF is an LEI repository, not a complete national company register.

Only a unique normalized exact legal name in the requested jurisdiction is
verified. Normalization folds case, Unicode compatibility and punctuation.
It does not invent abbreviations such as AG or translate company names.
No exact match returns not_found with null entity fields and an explicit
coverage warning, not inactive or proof of nonexistence. Multiple exact names
or incomplete pagination return 422, without choosing an entity. English country
names and ISO jurisdiction codes are accepted; historical territory aliases
from the internationalization library are canonicalized before use.

Source policy checked in full:
- https://www.gleif.org/en/meta/lei-data-terms-of-use
- https://api.gleif.org/docs

Data is provided under CC0 1.0. Access is free; API documentation gives a limit
of 60 requests per minute per user. The terms require access through offered
services, no technical circumvention, and no implied endorsement or affiliation.
They disclaim accuracy, freshness and uniqueness and specify substantial
liquidated damages for noncompliance. No GLEIF logo is used. Answers explicitly
name GLEIF and disclaim affiliation or endorsement. No owner-risk exception is
needed or claimed for this data licence.

The reader coalesces identical in-flight requests, caches original bodies and
acquisition times for one hour (at most 100 keys), and spaces new starts by at
least 1100ms. It refuses excessive queueing. Its transport has a 3-second abort
and a 3.1-second hard response deadline. Redirects and non-200 responses are
not followed/retried. Any read failure halts further network access for that
process until restart, conservatively including temporary errors. Existing
unexpired cached captures remain available with their original timestamps.
This is a process-local rate guard, not a distributed quota: multiple workers
sharing an egress/user must share a limiter or run only one GLEIF-reading
process. Restart resets both limiter and halt state. No alternate endpoint or
proxy is used to bypass refusal.

Receipts retain the exact raw GLEIF response body, requested/resolved
jurisdiction, selected fields, policy/terms URL, and original acquisition time.
The receipt hash covers this evidence envelope. It is not a hash of the
upstream response alone.

Actual captures in tests/fixtures/corporate-gleif/ are Tesco (GB), Siemens
Aktiengesellschaft (DE), and a deliberately nonexistent control. captures.json
records exact URLs, HTTP status and acquisition times. Tesco illustrates why
entity creation date (1947) must not be replaced with LEI registration (2013).
Tests independently reconstruct fields, verify saved evidence/hash and exercise
negative, ambiguous, malformed, cached, paced, halted and timed-out reads.
