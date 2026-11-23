# GeckoTerminal token-info captures

Captured 2026-11-23 between 12:14 and 12:16 UTC from the keyless token-info
endpoint. Each original JSON body includes network-qualified data.id,
contract address, symbol, holder count and holder-specific last_updated.
The handler source builds the exact URL from network and address.

Networks: bsc, polygon_pos, base and arbitrum. The BSC USDT and USDC
symbol bindings were checked against these response identities. Existing
Base, Polygon and Arbitrum mappings remain in tokenContracts.ts.
Counts are the provider's address aggregate, not independently recomputed
RPC state. A 24-hour source-age gate rejects stale counts.
