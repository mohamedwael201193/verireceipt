# Finalized validator record

`GET /v1/validator?validator_index=0` keeps the canonical integer-index request and numeric `effective_balance` in gwei.

The native API also accepts `validator_pubkey`, a `0x`-prefixed 48-byte BLS public key. Supply exactly one identifier. A full BLS key in the existing `validator_index` query value is also accepted for native clients. This does not expand the published intent's integer input schema. No signing key is requested or used.

Every successful response includes:

| Field | Type | Meaning |
| --- | --- | --- |
| `validator_index` | number | Resolved validator index |
| `validator_pubkey` | string | Exact BLS public key, normalized to lowercase |
| `effective_balance` | number | Effective balance in gwei, unchanged canonical field |
| `balance` | decimal string | Balance in gwei at the agreed finalized state |
| `balance_unit` | string | `gwei` |
| `slashed` | boolean | Validator's slashing flag |
| `activation_eligibility_epoch` | decimal string | Eligibility epoch |
| `activation_epoch` | decimal string | Activation epoch |
| `exit_epoch` | decimal string | Exit epoch |
| `withdrawable_epoch` | decimal string | Withdrawable epoch |
| `status` | string | Beacon API validator status |
| `finalized_state_root` | string | Agreed state root binding the answer |

The `balance` and epoch fields keep exact uint64 decimal strings. The canonical `effective_balance` remains a safe numeric value in gwei. In particular, `18446744073709551615` is the far-future epoch sentinel, not an approximate number or a scheduled exit date.

At least two configured beacon sources must agree on the complete returned record at the same finalized state. A differing valid record prevents a verified answer, even next to an agreeing pair. Malformed or identity-mismatched source responses do not vote; they cannot supply any field. Endpoint diversity alone is not proof of complete operator independence. Existing root-binding, rate limits, timeout, retry and receipt-storage rules still apply.

The receipt hashes and serves the exact winning source response. Added fields are not taken from an unvoted source, filled with defaults or inferred from the effective balance. A result is neither returned nor cached unless its evidence was stored. This follows the same receipt model as the other VeriReceipt intents.
