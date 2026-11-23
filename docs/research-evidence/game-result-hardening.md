# Finished-game score validation

23 November 2026. Contract checked at https://devnode.telegraphprotocol.com/engine/v1/intents/GAME_RESULT_GENERAL. It requires a finished game and integer scores in [0,1000]. Existing captured source: https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261116, retained byte-for-byte in tests/fixtures/game-result/espn-nfl-20261116.json.

The real scoreboard day 2026-11-16 contains an event starting 2026-11-17T01:15Z. UTC-date equality is therefore not a valid local-scoreboard filter. Output now names requested_scoreboard_date and discloses that date is the source event's UTC date. No local timezone is guessed.

Negative mutations of that real body cover blank/null/boolean/array/fractional scores, missing or contradictory winner flags. Missing scores do not become zero. Contradictory finals refuse rather than invent a winner. Impossible calendar dates refuse before fetching. These edited bodies are negative controls, not captured source facts.

League coverage remains NFL/NBA/MLB/NHL, ESPN single source. No manifest, registration, deployment or expanded league coverage in this slice.
