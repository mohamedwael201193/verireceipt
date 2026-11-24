# DNS refusal completion categories

The DNS route logs dns_refusal_reason only on failed requests. Existing fixed internal codes map to resolver_disagreement, inconclusive, bad_type, missing_param, invalid_name, persistence_failed and internal. Unknown codes map to other. The registry rejects arbitrary values and getters. Success metadata remains record_type plus record_result found/empty; no refusal field is added on success. Metadata stays out of responses and evidence.

Inconclusive means DNS_RESOLVERS_DOWN: zero usable conclusive resolver verdicts. It does not distinguish network failure, HTTP failure, timeout, malformed response, truncation or unsupported DNS status. Resolver_disagreement means at least two usable verdicts disagree on record existence. A 2:1 split still refuses; record-value differences alone do not. One usable resolver can still serve a degraded answer. Nothing in this patch changes those rules.

No queried name, record value, raw type, upstream URL, arbitrary error code or error message is logged. This patch changes only metadata registry, shared completion diagnostics, tests and documentation, not handlers, resolvers, answers, receipts or refusal behavior. The previously observed low score has no identified failing sample; resolver disagreement is a possible cause only, not a finding.

Contract checked: https://devnode.telegraphprotocol.com/engine/v1/intents/DNS_RECORD_LOOKUP_GENERAL . Required name and ten-type record_type enum, scored has_record boolean.
