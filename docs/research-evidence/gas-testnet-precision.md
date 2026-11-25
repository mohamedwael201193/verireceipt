# Testnet gas exact wei

Sepolia and Base Sepolia alone use exact wei for G3: zero wei still refuses, any positive exact agreeing quorum can be served. Mainnet six-decimal rounding and zero refusal are unchanged. Testnet gas_price_gwei is a numeric wei/1e9 result, with additive gas_price_wei integer string; answer spells out nine-decimal gwei rather than scientific notation. USD transfer fee is null with an explicit reason: no mainnet USD valuation is applied to testnet gas tokens, and no spot request or gas_token_spot receipt enrichment is made. Quorum, optional fee context, original raw evidence/hash/persistence remain unchanged.

Contract checked25November2026 at https://devnode.telegraphprotocol.com/engine/v1/intents/GAS_PRICE_GENERAL : gas_price_gwei number, range0..100000, decimals6 in scoring/on-chain encoding. Endpoint JSON retains19wei as0.000000019, but six-decimal contract encoding cannot represent that value. No manifest or shapedFields change, no claim that grader encoding retains sub-microgwei precision.

Recorded current RPC bytes/hashes are in tests/fixtures/gas-testnet/PROVENANCE.json. Two Sepolia sources returned0x13(19wei), third403. Base Sepolia's reachable source returned0x5b8d80(6000000wei), other403. The19wei Base Sepolia test is a cross-testnet policy replay using the real Sepolia response, not an invented live Base Sepolia measurement or new source. Zero/disagreement tests are explicitly synthetic fault edits, not presented as live source fixtures. No paid call or transaction.

Answer specification: use the actual agreeing/total source count, never fixed unanimity. The recorded Sepolia outcomes yield2/3 sources agreed in both answer and receipt; the recorded Base Sepolia outcomes yield no quorum and refuse. The all-success19wei policy replay is separate from these recorded-outcome replays.

These are historical captures at the acquisition timestamps in PROVENANCE.json, not promises of the current moving gas value. A later reviewer read returned20wei on the two reachable Sepolia sources. Broad contract discovery metadata is not retained; only the field-shape observations above are documented.
