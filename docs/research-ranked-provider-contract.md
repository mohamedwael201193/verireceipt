# Status update, 2026-11-23 17:32 EET

Design only, not implemented. The authoritative leaderboard endpoint now resolves the ranking question: filtered TVL at epoch 44 returns an empty intents object. Do not synthesize a ranking from older catalog rows. Keep auto-route with honest HOLD and no escalation until a usable current ranking exists.

Official MCP source labels this endpoint the latest-epoch ranking, and describes an unranked intent as model-selected routing. Sources: https://github.com/telegraphprotocol/Telegraph-MCP and https://devnode.telegraphprotocol.com/leaderboard/miners?intent=TVL_LOOKUP_GENERAL&limit=1000 . Read-only snapshot checked 2026-11-23 17:31 Africa/Cairo. This is a bounded live observation, not a permanent claim that TVL will stay unranked.

# TVL ranked-provider contract proposal

## Goal and non-goals

A new frozen Template A may obtain an honest usable TVL, but cannot be promised clean in advance. A1/A2 stay HOLD. Do not round the provider value, relax exact shaped/raw equality, substitute diagnostics into calculations, or cherry-pick a provider based on a desirable answer.

## Proposed selection rule

Freeze the discovery response hash, exact intent/params/unit, eligible registrations and their verified ranking evidence before a paid call. Require active canonical compatibility, a binding between catalog identity and on-chain serving registration, explicit quote/budget caps, and an auditable complete ordering for the eligible set. Exclude own supply only if the spec explicitly requires external supply. Provider-specific parsing must be declared before seeing a paid result.

Select the first eligible provider under that ordering, not a hardcoded winner or a provider chosen after inspecting its value. Submit a direct canonical request to the discovered ID and bind the receipt to the frozen registration set. Label this client-selected ranked discovery plus direct delivery, not network auto-routing. Existing auto-route selection and direct selection are different modes and must not share misleading labels.

After a definite verification failure, allow at most one next-ranked distinct registration only when the frozen spec and owner-approved budget cover it. A signed unknown outcome is never a verification-failure retry opportunity. Reserve both attempts against the shared ledger as required; keep the rejected first expense, failure and diagnostic visible. Stop after that single escalation even if no usable TVL results.

## Mandatory acceptance

Unchanged receipt/signal and raw-byte chain rules; exact finite-decimal shaped/raw equality; exact protocol selector, USD unit and timestamp/freshness checks; independent primary-source verification under the existing declared tolerance, without changing tolerance to fit observed data. Independent source read must not simply trust the provider's claim. All failed layers remain failures. A fully accepted fresh observation alone enters arithmetic. Full packet and wallet-free replay must both pass before calling the run clean.

## Live findings and unresolved ranking gap

Current official docs distinguish automatic ranked routing from direct canonical delivery. Budgeted automatic recovery targets missing or incomplete fields; it is not a documented consumer-verification-failure or distinct-registration exclusion contract. Raising the auto budget alone therefore does not solve A2's rounded but present TVL.

The live intent exposes compatible providers and mapping type, including code mappings, but that is not proof a provider preserves precision or will pass. Catalog score rows carry intent, rank, score, epoch and timestamp, while this inspected response has mixed historical score epochs. Neither array order nor a provider description establishes a complete current ranking. Before implementing the proposed direct mode, verify ranking semantics and completeness from the authoritative discovery documentation/API. If that cannot be established, do not invent an ordering. Keep existing auto-route plus honest HOLD, or request an explicit scope change to a separately labeled deterministic provider-selection policy. A mapping-type preference alone must not be described as Telegraph rank.

## Risks and tests

- Precision may still be lost by the node even with a different provider. No passing result is guaranteed.
- Discovery/ranking can change between freeze and sign. Revalidate identity, compatibility and quote; fail closed on changes beyond the frozen contract.
- Scores from different epochs, missing score rows, ties and aliases can make ordering ambiguous. Freeze explicit tie/missing rules only after source semantics are confirmed.
- A distinct registration is not proof of independent source/operator. State this limitation and do not count two registrations as independent truth verification.
- Selecting after viewing values would be outcome shopping. Freeze selection before payment and test mutation/reordering controls.
- Paid escalation needs a new adapter route, complete expense accounting and replay bindings, not just a runner flag.
- Shared-source TVL changes can cause primary mismatch. Preserve the declared freshness/tolerance contract and HOLD rather than tuning it after the result.

Required controls: malformed/missing/stale ranking; tied/missing ranks; own-provider exclusions; alias identity mismatch; selected-provider substitution; quote/remaining-budget excess; first verification failure with one distinct escalation; unknown first signed outcome with no retry; second failure with HOLD; diagnostic cannot enter arithmetic; receipt/provider binding; unchanged A1/A2 replay behavior.

## Sources checked

- https://docs.telegraphprotocol.com/docs/using/engine-ask.md
- https://devnode.telegraphprotocol.com/engine/v1/intents/TVL_LOOKUP_GENERAL
- https://devnode.telegraphprotocol.com/api/miners
- https://devnode.telegraphprotocol.com/api/miners?intent=TVL_LOOKUP_GENERAL&status=active

Read-only checks only. This note is a proposal, not a paid-run instruction.
