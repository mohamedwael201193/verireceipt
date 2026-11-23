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

## Local paid adapter milestone

`npx tsx desk/scripts/run-research-desk.ts A|B NEW_PRIVATE_OUTPUT_DIRECTORY`
requires an explicitly pinned payer address and the existing testnet secret
path. It reuses the existing escrow Gate path and shared daily reservations.
The CLI keeps raw paid replies, per-fact reservations and Gate proof details
in its private output directory. Research expenses are also written in the
existing shared-ledger row format. No on-chain transaction is sent by this
CLI: an escrow authorization signature is not an on-chain transaction.

The live schema must match the frozen request and numeric response contract,
as well as remain active. Independent source adapters use fixed source
origins, not URLs supplied by a provider. Source bundles preserve literal
responses and, for RPC reads, the exact method/body. Source matching checks:
USD spot pair, USD equity identity and trade time, exact protocol TVL slug,
unique project/symbol/chain base-yield pool, chain/pool reserves, explicit
World Bank unemployment country/year, full-history SEC form recount, and
two chain-bound RPC reads of supply/decimals at the same finalized block hash.
Price, TVL, pool reserves and base APY use a declared 100-bps relative band
between the paid and independent reads. This is not an exact-source-price
claim or a scoring guarantee. Other supported numeric matches are exact,
after the source's stated decimal/unit conversion. Provider raw-byte L2
remains available only for our known receipt origin; external answers are
honestly L1 even when independently source-matched.

Template A currently freezes UNI price + Ethereum total supply + Uniswap
protocol TVL, with implied FDV and FDV/TVL. Optional pool liquidity and yield
parsers exist but are not purchased by that template. Template B freezes
TSLA price + Tesla 2024 Form 10-Q count + US 2024 unemployment. The registry
boolean is not silently coerced into a numeric observation and is not yet
part of template B. Neither template asserts an economic relationship
between unemployment and yield. Thresholds are declared analyst assumptions,
not observations or investment advice.

`npx tsx desk/scripts/judge-desk-packet.ts research-packet.json SPEC_SHA256`
reparses the stored primary bytes with the fixed source parsers, checks the
expected frozen spec, and rechecks public signal/delivery/epoch records. It
uses no wallet or secret and sends no paid request. Current source-origin
truth, settlement finality and local Merkle-path verification are not claimed.
The original `judge:verify` command remains unchanged pending live evidence.

Fail-closed limits: live receipt reuse is disabled until a reusable public
proof record is persisted; the pure core supports reuse but the paid adapter
never trusts cached layer booleans. Distinct-ranked-provider escalation is
also disabled in the local adapter until the ranking endpoint supplies a
verified selection contract. There is no automatic retry after a failure,
and unknown signed outcomes remain fully reserved. Thus the maximum-one
escalation ceiling is honored conservatively with zero escalation here.

### Private evidence and crash safety

Local evidence directories must be owner-only 0700, with regular owner-only
0600 files. Existing nonprivate, symlinked or noncanonical paths are refused,
not silently repaired. The local CLI checks evidence and ledger locations
before loading its payer. Operators must inspect and deliberately migrate
an older shared ledger to a private location; the CLI does not change its
permissions or discard its spending history.

The Research Desk installs a shared reservation writer that syncs the journal
file and parent directory while the existing spend lock is held. It also
syncs the per-note reservation file and directory before signature. Failure
at either write or sync refuses signing. The ordinary legacy Gate path is
unchanged unless this crash-durable writer is explicitly installed.

Raw response, accounting and packet writes also sync. A write/sync error
after signing stops the run without retry. The already-synced shared and
per-note reservation records preserve full uncertain exposure for recovery.
A partial ledger line may prevent later runs until an operator reconciles
it; that is a fail-closed audit stop, not permission to clear the journal.
Filesystem fsync semantics still depend on the underlying operating system
and storage. There is no claim of protection from storage hardware failure.

### Forward-only exact numeric transport normalization

The first live Template A run remains an unchanged HOLD. One provider returned
whole-token supply as a decimal string while the node returned the identical
numeric value. Future Research Desk runs may compare these representations
as exact rational decimals. The accepted observation remains the shaped node
number with `field_status=ok`, never a numeric fill from raw. Missing/rejected
fields cannot be revived. Legacy Gate/probe equality remains unchanged unless
the Research Desk explicitly opts into this normalization.

This is no tolerance: 3110285426.77 is not equal to 3110285426.7703633. The first
TVL answer had that mismatch. The live TVL schema says six decimals, and the
published answer-shaping documentation does not justify a two-decimal rounding
allowance. The TVL failure therefore stays HOLD. A future fresh run is a new
packet and does not rewrite the historical result. The documentation describing
raw signal coverage and shaped convenience values is at
https://docs.telegraphprotocol.com/docs/using/engine-ask.md .
