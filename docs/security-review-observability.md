# Security review request visibility

The security-review route is now mapped to SECURITY_REVIEW_GENERAL for fixed-label arrival and completion logs. The known query-key list recognizes target by name only. Before this mapping, the route was categorized as other and emitted neither line, so an absence of security-review log lines did not prove an absence of requests.

No target value, unknown key, package name, code, URL or raw error is added to logs. Status, elapsed time and existing closed error categories follow the unchanged shared rules. Handler, response, source, receipt, registration and verdict semantics are unchanged. Unsupported target errors still use the existing generic diagnostic category if their code is not already allowlisted.

Current contract checked: https://devnode.telegraphprotocol.com/engine/v1/intents/SECURITY_REVIEW_GENERAL . It requires target and scores vulnerability_count. This patch does not expand the exact npm-package review scope or claim that the observed leaderboard score has a known cause.
