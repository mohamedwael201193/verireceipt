# Yield safe-head observation

25 November 2026. This change applies only to the wired Aave yield reader. The source factory defaults to finalized, and other pinned finance sources are unchanged.

A bounded live diagnosis found two surviving independent RPC services returning the same finalized timestamp about949seconds old, outside the existing900second finance runner policy. A separate safe-head read returned identical chain1, block number/hash/timestamp and12-word reserve data on both services, with a stable block reread. Its age was606/607seconds. The real response fixture retains all four requests and exact response bodies per leg. These are captures, not current values.

The safe block tag is explicitly selected by yield configuration. Receipt evidence, source name and component disclosure say safe-head and not finalized. Reorganization remains possible. This is not settlement-final evidence. A safe response is still refused beyond15minutes, on future timestamps, differing block identity/rate bytes, changed reread, source deadline or absent quorum. No latest fallback and no freshness widening.

Primary references: https://ethereum.org/developers/docs/apis/json-rpc/ distinguishes safe, finalized and latest tags. https://www.aave.com/docs/aave-v3/smart-contracts/view-contracts documents getReserveData tuple and rate position. Reserve lastUpdateTimestamp is retained separately from observation time. Incentives/rewards remain excluded; scope stays the existing four named Ethereum reserves.

No declaration, registration or deployment change is part of this commit. The production502 observation and direct finalized diagnostics are retained in the private research checkpoint. BlastAPI returned429 during diagnosis and was not retried. Runtime replay does not imply all future live requests succeed.
