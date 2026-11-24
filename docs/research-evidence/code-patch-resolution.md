# GitHub reference resolution

Captured2026-11-23 from the live unauthenticated GitHub REST API:

- VeriReceipt repository default-branch HEAD endpoint.
- Actions checkout repository, Actions run45008024904 endpoint.

Raw bodies under tests/fixtures/code-patch preserve default HEAD and Actions head_sha examples. Repository input resolves through commits/HEAD, pull input through pulls/N, Actions input through actions/runs/N. A symbolic or short commit ref resolves once before reading checks/status for its full SHA. Every request uses at most3 API calls. Responses cache60 seconds in a128-entry bounded map; evidence retains the oldest underlying check/status acquisition timestamp. Pagination incompleteness prevents an all-green pass. Free text is disclosed neutral/passed=false without retrieval or fabricated CI.403/429 return503. YAML unchanged.
