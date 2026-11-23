# Spot quote identity and read deadline, 2026-11-24

The existing Coinbase adapter accepted any positive data.amount without
checking data.base or data.currency. A response for BTC/USD or ETH/EUR could
therefore be mislabeled as the requested ETH/USD quote. It also cleared its
abort timer after response headers, before body consumption. A hung body
could exceed the advertised six-second source budget.

The adapter now requires the exact requested base symbol and USD currency,
a canonical positive decimal string in the existing contract range, and a
64 KiB maximum response. One six-second hard deadline spans headers and body,
with abort/cancel on expiry. Redirects are refused. The source, single-exchange
price convention, output and receipt formats remain unchanged. No fallback,
new provider, new intent or market-wide price claim is added.

Real source: https://api.coinbase.com/v2/prices/ETH-USD/spot
Capture metadata and exact bytes are in tests/fixtures/crypto-price/. The
public production receipt used for this capture was hash-verified before
extraction. Tests include independent saved evidence/hash checks, wrong-base,
wrong-currency, invalid amount, hung body, abort-ignoring fetch and oversized
body controls. Synthetic altered responses are test controls, not source data.

A public score gap alone cannot establish its cause. This change fixes
reproducible identity/deadline defects; it does not claim a measured score gain
or reinterpret single-source spot as an index.
