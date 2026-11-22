# Captured public evidence for verifier tests

`tesla-stored-sec-20261121.json` is the exact, unmodified public stored SEC response fetched on 2026-11-22 from:

https://verireceipt.onrender.com/receipts/rcpt_COU5RNZ6QEOSTT9C796BO1U5IH/raw

SHA256: `62f75fb4293280aef09dc4a5190976f3ca39ca6ad2f7fa1600b0057b708e4150`

Size: 162,971 bytes. The receipt metadata identifies its source as https://data.sec.gov/submissions/CIK0001318605.json and fetched time as 2026-11-21T21:03:17.572Z. It is historical evidence, not a current SEC response. The pinned source is also recorded in the published research packet under `docs/research-evidence/`.

The fixture is test-only and is not imported into the production bundle. Passing tests use its real bytes. Negative tests deliberately alter copies in memory to check refusal behavior. The site never shows those altered copies or calls them real observations.
