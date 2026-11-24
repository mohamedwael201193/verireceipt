# Stock source timestamp and result boundary, 2026-11-24

The existing Yahoo chart adapter accepted any finite numeric market timestamp,
including negative and far-future timestamps. Very large finite values could
also throw during ISO conversion instead of yielding the intended source error.
It selected the first result even when more than one instrument was returned.

It now requires a single chart result and a positive integer Unix timestamp
representable as a date, no more than 60 seconds ahead of the read clock.
Invalid result/time returns YAHOO_BAD_BODY. The prior session's real timestamp
is preserved on closed markets. No arbitrary maximum age, fresh-as-of rewrite,
new provider or price-basis change is introduced. The price remains Yahoo's
regular-market quote, explicitly delay-labelled, not an after-hours price.

Actual source and captured metadata:
https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d

The slice reuses the already accepted real AAPL body, without introducing a new
source fixture. A reviewer encountered HTTP 429 on Yahoo and stopped. No further
source retrieval or alternate access was attempted for this revision. Altered malformed,
multiple-result, negative, fractional, overflow and future timestamps are test
controls, not provider evidence. This is a demonstrated source-validation fix,
not evidence that timestamp validation caused a historical score gap. Exchange
scope is unchanged pending a grounded venue mapping; USD+EQUITY alone has not
been expanded into a claim of complete US listing coverage.
