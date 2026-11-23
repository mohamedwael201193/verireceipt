# Event-outcome Wikipedia fallback

The fallback runs only when Polymarket search succeeds but has no matching market. Ambiguous, unresolved and malformed matched markets retain their existing refusals.

This slice supports exact dated United States presidential election titles for past years, optionally phrased as a who-won question. It requires a unique exact Wikipedia search title, a standard summary with the same title, an election-winner description and an unchanged past-tense sentence that names that winner before the word "defeated". Negation, conditional language, current/future years, arbitrary propositions, extra conditions and unsupported event families are refused. Search ranking alone is never identity evidence.

`outcome: yes` means the named event completed with the cited winner, not a guessed answer to an arbitrary yes/no proposition. The answer labels its single-source scope and 0.75 confidence. `resolved_at` stays null because this parser does not establish the settlement date. It is not the article's edit timestamp. Each search/summary call has a 2500 ms network bound and 200 KB cap. Exact raw primary, search and summary bodies are retained in the receipt.

## Real capture and smoke

Captured 2026-11-23. The direct local-handler live smoke returned Joe Biden for the 2020 United States presidential election, using the explicit summary statement. This is a local live-source smoke, not a production deployment.

- https://gamma-api.polymarket.com/public-search?q=2020%20United%20States%20presidential%20election&limit_per_type=3
- https://en.wikipedia.org/w/rest.php/v1/search/page?q=2020%20United%20States%20presidential%20election&limit=3
- https://en.wikipedia.org/api/rest_v1/page/summary/2020_United_States_presidential_election
- https://en.wikipedia.org/wiki/2020_United_States_presidential_election
- https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use

English Wikipedia contributors are credited under CC BY-SA 4.0. The source sentence is unchanged. Attribution and article URL travel in the answer and receipt.

Eighteen event tests pass, including retained Polymarket controls, captured-body fallback, independent evidence digest, unsupported conditions, duplicate search identity, prospective/negated/contradictory text, future dates and persistence failure. Identity, negation and winner-evidence mutants are killed. Build passes.

Generic sports summaries tested during research did not state winners, so sports support is deliberately not claimed. Additional event families need their own evidence parser and regression controls.
