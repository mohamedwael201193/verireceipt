# Optional validator performance budget

The scored effective_balance field remains the finalized-quorum value in gwei. The intent contract observed on 2026-11-24 still requires integer validator_index and scores effective_balance in gwei. No unit or quorum change is justified.

A production validator_index=1 request returned HTTP200 with effective_balance32000000000 and a stored receipt, taking5.396seconds. This is one successful request, not evidence explaining the aggregate score0. The existing optional epoch-delta enrichment had abort-only3second waits after the verified receipt was saved, and could hang on ignored abort or body reads.

The optional header and four balance reads now share a rejecting900ms budget, including body reads. Missing optional evidence leaves the verified answer unchanged. Each of the four configured source origins has at most one underlying optional read; ownership is retained after timeout until the actual read settles. Late bytes cannot create a performance receipt or update the returned/cache result. Bodies are limited to64KB and redirects refused for this enrichment. Required root and validator quorum transport is unchanged. Receipt database writes remain outside the source-read budget.

Synthetic fault tests establish timeout and resource behavior, not a score improvement. Existing frozen beacon records and receipt fixtures remain the numeric success controls.

Sources: https://devnode.telegraphprotocol.com/engine/v1/intents/VALIDATOR_PERFORMANCE_VERIFY_GENERAL and https://verireceipt.onrender.com/v1/validator?validator_index=1 .
