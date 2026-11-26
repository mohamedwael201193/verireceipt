# Equity volume: no extra source I/O

The financial handler derives optional trailing24h volume only from the already acquired canonical Yahoo chart. It never fetches an additional5m chart. The current shared chart has daily granularity, so volume_24h_usd is null with an explicit unavailable reason. The daily session-times-price estimate remains separately labeled and is never substituted for24h volume. The pure5m parser remains usable if a future canonical observation contains validated intraday data. Source URL, raw body and acquisition time remain attached to that exact observation.

This deliberately removes the equity24h-volume coverage added by63087293. It avoids extra Yahoo rate pressure, shared cooldown activation and optional-read latency. Existing stock/search cache and429 expectations were not weakened. No change to the canonical1d chart URL or cache policy.

Contract checked26November2026: only market_cap_usd is marked scored and encoded on-chain; volume_24h_usd is off-chain. The current epoch58 leaderboard shows this miner at score0, rank8. The leaderboard gives no per-case or per-field grades, so neither the score cost of null volume nor a gain from the earlier5m read can be quantified from it. Judgment evaluation could still consider off-chain answer quality. No claim of a zero score cost.

Sources:
- https://devnode.telegraphprotocol.com/engine/v1/intents/FINANCIAL_DATA_GENERAL
- https://devnode.telegraphprotocol.com/leaderboard/miners?intent=FINANCIAL_DATA_GENERAL&limit=1000
