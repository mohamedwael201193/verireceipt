# Transaction-by-hash grouping and recovery, November24,2026

The retained public provider capture has identical field values but different
object key orders. The prior raw JSON.stringify grouping splits those into
two groups. With a transient null from one of the two same-order providers,
three singleton groups can cause refusal. The capture itself contains only
found results; null transition tests are explicitly synthetic fault controls,
not claimed captured historical null responses.

The transaction-only helper compares recursive key-sorted required fields:
hash, blockHash, blockNumber, from, to, value, nonce, input. Optional signatures,
fees and other explicitly named provider metadata may be absent on one leg,
but values present on both must agree. Pairwise-compatible groups avoid a
missing-field observation falsely unifying conflicting optional values. A
matching distinct-provider pair wins, as before; a third dissent is retained
in evidence, not silently described as unanimous. The original selected source
object and success response shape remain unchanged. No value coercion.

Null/found split waits1100ms and retries only answered providers once. The
final round alone must have two matching distinct present providers; a lone
found result cannot lose to two nulls or vote twice. Uniform null returns
TX_NOT_FOUND without retry. Missing transport quorum remains unreachable.
Four-second source abort plus4.2-second hard leg ceiling applies; all fulfilled
attempt bodies are retained, and error objects carry transactionEvidence for
internal inspection only. No public error-body disclosure is added.

The retry admission is shared with receipt reads: at most one added retry per
URL per1100ms and30 per minute, no retries of failed or rate-limited legs.
The new cap can refuse a second split phase in the same request, conservatively.
No new RPC providers, deploy, transaction signing or score claim.

Fixture source is the captured public response set with URLs/timestamp in
 tests/fixtures/transaction-quorum/providers.json . It is not evaluation truth.
The legacy handler test's synthetic transaction wrapper gained the required
nonce/input/blockHash fields; its captured receipt bodies remain untouched.
