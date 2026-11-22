# Recorded TVL source observations

Data source: DeFiLlama. Ordinary unauthenticated reads captured on 22 November 2026 at 10:53 to 10:54 UTC.

- Catalogs: https://api.llama.fi/protocols and https://api.llama.fi/v2/chains
- Protocol history: https://api.llama.fi/protocol/adi-bridge
- Chain history: https://api.llama.fi/v2/historicalChainTvl/AILayer
- Source field definitions: https://api-docs.defillama.com/llms-free.txt
- Source methods and update frequency: https://docs.llama.fi/faqs/frequently-asked-questions

Selection was from our new source catalogs, not an evaluation input. The fixture contains unchanged genuine observation dates and values. The protocol payload is a lossless projection of parser-consumed numerical fields, not the complete upstream wire response. The complete parsed chain history is retained. Original wire-response SHA-256 values are recorded in fixture provenance; JSON whitespace is not claimed to be original.

Controls age the execution clock and inject a primary HTTP503. The chain boundary controls explicitly select a subset ending at an actual zero history point. That subset is not claimed to be a captured historical wire reply or proof of what was published at an earlier retrieval date. No values, source dates or observations are invented. These are isolated implementation controls, not data displayed to users.

The repository's code license does not relicense third-party data. No endorsement by DeFiLlama is implied.
