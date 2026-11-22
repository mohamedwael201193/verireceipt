# Source data notice

The fixture tvl-chain-scope-real-sources.json contains selected public DeFiLlama API fields captured on22November2026. DeFiLlama is the source of the measurements and metadata. This notice does not relicense third-party data under the project's source-code license or claim an independent on-chain audit.

Source endpoints and complete-body SHA256/byte counts are recorded in the fixture provenance. Catalog endpoints: https://api.llama.fi/protocols and https://api.llama.fi/v2/chains . Two separately captured protocol field projections come from https://api.llama.fi/protocol/antimatter and https://api.llama.fi/protocol/numbers-protocol . Current scalar and chain-history evidence came from the exact endpoint URLs retained in primary_records and chain_record.

The protocol projections retain identity, reported chain names, currentChainTvls and the complete captured tvl history. They are not complete HTTP wire bodies. Source values, precision differences between endpoints and observation dates are preserved without alteration. Catalog-selected staking/pool2 cases and the parent/version/named-chain controls were selected from ordinary fresh catalogs, not protected examples or another handler.

Named-chain-only and non-chain-only maps in unit controls are explicit projections of existing source keys. Reversed object order preserves the same key/value mapping. These controls do not claim the provider served a different full protocol. Offline handler transport uses the captured scalar bodies and parser fields. Primary503 is an injected failure and the execution clock is pinned to the actual capture time, not a claimed historical outage or new source timestamp. Storage and local receipt HTTP checks use real SQLite, not mocked storage. Local receipt IDs are not production links.

Publisher API documentation: https://api-docs.defillama.com/llms-free.txt . Publisher FAQ separates staking/pool2 from core TVL: https://docs.llama.fi/faqs/frequently-asked-questions . No paid API, new account/key, blockchain transaction, production row write or other-provider handler was used.
