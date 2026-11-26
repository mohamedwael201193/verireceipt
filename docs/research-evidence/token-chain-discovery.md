# Token supply resolution

No chain given plus an exact40hex ERC-20 contract starts one bounded read-only discovery over the handler's seven supported chains, including its two testnets. One existing RPC endpoint per chain, no retry or endpoint switching, at most two calls: totalSupply then decimals, spaced150ms. Whole discovery, including response bodies, ends at4seconds even when fetch ignores abort. Each response body capped64KiB; redirects refused. Exact JSON-RPC envelope and one ABI uint256 word required. Decimals0through36only. Empty0x or explicit execution-reverted result is a negative probe; transport/HTTP errors, invalid payloads and invalid decimals stay unavailable. No fallback around blocked or unavailable services.

Only one matched chain with all other probes conclusive negatives can proceed to existing independent finalized2-of-N supply/decimals/symbol quorum. Discovery alone never supplies the numeric answer or confirms token identity. Multiple, zero or incomplete matches return receipted200with total_supply:null, matched_chains, unavailable_chains and an explicit request for the chain. Discovery source bytes, URLs and classifications are receipt evidence. Explicit chains retain prior behavior. Missing/unknown symbol400gains private fixed token_shape, has_chain and in_registry diagnostics; no raw input or exact lengths. HTTP and cross-intent controls protect this boundary.

Issuer-published registry additions:11records across Ethereum, Base, Arbitrum, Optimism and Polygon in src/data/supplyIssuerTokens.json. Each records its exact published source URL and address. Fixed text captures retained in tests/fixtures/token-resolution. Lido proxies (not implementation/gateway addresses), Ethena explicitly labelled Ethereum tokens, Coinbase listed networks, and Aave's Polygon reserve address only. No ambiguous Most L2s Ethena addresses extrapolated to a specific chain. Existing registry addresses not replaced.

Sources read26November2026:
- https://docs.lido.fi/deployed-contracts/
- https://docs.ethena.fi/technical-design/key-addresses
- https://www.coinbase.com/blog/coinbase-wrapped-btc-cbbtc-is-now-live
- https://dash.tools.aave.com/reserve/137-0xd6df932a45c0f255f85145f286ea0b292b21c90b-aave-v3/

Also inspected Circle USDC, Lido integration guide and Aave documentation. Circle entries were already covered. Successful current ERC-20 execution for the additions is NOT claimed: direct sequential issuer-address RPC POST checks returned HTTP errors in this environment. Records retain that limitation in issuer-rpc.json. Runtime still needs actual valid responses and independent supply quorum. Tests use deterministic RPC fixtures for mechanics, not invented live observations. Existing live tests' names do not establish a new-address execution result.

Reviewer correction: shared same-contract discovery promise, one global transport owner retained until every actual fetch/body settles, not just caller deadline. Other contracts return disclosed unavailable while ownership is held; no queued starts. Completed work may start at most20discoveries per minute. Ownership, repeated/concurrent same/different contracts, drain release and start-cap controls and isolated mutants cover this.

Cancellation ownership: oversize reader cancellation and non-OK response-body cancellation are awaited by transport ownership, even when the caller deadline fires first. Pending-cancel streams cannot free a start slot early.
