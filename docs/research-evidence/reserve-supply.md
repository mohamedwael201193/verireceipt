# Reserve supply presentation

Verified 2026-11-23 against issuer sources:

- https://docs.wbtc.network/resources/contract-addresses binds WBTC Ethereum contract and 8 decimals; native issuance exists on other chains.
- https://www.coinbase.com/cbbtc binds the cbBTC Ethereum contract and lists Base, Solana and Arbitrum issuance too.
- https://www.tusd.io/ binds TUSD Ethereum contract and lists other native chains.

Raw totalSupply and decimals eth_call bodies captured through https://eth-mainnet.public.blastapi.io and https://eth.drpc.org are in tests/fixtures/reserve-attestation, along with contemporaneous feed round bodies. Both legs agreed on each supply and token decimals. WBTC and cbBTC use 8 decimals; TUSD uses 18. The existing Chainlink directory capture supplies feed heartbeat86400 seconds for each enabled feed.

The response compares reserve against Ethereum-only native supply. It never labels that denominator global liabilities: collateral_ratio_pct stays null. Latest supply is not time-matched to the older feed attestation. Failed supply reads preserve the existing reserve answer but set supply and ratio null. Unknown assets return a coverage-only unavailable answer with null scored reserve and no receipt, not a successful numeric attestation. No new feed or asset is enabled; YAML unchanged.
