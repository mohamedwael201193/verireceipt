# Pool discovery evidence, November26,2026

Real GeckoTerminal keyless search and exact-pool JSON bodies. Source URLs and fixture SHA256 values are in provenance.json. No fabricated source numbers. This is reported total reserveUSD, not executable order-book depth.

Existing reviewed Ethereum pair aliases and exact EVM address workflows retain their original provider order. Previously unbound inputs use this separate GeckoTerminal discovery path, one public source request, no key/retry/host bypass. Closed17network map; exact Solana addresses validate base58 and32decodedbytes and compare case-sensitively. Existing EVM address routes remain unchanged.

Pair-name search uses only exact pair display-name matches on requested network, not fuzzy matches. A supplied fee label also must match. Highest reserve among exact matches is only permitted when canonical token addresses have been established: current new discovery coverage SOL/USDC on Solana and WETH/USDC on Base. Address evidence is from Solana native-mint docs, Circle USDC address table and Base WETH9 address table. Known Ethereum names continue their already reviewed path. Unknown token symbols remain ambiguous, even when only one display-name result exists. Exact addresses do not need a name-based token inference.

This safeguard matters: the captured Solana search page includes a pool displaying SOL/USDC with reported1.630819993billionUSD, but its base token address differs from canonical wrappedSOL. It is excluded from canonical SOL pair selection. Selected real canonical poolCzfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE has17491487.2859USD. Its independent exact endpoint confirms the same pool and reserve. Base WETH/USDC search selects0x6c561b446416e1a00e8e93e221854d6ea4171372,94880681.3131USD in the search capture; later exact endpoint reports95026758.307USD. Distinct acquisition times are not averaged or falsely treated as simultaneous.

Response shows selected address, venue, fee label when available and top10other candidates, with total count in the returned page. Selection is only among the first page, not an exhaustive market-wide claim. No match, unsupported network, ambiguity and source unavailable yield disclosed200null reserve rather than0or a guessed pool. Unique exact-name matches return the numeric reserve only after identity checks. Every response persists exact source body or explicit no-source coverage evidence; storage failure propagates.

Cache128entries60seconds with original acquisition time; no stale fallback,25starts/minute, maximum4underlying reads.2.5s abort/2.6s hard caller timeout. Abort-ignoring I/O retains capacity ownership. Malformed/wrong-chain/wrong-address/wrong-type/out-of-range values never produce numeric answers.

Sources:
- https://api.geckoterminal.com/api/v2/search/pools?query=SOL%20USDC&network=solana&page=1
- https://api.geckoterminal.com/api/v2/networks/solana/pools/Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE
- https://api.geckoterminal.com/api/v2/search/pools?query=WETH%20USDC&network=base&page=1
- https://api.geckoterminal.com/api/v2/networks/base/pools/0x6c561b446416e1a00e8e93e221854d6ea4171372
- https://api.geckoterminal.com/api/v2/networks/solana/pools/FqQKCJYCQgMpK67YoNSvhfwqKeB3bguugkxe3fBR7Pzk
- https://solana.com/docs/tokens/basics/sync-native
- https://developers.circle.com/stablecoins/usdc-contract-addresses
- https://docs.base.org/base-chain/network-information/base-contracts
- https://apiguide.geckoterminal.com/
- https://devnode.telegraphprotocol.com/engine/v1/intents/LIQUIDITY_DEPTH_VERIFY_GENERAL
