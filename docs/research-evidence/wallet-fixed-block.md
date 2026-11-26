# Fixed-block wallet balances

Finalized heads are observations, not guaranteed equal across providers. Read each once, require at least two valid heads, then select the lowest observed finalized number minus three. Each native balance or ERC20 balanceOf, decimals and symbol call uses that numeric block tag. Require two matching balance/decimals/symbol tuples. If no tuple agrees, retry exactly once two blocks earlier. Never average, infer metadata or claim a balance on a moving tag.

Return human balance, exact base units, onchain symbol and the disclosed balance block. Optional account classification/nonce independently requires exact block/hash/code/nonce agreement at that same numeric tag, or reports unknown without replacing a healthy balance. `account_context_block_number` is separate from `block_number` so optional context cannot overwrite the balance block. A native symbol remains chain-configured.

Each RPC response has a 4s caller deadline, 64KiB streamed body cap, no redirects and exact JSONRPC ID/version/error/result validation. Endpoint ownership and the global12owner cap last until actual transport/body/cancel drain, even if fetch ignores abort. Finite120RPC-start/min budget. No provider retries/bypass beyond the single disclosed block-2 retry. ENS resolution behavior is unchanged.

Live public-chain run on 2026-11-26: Base USDC for public address 0x1111111111111111111111111111111111111111, block62408686, 281986988 base units, 281.986988USDC,3/3agree. Sources:
- https://base-mainnet.public.blastapi.io
- https://base.drpc.org
- https://mainnet.base.org

Ethereum native and DAI receipt controls were re-captured through the final fixed-block handler against existing configured public RPCs; exact request/response bodies, hashes and expected evidence are in the deferred-persistence fixture. No fabricated measurement or old-tag capture relabelled to a fixed tag. Mock values only drive clearly hermetic failure/selection controls. No transaction signing, registration or deployment.

## Overlap correction

Same-chain callers join the same in-flight RPC key (URL, method and exact params). Different requests may overlap up to three transports per URL, still within the global twelve-owned-transports and 120starts/minute bounds. A shared request has one4second deadline, not a fresh timer per join; a caller cannot abort another caller's healthy in-flight result. Ownership persists after caller timeout until actual fetch/body/cancel drain. No completed RPC cache was introduced.

Two simultaneous real Base USDC balance calls for different public accounts succeeded in1.66seconds at the same selected block62414580. Hermetic controls pin concurrent handler success and exact head deduplication, per-URL3admission and drain, global12admission and drain, and joined hung requests. Removing singleflight, lifting per-URL3to30or global12to120each makes the isolated controls fail.
