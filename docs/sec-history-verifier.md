# Independent SEC history replay

The backend keeps every history page it checks in the receipt, including bounded neighboring drift probes. The Desk verifier independently derives that source selection before replaying the committed page bytes. Extra evidence is not silently discarded to obtain a green result.

For one calendar-year request:

- Required pages overlap the year with seven days of metadata-date slack on either side, at most 25 pages.
- One nearest non-overlapping page before the year and one after it are also checked when their boundary is within 366 days. Maximum total: 27 pages.
- If distinct manifest pages tie at the nearest boundary, exactly one tied probe on that side is accepted. Arbitrary further-away pages are not accepted.
- Names must belong to the requested CIK and be unique. Manifest dates must be real calendar dates. Every selected page must have a positive integer manifest row count.
- The response must contain all required overlap pages and exactly the bounded probes, without duplicates or foreign URLs. Missing pages remain HOLD.
- Every stored page is fetched only through the fixed receipt endpoint. Its SHA-256, row count and actual filing dates are checked against its committed digest and manifest, including the seven-day date slack. Counts are computed independently after accession deduplication and conflict checks.

This corrects a false-HOLD class where the backend supplied a valid neighboring or slack-boundary page but the verifier demanded only strict overlap. It does not change the backend fetch policy, suppress evidence, make a paid request, deploy a service or change registration.

The regression tests use explicitly test-only source fixtures, including an actual backend-to-Desk replay through intercepted fetches. They are not live filings or purchase evidence. A fresh direct SEC metadata probe during this work returned HTTP 403, so a current live Tesla-2019 result is not claimed.

The proof remains bounded: source bytes are hash-checked and independently parsed, not independently authenticated as SEC truth by a second network fetch. Calendar filing dates are not fiscal reporting periods, and a filing count is not legal compliance or an investment recommendation.
