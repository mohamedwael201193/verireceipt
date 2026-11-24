# Validator effective-balance answer, November24,2026

Presentation only. The answer now leads with canonical effective balance in
gwei, then exact ETH text, before status and actual balance. Actual balance
remains distinct. No value, source, finality, quorum, cache, evidence, confidence
or performance-enrichment policy changes. No score gain claimed.

Reuses the already-accepted public beacon body fixture
 tests/fixtures/validator-finalized-record.json unchanged. No new capture or
hosted receipt availability is needed for this slice. The replay uses synthetic
root-resolution wrappers, not a claim of newly captured root quorum evidence.
Persisted validator bytes must remain identical to the accepted fixture.
Original synthetic controls cover zero, one gwei and2048ETH effective balances
while the distinct actual balance stays unchanged. Answer-order removal and
actual-for-effective mutants must be red. Existing full validator siblings
cover source refusal, cache, optimistic state, identity, disagreement,
persistence and enrichment behavior.
