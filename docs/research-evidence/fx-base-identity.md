# FX response base identity, 2026-11-24

Four existing quote adapters trusted rates[to] without checking the response's
own base/base_code against the requested from currency. A wrong-base response
could therefore enter either conversion or the shared FX_NOW source panel.
Frankfurter, open.er-api, vatcomply and the existing keyed ExchangeRate-API leg
now reject a missing, malformed or mismatched declared base. A rejected identity
is a source failure, not evidence that a currency pair is unavailable.

No providers, rates, date-label policies, window/median rules, intent manifest or
cache policies change. Fawaz already selects the requested base's table. Floatrates
has no declared base field and is outside this slice. Frankfurter's amount field
and other per-entry identities are outside this slice too.

Positive controls replay the accepted exact real bodies already stored under
tests/fixtures/fx-same-day, with their existing provenance and source URLs. Their
exact raw-body receipt hashes are checked. Wrong/missing/null/numeric identity
controls are clearly synthetic mutations, never provider evidence. The keyed
leg reuses a compatible body to isolate its validation in a unit test, not as a
claim of a new keyed-service capture. Four per-adapter mutants must fail.

Old unit/persistence fixtures that omitted base_code now carry realistic identity;
old missing-pair fixtures carry base so they still test pair coverage rather than
identity failure. No accepted real capture was edited. No historical scoring
cause or expected score improvement is claimed.
