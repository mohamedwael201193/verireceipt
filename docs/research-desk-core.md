# Research Desk core, v1

Mission 13, Route 1: open research with receipts. This is an additive local
core milestone, not a claim that both live templates are complete.

The frozen spec separates numeric observations from analyst assumptions.
All facts bind exact intent, params, field, unit and freshness. The schema
snapshot records the official live contracts captured on 23 November 2026.
A snapshot is not proof of successful purchases. Recheck lifecycle/schema
before every live run. The app buys ranked network supply; own registered
supply and external serving registrations must be distinguished honestly.

The arithmetic uses exact rational integers. Price times total supply is
`implied_fdv`, never circulating market cap. Yield is basis points. The
macro contract permits unemployment rate only, so there is no inflation,
policy-rate or real-yield formula here. Liquidity means pool reserves, not
slippage. Unsafe or undeclared units, inputs and calculations are refused.

Packets carry source bytes, digests, historical timestamps, receipt/signal
identifiers, separate schema/receipt/semantic/primary checks, cost per fact,
and explicit fresh-receipt reuse. A source digest alone does not establish
source truth. L1 signal integrity and L2 raw-byte integrity are labels, not
substitutes for scope verification. Missing evidence produces HOLD. A false
numeric claim produces NOT_SUPPORTED when all required evidence stands.

The orchestration adapter contract requires durable shared-ledger and
per-note reservation before a signature. Frozen specs are written before
purchases. At most one escalation is permitted per note, only for a known
failed first purchase. Unknown signed outcomes cannot be retried. A thrown
adapter error is not treated as free. The adapter must durably record that
uncertainty before throwing. Existing Desk escrow, raw-response capture and
reservation code remains the paid path.

The ledger separates reserved exposure, node-reported charge, and observed
settlement. Unsettled reservations count at their ceiling. Wasted failed
attempts and unknown outcomes remain in the cost of a useful note. HOLD
has no cost-per-useful-note denominator. Reuse shows zero incremental cost
alongside its original acquisition cost, not free original evidence.

## Offline verification

`npx tsx desk/scripts/replay-desk-packet.ts research-packet.json SPEC_SHA256`

This command has no wallet or network dependency. It checks stored-byte
digests, packet consistency, fixed spec hash, calculations and historical
freshness. It does not authenticate source origins or recheck live payment
records. The existing `desk` `judge:verify` historical SEC command is left
unchanged until the new live multi-fact evidence adapter is ready.

## Milestone limits

Both full live templates still need source parsers and live public-evidence
revalidation wired to the existing paid path. No sample numeric output is
published as a live demo. Tests use explicitly labeled unit fixtures only.
The four required failure controls are unit-level demonstrations at this
stage: changed source, unavailable observation, invented numeric claim,
and revised analyst assumption. Real purchased runs remain to be collected.
Hosted-mode spending and retention remain disabled. No on-chain transaction,
public posting, push or deployment is part of this core milestone.
