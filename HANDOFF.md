# News expansion handoff

## Terms risk

Google News RSS includes a notice restricting reuse to personal,
non-commercial feed readers. Reuse by this service may fall outside that
permission. Keyless access does not grant reuse rights. Keep this risk
visible during deployment review. No access block may be bypassed.
Source details and fixture capture provenance are in
`tests/fixtures/news/PROVENANCE.md` and `src/handlers/newsSources.ts`.

## Verification scope

Recorded live probes observed headline results for technology, sports and
finance, and search results for the bitcoin ETF query. The crypto probe
observed only the HN fallback. No claim about spacing changing crypto
coverage has been verified. GDELT intermittently returned rate-limit
notices. An unavailable or malformed source is disclosed as degraded.
Empty 200 responses require at least one structurally valid search body;
otherwise both news routes fail closed with 502.
