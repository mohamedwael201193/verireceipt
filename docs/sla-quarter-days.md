# SLA quarter period length

Quarter notation Q1 through Q4 plus a four-digit year now has an additive period_days value. Q3 2023 is 92 days. UTC calendar boundaries account for leap years and century rules. Input remains bounded to years1000 through9999 and exact quarter notation.

This does not add uptime history. For an unbound service, status remains not_found; uptime_pct, sla_target_pct and compliant remain null, verdict unverified and confidence0. The answer says this is calendar period length only, not measured uptime. A bound service with a calendar quarter likewise gets unknown observation fields and no external fetch. Existing supported rolling1-90day windows and their incident arithmetic remain unchanged.

The response and stored evidence include period_days; diagnostic period class is the closed calendar category. No service text is added to telemetry.

Validation:
- 267 root test files accounted,5518passing tests,250ordinary skips plus19excluded live-network route/transaction tests. This is not an unfiltered live integration or database-integration pass.
-23ordinary chunks ran on the reviewed uptime parent; after the independent57-intent manifest landed, this patch was restacked and manifest plus new-calendar tests rerun. All23route/transaction partitions ran on the finalmanifestparent. The only parent delta was that separate reviewed YAMLtrim and its structural count assertion.
-54relevant tests pass, including15newcalendar tests covering leap/century math, malformed selectors, bound/unbound semantics, exact receipt hashes and the HTTPcall site.
-12isolated mutantsRED, protecting calendar arithmetic/year/quarter bounds, call-site wiring, response/evidence fields, null uptime, disclosure, no-invented observationwindow and closed diagnosticclass.
-Source TypeScript compilation and diffwhitespacechecks pass after mutationrestoration.

No backenddeployment,registrationorwallettransaction is included.
