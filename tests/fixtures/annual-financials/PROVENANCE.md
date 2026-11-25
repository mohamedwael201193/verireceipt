# Annual SEC financial enrichment

Captured 2026-11-26 from the original SEC companyconcept and Yahoo chart endpoints. The five full JSON bodies are retained as delivered by readable retrieval, without reserialization. The ticker file is a one-row excerpt of the SEC company index. `provenance.json` records URLs and fixture SHA-256 values. These are offline replays, never fabricated live observations.

Annual revenue currently covers the US GAAP RevenueFromContractWithCustomerExcludingAssessedTax concept only. Filers using another revenue concept receive unavailable or no_annual_fact rather than a guessed substitute. Net income uses NetIncomeLoss, assets uses Assets. Each figure carries the actual fact period and filing date, not the filing's fiscal-year label. Latest period is selected before newest filing. Revenue and net income must span 335 through 395 days and come from a 10-K or 10-K/A annual row. Conflicting same-period values are not selected. Annual assets additionally require an independently validated full-year revenue or net-income fact with the same period end, accession and filing date. FY metadata alone never establishes an assets annual period. The supporting duration facts are included in annual_period_evidence.

These are historical annual figures, not current financial position or trailing-twelve-month estimates. Values may have different periods and filing dates. Optional enrichment failure is disclosed per metric and does not invalidate independently acquired market-cap evidence. Facts cache expires after 15 minutes, has 128 entries, and shares the existing maximum of four active SEC source requests with index/shares. Each optional call is bounded by the existing 10-second timeout, without a stale fallback. Original body and acquisition timestamp are kept in receipt evidence. Quote and resolution ages are computed after optional enrichment. Crossing the five-minute freshness boundary reduces confidence and labels stale; crossing the15-minute maximum or exchange quote7-day maximum refuses the answer.

The official FINANCIAL_DATA_GENERAL contract still defines metrics as string. It remains string. Additional structured_metrics contains the typed financial detail. No manifest or registration change is included.

Equity volume_24h_usd remains null. The Yahoo regularMarketVolume field is shares, not traded dollars, and covers the regular session rather than a rolling 24-hour window. The new session USD value is explicitly a price-times-shares estimate. Summing bar close times volume would remain an estimate, not actual trade-by-trade dollar turnover. Bounded investigation found Nasdaq's daily dollar-volume statistics, but those describe aggregate market statistics and do not establish a per-symbol rolling24h value for this contract. No unsupported number is substituted.

Sources:
- https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- https://www.sec.gov/files/company_tickers.json
- https://data.sec.gov/api/xbrl/companyconcept/CIK0001318605/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax.json
- https://data.sec.gov/api/xbrl/companyconcept/CIK0001318605/us-gaap/NetIncomeLoss.json
- https://data.sec.gov/api/xbrl/companyconcept/CIK0001318605/us-gaap/Assets.json
- https://data.sec.gov/api/xbrl/companyconcept/CIK0001318605/dei/EntityCommonStockSharesOutstanding.json
- https://query1.finance.yahoo.com/v8/finance/chart/TSLA?interval=1d&range=1d
- https://www.nasdaqtrader.com/Trader.aspx?id=DailyMarketFiles
- https://devnode.telegraphprotocol.com/engine/v1/intents/FINANCIAL_DATA_GENERAL
