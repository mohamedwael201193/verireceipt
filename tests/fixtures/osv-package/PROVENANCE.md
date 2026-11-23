# OSV package evidence

Fetched at about 16:02 UTC on November 23, 2026 from:
https://api.osv.dev/v1/query

POST package name semver, ecosystem npm, versions 7.5.1 and 7.7.3.
These are exact unmodified upstream JSON responses. The first returns one
active advisory record, the second an empty object. Empty is not a Secure
verdict. Tests derive synthetic invalid/withdrawn/dedup controls from the
real advisory; these variants are not claimed as live source data.

Raw upstream evidence is retained verbatim, including upstream references.
Those references are not added to answer text or treated as instructions.

next-13.0.0.json was fetched from the same OSV endpoint with npm next version
13.0.0 at about 16:09 UTC. Its real abbreviated 13.0 range bound is retained.

mongodb-3.0.0.json was fetched at about 16:15 UTC, same endpoint, npm mongodb
version 3.0.0. It retains a real record whose publication time follows its
modification time. Both timestamps remain validated as finite and not future.
