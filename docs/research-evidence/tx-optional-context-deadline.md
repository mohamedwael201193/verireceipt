# Optional transaction head context

24November2026. Confirmed/reverted transaction quorum status, block number, value and receipt vote text unchanged. Optional eth_blockNumber head reads now have real700ms deadlines covering fetch and streamed body,10KB byte cap. Calls remain sequential, same providers, no retries or added fan-out. Up to3providers means optional work settles within2100ms of its own start, excluding local execution overhead. Failed optional context returns confirmations=null rather than changing the transaction vote.

Each underlying head read retains per-URL ownership until it settles, including ignored abort. At most16active head URLs, same URL cannot be reissued while draining. Late I/O cannot mutate returned evidence. Permanent I/O does not cause accumulating background calls across requests. No live provider availability/leader timing claim; failure was reproduced offline.

Shipped tests cover ignored abort, stalled body, late evidence immutability, oversized valid JSON, actual confirmed handler retaining block/value/quorum, and sibling persistence. Initial body-cap mutant survived; a valid oversized JSON control was added and it now fails.
