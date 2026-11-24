# Financial metrics response type

The current FINANCIAL_DATA_GENERAL response schema declares metrics as a string, not a list. The BTC, aggregated-crypto and equity paths now join their existing metric lines with semicolon-space at the response boundary. No metric line is added, removed or recalculated. Stale-source disclosures remain included in the same existing lines.

market_cap_usd, volume_24h_usd, null handling, source selection, timestamps, answer, receipt and evidence bytes are unchanged. The tests replay real source captures on all three successful HTTP paths and verify the string type and receipt digest. The external field is off-chain; this corrects an actual schema mismatch but does not establish the cause of any score.

Contract checked: https://devnode.telegraphprotocol.com/engine/v1/intents/FINANCIAL_DATA_GENERAL , response.fields entry metrics has type string. The scored market_cap_usd remains a numeric USD field with six decimals.
