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
