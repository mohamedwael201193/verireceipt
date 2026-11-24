# Frankfurter quote-unit boundary, 2026-11-24

Existing Frankfurter v1 response carries amount=1. The FX adapter uses rates[to]
as units per one base currency and does conversion locally. It already validates
base but previously ignored amount. It now refuses missing/non-numeric/non-unit
amount as source failure rather than silently treating a scaled amount as a
per-unit quote. No divide/repair of wrong-unit data is attempted.

Official v1 documentation read: https://frankfurter.dev/v1/
Its conversion example multiplies caller amount by rates[to] locally. The accepted
actual Frankfurter fixtures already include numeric amount1 and replay unchanged
with receipt checks. Seven altered-amount controls are synthetic, not evidence
that upstream served a wrong amount. Deleting the guard must turn them red.

Old synthetic coverage/persistence fixtures now carry amount1 so they continue
testing their original boundaries. No real source body is edited. Median/window/
date/provider/intent rules are unchanged. No score gain or historical score cause
is claimed. The v1 API is deprecated but official docs say it remains available;
this slice does not migrate to the differently sourced v2 API.
