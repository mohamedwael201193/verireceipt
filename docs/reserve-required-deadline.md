# Required reserve transport deadline

Required feed decimals and round reads share one nine-second budget. Fetch and streaming body reads reject at that deadline even if abort is ignored. Optional supply retains its independent 900ms budget, so source reads take at most 9.9 seconds before receipt persistence. This is not a bound on database persistence or event-loop scheduling.

Required transport uses the existing bounded reader with a 10KB body cap, redirect refusal and RPC-error refusal. The enabled feed set has nine URL/feed keys. A key stays occupied until actual I/O settlement, even after the caller refuses. One key can only be reused after that operation settles; no queue is created. Required and optional pools are separate.

Required failures remain 502, never a synthetic reserve or a coverage-only success. Quorum, units, round staleness disclosure and feed coverage are unchanged. Captured real feed/token bodies remain the success and receipt-evidence controls. Synthetic fault controls test abort-ignoring fetch/body, all nine keys, late settlement, exact cumulative deadline and parseable oversized bodies. No rank gain or fresh on-chain observation is asserted by these tests.
