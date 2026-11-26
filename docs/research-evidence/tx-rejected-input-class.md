# Rejected transaction input diagnostics

No response contract change. Malformed hashes remain400 INVALID_TX_HASH. Well-formed EVM hashes on unsupported chains remain400 UNSUPPORTED_CHAIN. Missing required input remains400 MISSING_PARAM. No RPC lookup, not_found claim, new receipt or guessed chain is introduced on these paths.

Process-local answer_class records only tx_hash_length (missing/short/exact/long relative to64 hex payload characters after optional0x), tx_hash_has_0x boolean, tx_hash_is_hex boolean, and tx_input_chain (supported canonical chain enum, unsupported or missing). Original trimmed input is classified, not emitted. Uppercase0X is a recognized prefix. Hash-like question suffix parsing and accepted hash normalization remain unchanged. No raw hash, unknown chain string, free text or digest is logged by this slice. Existing response messages are unchanged.

This is diagnosis only. One graded INVALID_TX_HASH was observed, but the original input was not recorded. There is no evidence that turning malformed input or unsupported chain into200 would improve grading, so neither was changed.
