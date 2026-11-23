# Aave pinned-state freshness and deadline

23 November 2026. Official registry https://assets.aave.com/address-book/releases/latest/modules/AaveV3Ethereum.json and data-provider tuple documentation https://aave.com/docs/aave-v3/smart-contracts/view-contracts. Contract https://devnode.telegraphprotocol.com/engine/v1/intents/CRYPTO_YIELD_RATE_GENERAL requires supply APY in basis points.

Real USDC capture from https://eth-mainnet.public.blastapi.io and https://eth.drpc.org is committed alongside the tests. Both returned chain 1, finalized block 0x1940fd4 and identical 12-word reserve data. Block observation time 21:42:47Z, reserve mutation 21:42:23Z. Capture contains the three actual requests per leg. Handler replay reuses that captured block response for its stability reread; it is a deterministic test replay, not an additional captured live request.

The current rate is observed at the pinned block. The reserve's lastUpdateTimestamp is the last mutation, not the time this observer read state. Preserve it separately, with future-update and stale-block refusal unchanged. Do not reject fresh unchanged rates solely because no reserve mutation occurred recently. Both agreeing legs' exact RPC response bodies now travel in the receipt, not only the first leg.

Yield's full-source deadline is five seconds rather than 900ms for eight sequential RPC calls. Parent cancellation now reaches fetch through an optional backward-compatible signal parameter. A hung source still refuses and cannot persist a late observation. Live pre-change handler completed in 760ms; no claim that all calls will complete within five seconds.

No manifest, registration or deployment change. Incentives/rewards remain excluded. Source licence booleans remain false under the existing opaque dated testnet-risk record.
