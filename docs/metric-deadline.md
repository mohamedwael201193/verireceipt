# Metric deadline

The finalized-state workflow has a single nine-second budget. Each RPC fetch and body read has a rejecting timeout of at most 1.8 seconds, clipped to the remaining workflow budget. Abort is attempted but is not the timeout mechanism.

A source URL remains occupied until its underlying fetch/body operation actually settles, including after timeout. At most one operation per URL may run; the additional sixteen-operation guard is defensive and exceeds the current eight reachable URLs. Later workflows refuse occupied sources instead of building an unbounded queue. Late results cannot create receipts.

Two providers must still agree on finalized block hash, balance and nonce for either requested metric. Numeric units and the quorum doctrine are unchanged.

Synthetic tests cover ignored abort, stalled bodies, ownership retention and the cumulative deadline. Three mutation controls remove the rejecting timeout, ownership gate or cumulative budget, respectively. Each is rejected by the tests.
