# Bounded source reachability observations

24 November 2026. Health responses expose the last named-source transport observation under source_reachability, separately from handler-derived upstream health. They launch a nonblocking check when eligible, never await it, and never fail because of it. This is reachability, not validation of source data or a safety clearance.

CoinPaprika uses https://api.coinpaprika.com/v1/tickers/eth-ethereum. One source gate, process-local single-flight, at least sixty seconds between starts, two-second hard deadline including fetches that ignore cancellation. Redirects refuse, response bodies are canceled without reading. A 403 or 429 halts further probes in that process, without proxying or retries. No background polling loop. Process restart resets the observation and rate state. Existing multi-process deployments would each have their own gate.

Source terms remain the existing CoinPaprika dated terms-risk record. This adds no redistribution licence or assertion that production egress can reach it. A reachable status means a successful HTTP response header was observed, not that a particular ticker field is current.
