# Financial source capture

The CoinGecko body was captured 2026-11-23 at approximately 12:12 UTC:
https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true

It contains the provider's original market-cap, 24h volume and update
values. Tests freeze the clock near that provider update rather than
claiming the values remain current. The handler requests each asset alone.

Existing AAPL SEC/Yahoo and BTC source captures retain their previous
provenance in the financial-data tests. Discovery tests use synthetic
alias and ambiguity cases solely to test selection rules, not financial
figures. A live SEC company_tickers check at 12:13 UTC returned 403;
no workaround was attempted. Live equity name-to-quote verification is
therefore still outstanding. No new Tesla financial figure is claimed.
