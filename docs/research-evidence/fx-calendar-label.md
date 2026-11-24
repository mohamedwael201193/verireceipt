# FX ISO calendar-label validation, 2026-11-24

Date.parse accepts impossible ISO days such as February30 by normalizing them
into another month. Source labels feed freshest-day selection, so that silent
rollover can mis-rank a quote. The three existing ISO-date providers (Frankfurter,
vatcomply and Fawaz) now reject an impossible YYYY-MM-DD when a covering rate is
otherwise present. Valid leap days pass. Real accepted source fixtures remain
unchanged and their selection/receipt replays pass.

This is deliberately not a freshness-policy rewrite. Unknown, missing, differently
formatted and RFC-style labels retain existing behavior, including day0 for
unparseable labels. Future-but-calendar-valid dates are not refused. No new age
cap, max skew, rate winner rule, provider or intent is introduced. Future labels
and stale quotes under false fresh labels remain a known limitation requiring
separate policy review. This narrow boundary catches calendar impossibilities,
not source truthfulness or historical scoring failures.

Synthetic controls cover non-leap February29, February30, invalid month/day,
November31, valid century/leap days, old dates, unknown and future dates.
Independent removal of each provider's guard must be red. Accepted actual
bodies are the existing fx-same-day/fx-independent-window captures; no new live
capture or score benefit is claimed.
