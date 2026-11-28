# VIES fixtures — provenance

`vies-es-valid-20261128.json` and `vies-es-invalid-20261128.json` are VIES REST
API responses for Spanish VAT numbers A15075062 (valid) and A15075063
(invalid), captured 2026-11-28 for the vendor-verify unprefixed-VAT work.

The delivered capture of each file was one byte short: the final `}` closing
the root object was missing, so neither file parsed as JSON. The completion
here adds only that closing brace. The completed bodies were checked against a
live re-fetch of
`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/ES/vat/<number>` on
2026-11-28: byte-identical apart from `requestDate`, which moves with the
query. Nothing else was changed, added or reordered.

`tests/vendor-vat-derivation.test.ts` mocks VIES with these two files only. The
DE and AT replies in that test are labelled there as synthetic test doubles of
the same response shape, not captures.
