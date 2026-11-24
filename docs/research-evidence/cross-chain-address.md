# Cross-chain address and partial reads

Address references now compare exact runtime bytecode returned by independent per-chain eth_getCode latest quorums. Two exact responses are required per chain. This does not compare balance, nonce, ownership, token identity or bridge state. Latest snapshots are not synchronized heights. Empty code is not proof of account absence; found stays null in address mode and code_present names only the code observation.

Existing transaction-hash receipt/status comparison remains. RPC error objects are not interpreted as null transaction results. Unreadable or split chains appear explicitly in per_chain with found/status null and an error code. consistent=false plus complete=false means consistency could not be established, not that a mismatch was proved. Confidence is zero and verdict unverified for incomplete evidence. Two unknowns cannot agree as absent. Known-chain validation remains strict.

The answer summarizes nonempty code size rather than printing unlimited bytecode into prose. Exact code and raw winning-quorum bodies remain in evidence. Independent evidence hash checks pass.

Real empty-code capture: https://eth.drpc.org , eth_getCode for the zero address, retrieved 2026-11-23 around 21:31 UTC. A live local-handler Ethereum/Polygon smoke around 21:32 UTC obtained complete independent quorums with empty code and disclosed that this does not establish account absence. Live endpoint sources also include https://eth-mainnet.public.blastapi.io , https://rpc.mevblocker.io , https://polygon.drpc.org and https://polygon.gateway.tenderly.co .

Twelve tests pass, including retained transaction controls, captured code bytes/digest, synthetic-labelled differing code control, split/outage/RPC-error chains and all-unreadable refusal of a consistency claim. Three mutants killed: missing completeness gate, one-vote quorum and ignored code difference. Build passes. No manifest/registration/deploy/signing change.

Tx-mode error-envelope regression: all receipt RPC legs returning JSON-RPC errors must be unreadable, complete=false/confidence=0, never absent. The shared transport guard already covers both modes; the added direct tx-mode regression pins it. Restoring the old missing-result-to-null behavior fails this test. Thirteen cross-chain tests pass.
