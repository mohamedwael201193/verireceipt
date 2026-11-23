# ONCHAIN_METRIC expansion qualification

November 23, 2026. Candidate only, not a registration or deployment claim.

## Contract

Canonical catalog and exact live schema were read from:
https://devnode.telegraphprotocol.com/engine/v1/intents
https://devnode.telegraphprotocol.com/engine/v1/intents/ONCHAIN_METRIC_VERIFY_GENERAL

The schema is active, response format v4. Required inputs are address and
integer block; optional chain is ethereum, polygon or arbitrum; optional
metric is balance or tx_count. Scored balance_gwei is in Gwei. Address,
block, chain and nonce are off-chain fields. No decimal ETH/POL substitution. balance_gwei is a JavaScript floating-point
number and can lose precision at large balances; balance_wei is the exact
integer string.

The existing handler requires agreement from at least two RPC endpoints
on finalized block hash, native balance and nonce. It checks chain ID and
block identity before and after reads. The new route uses exact query
validation; duplicate and unknown parameters fail before network reads.

## Real-source qualification

Local handler execution at about 15:49 UTC read the zero address at Ethereum
block 26400000. Two configured RPC endpoints agreed. The result was
14156889212130289945019 wei, nonce 0, block hash
0x44264ee1178054fd6eb847225b6c2c9f921f6f5d3a07a1655b17c29286d10185.
Latency was 1304 ms including persisted local receipt. Stored evidence
bytes were rehashed and matched the receipt. This is not production
verification; local receipt links are not published production records.

Primary responding RPC: https://eth-mainnet.public.blastapi.io
Other configured Ethereum endpoints: https://eth.drpc.org and
https://rpc.mevblocker.io . An agreeing response is not a claim that each
configured endpoint answered. The 9-second handler budget can end in
METRIC_QUORUM_UNAVAILABLE when archive/finality reads are unavailable. In
particular, older Arbitrum blocks can refuse with 502 when configured
public endpoints do not provide the required archive state. Registration
must not describe this as universal historical-block coverage.

## Manifest validation limits

The entire YAML is parsed using js-yaml and compared as an object with the
previous manifest. Structural tests check intent, endpoint and mapping
consistency; explicit tests pin this intent's fields/units. A route test
stores and rehashes the evidence. Isolated controls reject wrong chain,
reorgs, unfinalized blocks, differing nonces and JSON-RPC errors.

The node's own parser was not located or run. js-yaml is a real YAML
parser, not proof of registry acceptance. Published schema compatibility
and node acceptance still require the final registration packet and live
node validation. Registration remains gated on independent review,
production verification and a separate user heads-up.
