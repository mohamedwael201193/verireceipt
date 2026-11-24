# Floatrates target identity, 2026-11-24

Existing accepted actual Floatrates bodies under fx-same-day and
fx-independent-window carry per-entry code and alphaCode, both naming the target
currency. The adapter previously selected rates only by the lowercased table key,
ignoring conflicting target identity. It now requires entry.code exactly match
the requested uppercase target and checks alphaCode when supplied. A missing
entry remains no pair coverage, not source failure. Missing or malformed code,
or conflicting/malformed supplied alphaCode, is source failure. An omitted
optional alphaCode is allowed when code matches, preserving older unit fixtures.

No actual source body is edited or new retrieval claimed. Positive replay saves
exact accepted body bytes and verifies persisted receipt SHA-256. Wrong/missing
identity controls are synthetic. Independent removal of each identity check must
be red. An older synthetic disagreement fixture now supplies code EUR so it
continues testing disagreement rather than identity failure.

Provider, median, date-label/window, rates, target range and manifest policies
are unchanged. No historical scoring cause or score improvement is claimed.
