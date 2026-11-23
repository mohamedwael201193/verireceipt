# Exact npm package advisory review

Contract read November 23, 2026:
https://devnode.telegraphprotocol.com/engine/v1/intents/SECURITY_REVIEW_GENERAL

Active response format v3 takes target and returns verdict,
vulnerability_count, issues and summary. This implementation supports only
exact npm release package@major.minor.patch, with optional npm: prefix and
scoped package names. Code, sites, contracts, tags, ranges, prereleases and
other ecosystems are refused. No source code or package is downloaded or run.

Source documentation: https://google.github.io/osv.dev/post-v1-query/
API: https://api.osv.dev/v1/query

OSV query matches can be fuzzy. Each active returned record must therefore
also name the exact npm package, carry valid publication/modification times,
and check the requested stable version via explicit versions or SEMVER
ranges where interpretable. Numeric bounds of one to three components are
zero-padded; disjoint intervals are ORed. An unparseable bound does not
discard other records: that record retains OSV query membership with an
explicit local-range-interpretation-unavailable disclosure. A locally
interpretable range excluding the version, incomplete pagination, identity
mismatches and malformed evidence fail closed. Unique OSV IDs are counted, not aliases;
this may differ from distinct vulnerability root causes across databases.
Published severity categories order issues; missing severity is unspecified.

A positive advisory match returns Needs changes, not a full security verdict.
No records or only withdrawn records returns NO_ADVISORY_COVERAGE, never
Secure. The endpoint does not scan transitive dependencies, source code,
configuration, exploit reachability or undisclosed flaws.

Five-minute process cache retains original fetch time. A 30 starts/minute
process budget, four-second upstream timeout and 1MB response cap bound the
source. Raw upstream evidence is retained verbatim, including its references;
those references are not surfaced as answer links or treated as instructions.
No credentials or private data are submitted.

Live qualification observed semver 7.5.1 -> one active GHSA record (CVE alias),
semver 7.7.3 -> no advisory coverage. Exact unmodified upstream fixtures are
under tests/fixtures/osv-package. Local stored receipts were rehashed. This
is not a production or registration claim. Manifest activation is separate.
