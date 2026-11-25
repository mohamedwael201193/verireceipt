# Onchain metric query and network coverage

The metric route accepts query text as an additive fallback for address, block, chain and metric. Declared parameters always win, including empty or invalid values. Address tokens require exactly 40 hexadecimal digits after 0x. Blocks come from a block-labelled integer or a bare integer with at least six digits. Balance and nonce/transaction-count wording map to the existing two metric kinds. Other route keys remain rejected.

Adds Base, Optimism, BSC (including bnb), Avalanche and Gnosis to the existing Ethereum, Polygon and Arbitrum scope. Each successful value still requires two public RPC sources agreeing on the exact finalized block hash, balance and nonce. Native-unit labels are ETH, POL, BNB, AVAX or xDAI as appropriate. Request logging retains only a closed chain category or other, never a raw unknown chain or query text.

## Archive state

An explicit archive-state error from at least two sources can produce a receipted HTTP200 no_data answer with null metric fields, unverified verdict and zero confidence. This applies only when every failed leg is a classified archive-state error and there are fewer than two complete legs. Wrong chain, invalid envelope, generic RPC errors, mixed failures, malformed quantities, reorgs and conflicting complete legs remain refusals. Finality and source deadlines are unchanged. No value is inferred from unavailable state.

The classification checks the JSON-RPC version, request id, integer error code, bounded error message and a narrow set of archive-state phrases, only for balance or nonce methods. The receipt retains the raw error response. The answer explicitly states that unavailable is not zero.

## Real captures

`tests/fixtures/metric-coverage` holds self-recorded read-only responses, not independently authenticated source observations. Five networks were captured at one common exact block per network across three public sources, including finality, before/after header identity, balance and nonce calls. Additional archive probes retain raw responses and capture metadata with hashes, byte lengths, request parameters and response headers. All 110 captured files pass the recorded hash/byte checks.

BSC's two historical-state legs returned missing-trie errors even for the captured short-aged finalized block. That replay expects disclosed no_data rather than pretending those sources provided a verified balance. The other four real network replays verify values. Synthetic adversarial tests are labelled controls and never represented as source observations.

Official Gnosis network identity and RPC documentation checked:
- https://docs.gnosischain.com/about/networks/
- https://docs.gnosischain.com/tools/RPC%20Providers/

## Local gate

- Root inventory: 265 distinct test files, all included in the final chunk/partition gate. Entirely conditional skipped files are not claimed as executed database integration coverage.
- Final selected runs: 5,475 tests pass, 250 ordinary skipped tests. Route/transaction whole-describe partitions add 338 passing tests already included in that total and exclude 19 live-network tests. All ordinary chunks use case-insensitive live-name exclusion. This is not an unfiltered live integration pass.
- Initial new-checkout missing dependency resolution and one resource-killed worker were corrected; their runs are superseded by passing bounded reruns.
- The final relevant 12-file chunk passes 372 tests after the last additive adversarial tests. The new coverage suite passes 56 tests.
- 44 isolated mutants fail, covering fallback wiring and precedence, address/block boundaries, each added network identity, source wiring, native labels, archive envelope/method/length checks, no_data/null/disclosure/persistence semantics and closed chain logging.
- Source TypeScript compilation and diff whitespace checks pass.

No backend deployment, wallet transaction or registration is part of this change.

## Review revision

Query fallback refuses explicit unsupported chains and multiple chain/address/block/metric matches rather than choosing the first. Bounded transaction count, transaction-count and transaction_count wording maps to nonce count. Unknown metric text refuses rather than falling through to balance. Declared keys retain precedence even when query text conflicts. Archive classification requires an exclusive error envelope, never simultaneous result and error.

Capture headers are narrowed to date, content-type, content-length, last-modified and etag. Broad reporting and network-error telemetry headers were removed; exact RPC bodies remain unchanged. Base capture provenance is self-recorded and not independently authenticated. Independent review could not repeat two Base source checks because those hosts returned HTTP403 to the reviewer. Local byte/hash checks and capture replay do not establish independent source authenticity.

The final revision also guards partial declarations: declaring metric does not suppress unsupported unconsumed chain text for an undeclared chain. Both in/on chain context are checked. Any malformed explicit block selector poisons block inference, even when a separate valid bare number appears later. Both cases have handler and HTTP tests with zero source calls before refusal. A previously useful decimal-regex mutant became redundant behind the new malformed-selector guard and is not counted among the final 44 killed mutants.
