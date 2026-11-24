# Transaction status context

Core transaction/receipt quorum, status, value and existing method_selector stay unchanged. Adds a one-line status_statement and self_transfer flag from address comparison. contract_call means nonempty calldata to a destination, not verified runtime contract code; its scope field names that distinction. Missing transaction gives null flags.

Optional confirmations is exact latest-block quorum height minus inclusion block, counting blocks after inclusion (inclusion block itself zero). Same configured RPCs, at least two identical numeric heads, behind/errored/split heads produce null without replacing core status. Full raw head responses are included as confirmation_context inside existing canonical tx/receipt evidence only when a confirmations value is served. Core tx and receipt keys remain unchanged. Null optional context retains the previous evidence bytes exactly.

Real two-provider head responses agree on0x1940e78. Confirmations are not a finality guarantee. No new network source, signing or keys. Extra head polling can add latency; source failures remain optional, never fabricate a number.

Independent receipt reproduction: fetch the saved evidence bytes to preserve the moving-head observations, verify each head raw JSON-RPC result against its recorded numeric height, independently recalculate its exact two-source quorum and confirmations, and combine that context with fresh immutable transaction/receipt RPC results using stableStringify. The whole receipt digest must match. Re-reading latest head later is not reproduction of the original observation. Both live recomputation controls follow this procedure. A persistence-level stubbed control also pins the original exact canonical bytes when context is null.
