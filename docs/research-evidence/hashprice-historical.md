# Historical block hashprice

Actual mempool.space captures2026-11-23:

- https://mempool.space/api/block-height/840000
- https://mempool.space/api/block-height/900000

The returned hashes identify the raw block bodies in tests/fixtures/mining-hashprice. Block details are read via the mempool.space /api/v1/block/hash endpoint, including extras.reward in sats, difficulty and timestamp. Historical USD comes from /api/v1/historical-price?timestamp=block_timestamp&currency=USD. Both raw block and price bodies are retained.

Formula: hashrate=difficulty*2^32/600; sats/PH/day=single_block_reward_sats*144*1e15/hashrate. This is not a weekly average.840000 includes unusually high measured fees; no subsidy-only substitution. USD price must precede the block by at most24h. Successful results cache60s in64 bounded height entries. Tip uses the existing weekly series basis; future heights refuse. Input range1..1e9; output range1..1e9 sats/PH/day remains enforced. YAML unchanged.

Upstream historical USD observations can drift a few dollars from captured fixtures as the provider revises historical data.
