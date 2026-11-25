# Validator source latency policy

The handler still waits for every started source that can answer inside the current request budget. A late in-budget dissent remains a conflict. Two agreeing sources are required, and recognized absence still needs two absence votes with no returned validator.

A root-bound source taking at least 3 seconds enters a 60-second slow-source cooldown. This applies to valid slow responses, including an in-budget dissenter, as well as hung calls. It is a general slow-source exclusion policy for later requests, not a claim that a slow source is wrong. An attempt timeout also starts the cooldown.

Ownership spans root resolution, root binding, and the underlying fetch/body workflow until it settles. A caller deadline does not free an unresolved source for another call. After cooldown, a normal probe can recover the source; another slow probe starts the cooldown again.

When fewer than two sources are otherwise eligible, an inactive slow source can be retried to preserve a possible quorum. This never bypasses an active call or a 429 cooldown. Rate-limit and slow cooldowns cannot shorten each other. The optional performance sample budget remains 900 milliseconds.

This is process-local pacing, not a guarantee of a response under a particular latency. A request can still fail closed when current finalized-root or validator quorum is unavailable.
