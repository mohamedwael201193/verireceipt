# Ethereum legacy receipt compatibility, November24,2026

A captured public-RPC response set for transaction
0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060
at block46147 reproduces the regression: BlastAPI/dRPC provide synthesized
status0x1 without root, while MEV Blocker provides the native root without
status. The original projection compared nullable status and root separately,
so these equivalent encodings refused despite matching block identity and gas.

The shipped fixture preserves the original body strings, provider URLs and
capture timestamp. It came from a single read per configured public provider,
not a fabricated or historical evaluation answer. Direct reads from this
worker returned403 and were not retried; the independent capture is the
source evidence. Capture SHA-256 is recorded beside it.

EIP-658 replaces intermediate state root with status at Byzantium:
https://eips.ethereum.org/EIPS/eip-658

The compatibility rule is explicit Ethereum scope and block<4370000. A valid
legacy root-only receipt uses the existing txLookup effective-success doctrine.
Matching transaction hash, block number/hash, effective status, log count,
gasUsed and cumulativeGasUsed are required. This is a representation rule,
not a new proof that a legacy state root cryptographically attests success.
All explicit roots across every provider and retry round must agree, even
where a status-only source would bridge two different roots. Both handlers
return the selected original source object, not a rewritten receipt.

Modern missing status, missing both status/root, malformed root/status,
reverted-vs-success, changed roots, changed gas, block identity or log count
refuse. Other chains do not inherit Ethereum's fork height. A prior synthetic
root-only test at a modern block was corrected to assert unreadability rather
than treating it as a legacy observation. No source, retry, rate, timing or
wallet-bearing operation changed. Genuine null/found retry controls remain.

Both handlers replay captured receipt bodies. Transaction-risk transaction
and SDN wrappers in the route test are synthetic and labeled; the zero-value
rubric score is a synthetic control, not the historical transaction's score.
Modern accepted transfer replay and all persistence/refusal siblings pass.
No deployment or score-gain claim.
