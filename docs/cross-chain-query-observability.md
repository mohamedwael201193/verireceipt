# Cross-chain query-key visibility

The known-key list now recognizes reference and chains by name only. Both are required by the cross-chain handler, so earlier successful requests with empty param_keys did not imply empty input. No reference, chain-list value, arbitrary key or raw error is logged. No handler, source, response, receipt or consistency rule changes.

Contract checked: https://devnode.telegraphprotocol.com/engine/v1/intents/CROSS_CHAIN_STATE_VERIFY_GENERAL . Required reference and chains; scored consistent boolean. This change does not identify the cause of any score.
