# Crypto market cap and rolling volume source

24 November 2026. ETH and SOL financial-data observations use the single named CoinPaprika ticker API. BTC retains the separate Coinbase spot multiplied by emission-schedule supply method. No median, second provider, fabricated value, proxy or block bypass is added.

Sources checked:
- https://docs.coinpaprika.com/api-plans
- https://docs.coinpaprika.com/api-reference/tickers/get-ticker-for-a-specific-coin
- https://api.coinpaprika.com/v1/tickers/eth-ethereum
- https://api.coinpaprika.com/v1/tickers/sol-solana

Free plan docs list personal use, no redistribution, 20,000 monthly calls and updates up to ten minutes apart. Free access is not a commercial or redistribution grant. The existing source approval record remains commercialUse=false and redistribution=false with the opaque dated owner-risk reference; every receipt includes it and credits CoinPaprika. No improved licensing claim is made.

Both ticker bodies were captured from the actual public source for fixtures. The parser requires exact registered id and symbol, numeric finite cap/rolling24h volume within the contract range, and a valid source update no older than one day or more than one minute into the future. Source time, acquisition time and exact raw body remain distinct. The existing bounded observation cache preserves original bytes/times, discloses eligible stale observations on retryable failures, and never converts malformed successful data or a 403 into a clean answer. A successful request outside production does not establish production reachability.
