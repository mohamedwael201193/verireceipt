# NVIDIA SEC annual concept captures

Unchanged public SEC JSON retrieved 2026-11-26. Public company facts, not synthetic observations. Revenues has annual period 2026-01-25, while the contract-with-customer excluding-tax concept stops at 2022-01-30. Both are retained to reproduce the stale concept selection defect.

Sources use https://data.sec.gov/api/xbrl/companyconcept/CIK0001045810/us-gaap/ with these exact filenames:
- Revenues.json
- RevenueFromContractWithCustomerExcludingAssessedTax.json
- NetIncomeLoss.json
- Assets.json

SalesRevenueNet and RevenueFromContractWithCustomerIncludingAssessedTax returned HTTP404 during this check. No error body is represented as financial data. The selector does not add or combine concept values, or infer identical tax/accounting definitions. It reports the chosen concept and period and retains candidate observations.

## Intraday volume extension

- nvda-5m.json: unchanged live Yahoo response retrieved 2026-11-26 from https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=5m&range=5d
- nvda-index-excerpt.json: the NVDA entry selected unchanged from the SEC index body in an existing public production receipt, not a fabricated index.
- nvda-sec_shares.json and nvda-yahoo_chart.json: exact source bodies from https://verireceipt.onrender.com/receipts/rcpt_3PV5AVGCQNAHRG7RWGXIU113OD/raw . Chart is the separate regular-session quote, not the new intraday series.

Volume replay freezes acquisition time at 2026-11-26T03:05:00Z. Dollar volume is the sum of complete regular-session bucket closes times bucket share volumes within the trailing24hour window. This is approximate turnover and excludes extended hours. The last incomplete bucket is excluded. Session metadata and every expected complete regular bucket in the window must be present; missing evidence never becomes zero or a prior-session proxy. A closed-market/no-bucket window is unknown, not inferred zero.
