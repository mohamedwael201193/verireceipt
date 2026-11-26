# FX value policy

FX_NOW_EUR, FX_NOW_CAD, FX_NOW_SEK and USD conversions to those currencies serve the ECB reference rate as the value. If the first ECB-based source is down, the other ECB-based source is served before any other. Only when neither answers does the previous agreeing-majority median of the remaining observations apply, and it still refuses when there is no majority.

The other observations are a cross-check only. They are listed in the answer and in the unscored keys value_basis and cross_checks with their dates and signed percentage gaps, and any source more than 1% from the served rate is flagged by name. A cross-check never changes the served value and never refuses the answer. The rate date of the served source stays in the answer. Contract enums and ranges are unchanged; confidence is 0.9 when the fallback source serves or no cross-check was available, otherwise 1.
