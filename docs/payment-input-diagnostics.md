# Payment input diagnostics

The current schema4 and onchain request require bin integer100000..99999999. Empty input cannot support a truthful allocation or validity answer. Handler behavior is unchanged: absent/blank input is400MISSING_PARAM; malformed prefix is400INVALID_BIN.

Previous parameter-key logs omitted bin, so an empty param_keys list did not establish absent input. The key name is now recognized. Completion metadata input_class is a closed shape enum: missing (absent/blank), invalid (not6..8digits) or prefix (6..8digits). prefix is not a claim that the prefix is allocated, that a card is valid, or that a contract integer range was separately checked. A failed source lookup can still have input_class prefix. No prefix, length, card digits, arbitrary key, source error or domain is added to logs.

No handler, source, numeric, validity doctrine, cache or receipt change. Existing BIN-only versus checksum-description mismatch in the external contract is not solved by inventing a checksum from a prefix.

Source: https://devnode.telegraphprotocol.com/engine/v1/intents/PAYMENT_METHOD_VERIFY_GENERAL .
