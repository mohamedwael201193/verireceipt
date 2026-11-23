# Research Desk handoff

Updated 2026-11-23 04:03 Africa/Cairo.

## Reviewed remote tips

- Core: feat/m13-research-core at 5aa13cb454c54819c36cf9f7a815d8b6bd956105.
- Adapter: feat/research-live-adapter at c1396663d92dc2c7b62667141bb6e7ac0476d7ae. Independent implementation KEEP, 617 tests and five mutants. Push was fast-forward from 051227de; remote hash verified.
- Viewer: feat/research-hold-view at f18fd641cbb396db0384f3687715859b165a2409. Independent implementation KEEP. Remote hash verified. Independent settled-zero test reproduced RED before neutral-cost wording fix, then both independent tests and six worker tests passed.

The viewer and adapter are separate lineages. Neither is merged to main or deployed. No new paid run is authorized. Hosted spending and retention remain disabled. Testnet only.

## Real-run evidence

A1 and A2 remain immutable HOLD packets. A2 has usable price and total supply, exact implied FDV, withheld TVL, and unknown FDV/TVL. TVL's shaped value does not exactly equal its signed provider value. The diagnostic change preserves that failed equality separately and never makes the raw candidate usable for arithmetic. As observed in the two immutable run packets at run time, A1+A2 reserved/reported 60,000 micro testUSDC, with no settlement assertion (not a current ledger balance claim), no on-chain transaction, no escalation or reuse. Private paid-response files must not be published.

## Proposed next steps, not execution approval

1. Review a merge commit joining exactly the approved viewer and adapter tips on a new integration branch. Run full Desk/frontend suites, typecheck/build, wallet-free replay controls and visual checks. Add a read-only rendering of rejected raw observations if desired, but it must be a separately reviewed functional change. Push/deploy only after independent KEEP.
2. Review the TVL ranked-provider design note below before implementing selection or running another paid packet.

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


## Afternoon continuation, 17:32 EET

Integration merge f1409d2c7a898d43834e808a33c2fb05248057ad is unpushed and in independent review. Exact approved adapter + viewer parents, no conflicts or functional edits. Desk 617/617; frontend 9941 passed + 1 skipped + 1 inherited dashboard YAML snippet parity failure (9943 total) reproduced on exact approved UI parent (30/31). Typechecks/build pass. A2 offline/public replay remain false/HOLD as expected.

Live authoritative leaderboard at epoch 44 has no TVL ranking. Contract proposal is docs/research-ranked-provider-contract.md. Do not invent ordering from catalog history. Retain auto-route + honest HOLD until rank exists. No new paid run or deploy.


## Reviewed integration and real A/B, 2026-11-23 17:41 EET

Provenance for this entire section: all execution, safety and account-state claims are builder-reported, not independently authenticated. This includes the executed code and payer, preflight checks, absence of other signers or on-chain transactions, SEC contact exclusion, temporary key deletion, and remote/ledger state. Independent code review does not authenticate those operational claims.

Builder-reported local outcome: reviewed stack through e21152562283efebcd4df3cc721cd17018019c8c pushed to feat/research-integrated by pinned non-force refspec; fresh ls-remote matched at push time. No main merge or deploy. HANDOFF parent and exact two-passage correction diff were verified against the reviewed patch. Current remote state may change after that check.

Fresh A3 and B1 ran on that exact detached reviewed commit, existing approved payer and existing shared ledger. Epoch44 preflights were safely more than 90 minutes before the boundary; no other signer was detected and main confirmed no registry signer active/imminent. No on-chain transactions, escalation or reuse. Runtime SEC contact stayed out of repository, logs and final packets. Temporary key files deleted after each run.

- A3: frozen spec 5a34bcd63536d45281e86c48211e05951a865159e21d250475851da9c2c7f320; packet 0013618f9505aa7f1da7c4da369e981562e8dddbfe4df3c1e25de81b661164d7. HOLD. 27.942 seconds frozen-to-complete. Price 5.1606 accepted external L1. Supply 885496418.7861971 rejected against whole-token on-chain total supply. TVL shaped3101186272.66 versus provider3101186272.6553764 rejected, raw diagnostic only. No final calculation. Reserved/reported30000 micro testUSDC, wasted20000, uncertain0, no settlement assertion.
- B1: frozen spec 605fb0f3fe14899e7dc32860681ecf2875914a7751e7b086779b3862303a289f; packet 0c2b8368a9a00514630e86b1850ccbdcc8841cbb05406a52936ac56cf55f847c. HOLD. 32.066 seconds frozen-to-complete. TSLA393.103 and US2024 unemployment4.022 accepted external L1. Filing_count3 rejected because provider filing assertions did not bind to SEC rows. Reserved/reported30000 micro testUSDC, wasted10000, uncertain0, no settlement assertion.

This pair: adapter-reported acceptance3/6, not independent truth or receipt certification and not audited accuracy; useful completed notes0/2. Both offline and public wallet-free replays return false/HOLD. Public replay exits at offline HOLD gate, so partial accepted facts are not independently replayed by that command. As-run packets are immutable. Do not tune gold, tolerance or selectors after seeing results.

Post-run live account snapshot observed available1420000, unbilled60000, rootbalance1480000 micro testUSDC; not a claim of final settlement. Today's A1+A2+A3+B1 research reserved/reported total120000 micro testUSDC. Existing shared ledger remains intact.

Private run directories: /home/sandbox/research-evidence/template-a3-20261123T1538Z and template-b1-20261123T1539Z. Raw paid replies include signed transport material, do not publish. Sanitized final packets, failures, receipt hashes and replay outputs were transferred to main as research-ab-public.tar.gz. No more spending to chase READY is planned. Next: read-only diagnosis of supply definition and filing-assertion binding, followed by independently reviewed changes only if justified.


## Unreviewed parser slice, 17:50 EET

Implementation pending independent review: SEC reportDate retained/validated separately from filingDate, anchored issuer+CIK and report-period title grammar, structured recent assertion binding, duplicate report-date consistency, public replay rechecks hash-bound provider assertions against stored SEC bytes. Template/UI label tightened to Ethereum-contract implied valuation, not aggregate economic FDV. No paid run or retroactive result change. Existing real packets remain unchanged.
