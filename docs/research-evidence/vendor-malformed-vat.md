# Malformed VAT with vendor name

When the declared VAT number cannot parse and a vendor name is supplied, use existing GLEIF legal-name search and OFAC/UN sanctions screening. Do not repair the identifier, infer a country, or invoke VIES with an extracted replacement. Disclose that the number had no country prefix (or was malformed if a prefix was present), and that no VIES lookup was made. The outer verdict remains no_data with valid:null, vat_number:null. Name similarity is not identity confirmation, registration validity, solvency, honesty or legal clearance. Individual unavailable sources remain explicitly unavailable. Receipt persistence failure still refuses the result.

No-vendor malformed input remains400INVALID_VAT. Multiple extracted VAT tokens remain400AMBIGUOUS_VAT. Parseable nonmember prefixes remain422VIES_SCOPE. Declared valid VAT and vendor-only inputs keep their prior checks. No alternate registry VAT-validity claim is made.

Diagnostics contain only vat_has_country_prefix:boolean and vat_length_bucket:empty|short|normal|long. Normalized length under4is short;4through16normal;greater16long. They are process-local metadata carried to request completion logging, absent from the response and receipt. Sanitizer rejects unlisted keys, arbitrary text and nonboolean prefixes. No raw vendor, VAT, query text or exact length is logged.

Live26November2026 source check: GLEIF legal-name endpoint returnedHTTP200,24candidates,total24. URL: https://api.gleif.org/api/v1/lei-records?filter%5Bentity.legalName%5D=Apple%20Inc.&page%5Bsize%5D=100 . Existing byte-preserved GLEIF and VIES fixtures remain unchanged. Sanctions tests reuse existing screening with mocked counterpart bodies rather than asserting a fresh live clearance. No VAT check is claimed for this fallback.
