# Recorded source data notice

`deferred-persistence-real-sources.json` contains ordinary public-source responses captured on November 22, 2026 for offline receipt-persistence tests. It is not demonstration data served to users. The responses and published values are not invented. Only storage failures and delays are injected by the tests.

The World Bank: World Development Indicators, indicator SL.UEM.TOTL.ZS, "Unemployment, total (% of total labor force) (modeled ILO estimate)": ILO Modelled Estimates database (ILOEST), International Labour Organization, ILOSTAT. The fixture also includes the World Bank country catalog used by the existing resolver.

- Indicator metadata and license: https://databank.worldbank.org/metadataglossary/world-development-indicators/series/SL.UEM.TOTL.ZS/
- Data license: CC BY 4.0, with the World Bank's additional terms: https://datacatalog.worldbank.org/public-licenses#cc-by
- Attribution and reuse terms: https://data.worldbank.org/summary-terms-of-use

The published source statistic is a modeled estimate, not a claim of a new direct national survey. No World Bank or ILO endorsement is claimed. Data retain their source terms; the project's code license does not replace them. Retain this attribution and the linked terms when redistributing the fixture.

Captured response bodies are unchanged. Repeated responses with identical request/body/hash were deduplicated; selection-only calls were excluded. Native expected witnesses, capture times, source URLs, hashes and independent selection rules are recorded in the fixture's provenance. The test clock controls execution timestamps, not the underlying published values.

Ethereum JSON-RPC responses are ordinary public chain reads through the existing configured endpoints. The public address was independently selected from a freshly fetched finalized block, not from protected evaluation material or a user's private account. No transaction was signed or broadcast. Canonical supply/balance witnesses are summaries, not full RPC-response bodies.
