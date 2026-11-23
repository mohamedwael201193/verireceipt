# Provider-reported asset total supply

For chainless USDC, USDT and DAI requests only, total_supply now uses the current CoinGecko asset-level total_supply. The canonical chain figure is retained separately as per_chain_total_supply and the answer states both scopes. Explicit-chain requests are unchanged. Other symbols retain their disclosed canonical-chain behavior until exact asset bindings are verified; no broad symbol search or sum of wrapped representations is used.

The asset read checks exact ID, symbol and Ethereum contract identity against the existing registry. It requires finite positive total_supply and source last_updated no older than five minutes, with at most thirty seconds future tolerance. It retains the exact body, provider update time, retrieval time, attribution and terms-risk fields in the combined receipt. The provider total is not described as an independently audited all-chain sum. A failed/stale read refuses rather than relabeling the chain total as global. Network bound is 2500 ms / 500 KB. No retry or bypass of HTTP 403/429.

## Live sources and terms

Real captures 2026-11-23:

- https://api.coingecko.com/api/v3/coins/usd-coin?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false
- https://api.coingecko.com/api/v3/coins/tether?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false
- https://api.coingecko.com/api/v3/coins/dai?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false
- https://www.coingecko.com/en/api_terms
- https://support.coingecko.com/articles/1043089972-what-are-the-differences-between-commercial-and-custom-licenses

All three API captures returned HTTP 200. The terms page's direct retrieval returned a challenge, which was not bypassed. The readable official licensing article confirms Demo/keyless use does not include commercial rights; standard paid plans also do not automatically grant reusable data redistribution. Powered by CoinGecko attribution is supplied. Commercial and redistribution confirmation remain false. The existing testnet owner terms-risk acceptance record is retained, never represented as a vendor licence.

149 tests pass across supply, asset validation, deferred receipt persistence and manifest suites, including two existing real-RPC supply tests. Exact asset fixtures, independent combined digest, chain/global separation, malformed/stale identities, missing supply and one-attempt 403/429 controls pass. Three mutants killed: missing asset ID, stale source acceptance and falsely granted commercial rights. Build passes. The expected scoring benefit remains a hypothesis, not a measured result.

Handler-level fail-closed regression explicitly covers both provider transport failure and stale captured source data for chainless USDC. Both must throw ASSET_SUPPLY_UNAVAILABLE after a valid chain quorum, never return the chain total as asset total. Mutating that catch to aggregate=null makes this test fail. Thirty-five supply/asset tests pass, including live RPC controls.
