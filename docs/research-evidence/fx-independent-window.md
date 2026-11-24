# USD/EUR and USD/CAD independent-origin window

Raw bodies in tests/fixtures/fx-independent-window were fetched November23,2026 at17:27:07UTC. provenance.json records the exact observed source URLs. Bodies are unmodified. Values are source observations, not inferred evaluator truth.

| USD buys | Existing served rate | New scoped rate | Unscoped full independent median | 40bps window median |
|---|---:|---:|---:|---:|
| EUR |0.91416|0.911134|0.91156115|0.911134|
| CAD |1.4362|1.433905505|1.433905505|1.433905505|
| SEK |10.272877|10.272877 unchanged|10.243955485|10.269803985|
| USD |1|1 unchanged|1|1|

No new40bps threshold is used. Existing0.5% complete-span cap remains. EUR whole pool spans56.45bps and SEK77.97bps, so the full independent median cannot honestly be called a median of agreeing quotes. CAD whole pool spans31.31bps.

The scoped rule applies only to same-date USD->EUR and USD->CAD, shared by conversion and FX_NOW. It selects the window with most known distinct origins whose full high-low relative span is<=0.5%, then smallest relative span, then lower starting rate. At least two origins are required. Frankfurter and vatcomply count once as ECB republications. Public and keyed ExchangeRate-API count once as a known shared provider. Other named providers are distinct known origins, not a claim that their underlying price discovery is wholly independent. Frankfurter is the stable ECB representative where available, otherwise vatcomply. The public ExchangeRate-API quote represents its provider when both public/keyed quotes exist.

Odd count serves the observed middle rate. Even count serves the arithmetic mean of the two middle observed values, disclosed as a calculated midpoint, never attributed to one provider. Receipts retain all fetched bodies and quotes, selected median inputs and policy text. Every fetched ECB reference includes its actual rate and signed bps distance to the served median. Equal-support tie resolution is disclosed.

SEK window output10.269803985 differs from its current10.272877, so SEK is deliberately unchanged under the request to preserve a currently successful selection. USD and all other/reverse/cross pairs retain existing behavior. Different-date freshest behavior is unchanged. No selection policy is changed based on inferred evaluator truth. Parent-reported epoch41/44/45 scores are historical attributed findings, not new raw quote evidence or proof of future score improvement. No dated historical replay claim is made without original source records.

Existing tests based on earlier same-day raw bodies now explicitly expect the new EUR/CAD selection while preserving SEK. New tests use the17:27 raw bodies, cover both routes, raw evidence/hash parity, duplicate origins, even midpoint, full-span nonchaining and unchanged different-date behavior. No production request, deploy, registration or signing is included in this slice.
