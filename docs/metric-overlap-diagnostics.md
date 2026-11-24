# Metric overlap diagnostics only

concurrent_identical_in_flight is a closed completion category: some when this validated workflow overlapped another workflow with the same normalized address, numeric block, resolved chain and requested metric; none otherwise. Both workflows in an overlapping group report some, including the earlier arrival. Once all group members settle, the entry is removed, so later isolated requests report none. Invalid input is rejected before tracking and receives no overlap category.

This counts overlap across source I/O and receipt persistence; a stalled database write can therefore contribute overlap. It does not prove that source requests overlapped, that a shared flight would have helped, or that a historical burst used identical questions. Keys stay process-local and are never logged. Only none/some is emitted, no count, key, address, block, URL, hash or raw error.

No coalescing, admission limit, queue, cache, timing, quorum, source, evidence or response change. Each caller still executes its own existing workflow. The reviewed coalescing candidate is parked and excluded from this commit.
