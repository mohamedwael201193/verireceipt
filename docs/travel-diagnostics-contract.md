# Travel diagnostics contract repair

This follow-up aligns the sibling diagnostic suite with the already-published travel answer contract. Missing and oversized inputs remain refusals with closed `missing` and `invalid` classes. A bare flight number and an unknown place return disclosed unverified answers with null disruption and zero confidence, without fetching airport status. New York has the closed `metro` class. Metadata stays out of answers and stored evidence.

The only handler change is wording: explicit airport-code routes no longer claim static metro expansion. Actual metro names retain the disclosure and complete airport list.

## Verification

- Root test inventory: 264 unique `tests/**/*.test.ts` files.
- All 264 files exercised successfully in bounded chunks and whole-describe partitions: 5,470 passing executions in the final selected gate, no assertion failures. This is not an unfiltered live-network integration pass.
- Ordinary chunks cover 262 distinct files. The remaining route and transaction files passed whole-describe partitions with 338 passing tests (222 route and 116 transaction). Whole-describe partitions preserve dynamically registered tests that individual-name selection missed.
- Ordinary chunks report 199 skipped tests. The transaction partitions exclude four live-network transaction describe groups containing 11 tests and two live-network route describe groups containing eight tests. Skipped counts from partitions are not summed because every partition skips other partitions' tests.
- Earlier chunks excluded uppercase LIVE names; later chunks excluded live case-insensitively. Some earlier lowercase-live tests therefore ran and passed. Whole-describe route groups include deterministic tests whose names mention live observations. Conditional database skips remain conditional, not verified database integration coverage.
- Oversized aggregate attempts exceeded execution time limits without assertion failures; final bounded reruns supersede those incomplete attempts.
- The repaired diagnostic suite passes all 15 tests after mutation restoration.
- Eleven isolated mutants fail: explicit-route wording, unknown null/verdict/confidence/reason, missing/invalid/flight/coverage/metro classes, and raw refusal telemetry.
- Source TypeScript compilation and whitespace diff checks pass.

No backend deployment, registration, transaction or purchase is part of this patch. Existing paid-research ledger changes are excluded.
