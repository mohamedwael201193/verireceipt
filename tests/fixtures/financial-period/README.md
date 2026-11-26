# NVIDIA SEC annual concept captures

Unchanged public SEC JSON retrieved 2026-11-26. Public company facts, not synthetic observations. Revenues has annual period 2026-01-25, while the contract-with-customer excluding-tax concept stops at 2022-01-30. Both are retained to reproduce the stale concept selection defect.

Sources use https://data.sec.gov/api/xbrl/companyconcept/CIK0001045810/us-gaap/ with these exact filenames:
- Revenues.json
- RevenueFromContractWithCustomerExcludingAssessedTax.json
- NetIncomeLoss.json
- Assets.json

SalesRevenueNet and RevenueFromContractWithCustomerIncludingAssessedTax returned HTTP404 during this check. No error body is represented as financial data. The selector does not add or combine concept values, or infer identical tax/accounting definitions. It reports the chosen concept and period and retains candidate observations.
