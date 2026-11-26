# Exact npm package advisory review

Contract read November 23, 2026:
https://devnode.telegraphprotocol.com/engine/v1/intents/SECURITY_REVIEW_GENERAL

Active response format v3 takes target and returns verdict (enum Secure,
Needs changes, Insecure) and a numeric vulnerability_count (0 to 100000),
issues and summary. This implementation never invents a value outside that
contract and never issues Secure. Supported targets:
- npm:name@x.y.z, scoped names allowed, queried as ecosystem npm.
- pip:name@version or PyPI:name@version (plain release, optional a/b/rc,
  .postN, .devN; no epoch, local part, range or wildcard), ecosystem PyPI,
  names compared per PEP 503.
- bare name@x.y.z, tried as npm first and PyPI only if npm has no advisory.
- a standalone CVE- or GHSA- id (case-insensitive), looked up in OSV by id.
  A found record returns Needs changes with count 1 and the record facts
  (aliases, affected packages, CVSS strings, references list). The wording
  is a record lookup only; it does not say the caller's dependency is affected.
Everything else is a disclosed refusal with no lookup and no value echoed:
malformed targets are 400 INVALID_TARGET, URLs and other ecosystems are 422
ECOSYSTEM_NOT_COVERED, and an id OSV does not have or has withdrawn is 422
NO_ADVISORY_COVERAGE. No receipt is stored for a refusal, so no label from the
request is persisted anywhere. The log field target_shape (npm, pypi, cve,
ghsa, url, other) records only the classification, never the value.
No source code or package is downloaded or run.

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
PyPI releases with a/b/rc/post/dev suffixes that OSV matched are counted with
the local-range-unavailable disclosure rather than refused.
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

PyPI qualification, November 26, 2026: requests 2.19.0 -> 10 records and
django 3.0.0 -> 41 records via the same endpoint with ecosystem PyPI. By-id
fixtures CVE-2022-25883 and GHSA-c2qf-rxjj-qqgw are exact upstream bodies; OSV
answered 404 code 5 for an unknown id. See tests/fixtures/osv-package/PROVENANCE.md.
