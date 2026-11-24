# Receipt null/found disagreement, 2026-11-24

Scope: cross-chain receipt state and transaction-risk receipt lookup only.
Tx-by-hash quorum, address-runtime-code quorum, OFAC scoring and risk weights
are unchanged. JSON-RPC error/missing-result envelopes in transaction-risk now
fail as source errors instead of masquerading as null transaction absence.

The receipt helper requires two distinct provider URLs. It projects returned
receipts to transactionHash, blockHash, numeric blockNumber, status/root and log
count. Transaction identity must match the requested hash, block identity must
be complete, status/root must be valid if present and logs must be an array.
Hex case, quantity padding and unrelated provider metadata do not cause a split.
The selected result is an actual source receipt, never a merged/invented object.
Full logs are retained but their content is not scored here; log count is scored.
Padded status is interpreted numerically downstream too.

When null and found coexist, wait 1100ms then re-read only providers that answered
successfully. At most one retry round. Failed/throttled/challenged legs are not
retried. Require at least two present providers in the final round; a lone
present receipt never votes twice across rounds. A null majority cannot hide a
found minority. Any present scored-content/block conflict refuses, including a
change from the first round. With no present observation in either round,
two null providers retain the original absence behavior. A present quorum may
ignore a remaining null minority, which is preserved in raw evidence.

Each receipt leg aborts at 4s and has a 4.2s hard collection deadline. Two rounds
plus1100ms therefore bound receipt recovery to9.5s, not including unchanged
other handler legs. Added retry starts are limited per provider/process to one
per1100ms and30/minute. On concurrency saturation retry refuses rather than
bursting. This limit applies to added retries, not all repository RPC traffic,
and is not a cross-worker or global-egress guarantee. dRPC's official docs read
2026-11-24 state normal free-tier25 RPS with network-specific exceptions:
https://drpc.org/docs/howitworks/ratelimiting
MEV Blocker docs read at https://docs.mevblocker.io/ provide no numeric public
read allowance used by this slice. No new endpoint, access bypass or entitlement
is assumed. Existing provider errors are not retried in this operation.

All fulfilled raw bodies from both attempts, including null minorities, are
receipted under provider URL/attempt keys. Cross-chain adds chain namespace so
shared provider URLs on distinct chains cannot overwrite evidence. The source
policy is included in risk receipts; cross-chain receipts disclose it too.

Tests replay accepted real ethereum transaction/receipt fixtures already used
by crypto-transfer. Split existence, status/log/block/identity conflicts,
provider metadata, padded quantities, outages, rate errors and hanging legs are
clearly synthetic controls. Real fixture bodies were not edited. No production
failure input or score cause is claimed to have been reconstructed.
