# Holder symbol identity and observation timestamp

24 November 2026. A real keyless Blockscout USDC response was captured from the exact URL recorded in tests/fixtures/holder-blockscout/source.json. Original response bytes retained in ethereum-usdc.json. Successful handler replay verifies count, receipt digest and acquisition timestamp.

A symbol request now requires the indexer to supply a matching symbol. A missing or blank upstream symbol no longer silently inherits the requested label. An explicit contract query may still report its address-bound count with token_symbol=unknown; it does not pretend to identify the token by symbol.

For Blockscout, as_of now equals the actual source-body acquisition timestamp also carried by receipt.fetched_at, rather than a later presentation timestamp. GeckoTerminal retains its provider holders.last_updated as as_of, exact cached bytes/acquisition timestamp, five-minute cache and disclosed stale-on-429 behavior with the existing 24-hour source-age bound. No provider probing after a block/rate-limit and no broader chain/token coverage.

No manifest, registration or deployment change.
