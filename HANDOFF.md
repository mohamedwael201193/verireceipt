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

## Holder 429 fallback, slice F

Implementation commit: `e8c19f95a88b0ed5970dac36a692279bcb9277fb`.

- GeckoTerminal observations are retained process-locally, with a five-minute
  normal cache TTL. Cached body bytes and acquisition time stay paired.
- HTTP 429 can reuse only an eligible prior real observation. The handler
  revalidates identity, count and the 24-hour provider source-age bound.
  Fallback does not refresh the original body, source time or cache age.
- Answers identify the result as stale and disclose the original source
  timestamp. Receipts retain the original raw body and disclose the fallback;
  health records the GeckoTerminal error rather than a Blockscout failure.
- A cold process has no retained observation to fall back to. Cache is not
  persisted across restarts. No estimated count or seeded observation is used.
- A 429 starts a process-wide cooldown of at least 60 seconds. Existing
  request-budget, queue-cap and pacing protections remain in place.

This slice does not establish that a deployed process has a usable retained
observation or that upstream rate limiting has ended. Check those separately.

## Route answer ordering, slice D2

Implementation commit: `2ef1f931cc660a258c9425421e5da81dfd299677`.

When an aggregator observation is present, ETH/USDC prose leads with the
reported `amount_out` in base units and USDC, before gas. It names the lower
median convention before describing the baseline route: the block-pinned
venue baseline is one observation and an eligible Velora quote is the other.
With two surviving observations, use the lower actual quote, not their
average. Best single route and reported aggregate remain distinct.

This is a prose-only change. Numeric output, source eligibility, receipt
shape and non-aggregator prose are unchanged. The focused route suite passed
31 tests across route-aggregator, route-explanation and
route-persistence-required; TypeScript and diff checks passed.

Main was verified at `2ef1f931cc660a258c9425421e5da81dfd299677` by an
uncached `git ls-remote` check on November 23, 2026. Slice F,
`e8c19f95a88b0ed5970dac36a692279bcb9277fb`, is an ancestor of that commit.
The deployment handoff at 17:02 EET reported F live as
`dep-dc258juk1f9s738gc52g` and D2 not yet deployed. Neither slice changes
`miner.yaml`. Deployment is separate and was not performed by this handoff
update.
