# SEC financial-input cache

24November2026. Existing SEC index and companyconcept source URLs/UA unchanged. No source probe or new source. SEC_USER_AGENT remains required before cache lookup. Company index:1hour TTL,1entry; shares:15minute TTL,128CIK entries. Exact body and acquisition time are cached atomically, same key requests coalesce. Successful JSON must pass index shape/row validation or exact companyconcept identity/share validation before entering cache. Cache hits revalidate. Expired entries never stale-pass any outage,403or malformed success.

Response/evidence separately disclose index/shares acquisition times and maximum cache ages. Quote acquisition/exchange time stay independent. Answer names mixed-age derivation; cached SEC data is not described as fetched now. Search discovery still revalidates against the bounded-cache SEC index. Source timestamps and numbers are never advanced by cache reuse. Existing Yahoo5minute fresh/15minute absolute fallback and CoinPaprika cache unchanged.

Offline tests include exact TTL boundaries, coalescing, capacity eviction, invalid successful body rejection, expired outage refusal, actual handler source-count/timestamp/evidence preservation and SEC_USER_AGENT enforcement even on a warm cache. No live source availability or score claim.

Acquisition also has a real10second rejecting deadline covering fetch and full body read. No late completion can enter cache or answer. At most4underlying SEC loads may exist, including work that ignores abort after callers time out. Such work retains its slot and blocks a retry of that key until it really settles; no concurrency bypass. Tests include an actual-handler abort-ignoring late index and permanent unsettled loads. No timeout stale fallback is added.
