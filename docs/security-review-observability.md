# Security review request visibility

The security-review route is now mapped to SECURITY_REVIEW_GENERAL for fixed-label arrival and completion logs. The known query-key list recognizes target by name only. Before this mapping, the route was categorized as other and emitted neither line, so an absence of security-review log lines did not prove an absence of requests.

No target value, unknown key, package name, code, URL or raw error is added to logs. Status, elapsed time and existing closed error categories follow the unchanged shared rules. Handler, response, source, receipt, registration and verdict semantics are unchanged. Unsupported target errors still use the existing generic diagnostic category if their code is not already allowlisted.

Current contract checked: https://devnode.telegraphprotocol.com/engine/v1/intents/SECURITY_REVIEW_GENERAL . It requires target and scores vulnerability_count. This patch does not expand the exact npm-package review scope or claim that the observed leaderboard score has a known cause.

Target shape field (November 26, 2026): request_start and request_complete for this route also carry target_shape, one of npm, pypi, cve, ghsa, url or other. It is derived from the target by fixed patterns and never contains the value, a package name, an ecosystem label or an id. Refusals use closed error codes (INVALID_TARGET, ECOSYSTEM_NOT_COVERED, NO_ADVISORY_COVERAGE, OSV_UNAVAILABLE), which are now in the diagnostic allowlist instead of collapsing to OTHER_ERROR. The statement above that response semantics are unchanged applies to the earlier mapping only; the target forms now accepted are listed in docs/research-evidence/osv-package-security.md.
