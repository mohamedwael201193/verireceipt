# VeriReceipt Gate - pre-execution evidence gate (Track 3)

The Gate is the live buyer flow: give it a decision question, it buys the
answer through the Telegraph network's own ranked routing, verifies the
evidence, and returns PASS or HOLD against a rule that was committed to this
repository **before any run**. A PASS never executes an action; it is
advisory evidence with a receipt chain a reviewer can replay.

- Sepolia testnet only. The client refuses any other network.
- Auto-routed: `POST /engine/v1/ask` carries no miner id, so the network
  picks the provider. The record names whoever served.
- Fail-closed: any refusal, verification gap or invalid value is a recorded
  HOLD, never a guess.

## Run one gate task

```bash
cd desk
npm ci
DESK_SECRETS_FILE=/path/to/env.txt npm run gate -- gate-tvl-floor-aave-v3
# new input (only params the task's accepts_params lists; the rule never changes):
DESK_SECRETS_FILE=/path/to/env.txt npm run gate -- gate-tvl-floor-aave-v3 --set protocol=uniswap-v3
```

`DESK_SECRETS_FILE` holds `private_key: 0x…` (Sepolia testnet key, read
in-process, never printed). `DESK_PAYER_ADDRESS` pins the expected payer; a
mismatched key refuses to sign. Exit code 0 = PASS with the audit record
appended, 1 = anything else. Every run appends one JSON record to
`desk/ledger/gate-runs.jsonl` with the policy hash, task hash, receipt hash,
signal hash, serving miner, checks, value, outcome and cost. If the audit
append itself fails, the run returns the record with
`record_appended: false`, prints a warning and exits non-zero - the printed
record is the only copy.

## Spend policy

The gate and benchmark permit at most one flat-price call ($0.01 testnet)
per evaluation. The purchase, gate and benchmark CLIs use the same
reservations journal, lock and settlement ledgers for a $2.00 UTC-day cap
when they share `DESK_LEDGER_DIR` (default `desk/ledger`). Before signing,
the quote and nonce are appended to `reservations.jsonl` under an exclusive
lock after rechecking settled plus outstanding reserved exposure.

The settled amount and the set of retired reservation nonces come from
one matched snapshot: each settlement file is read once and both values
come from those exact rows. A settlement appended after that snapshot
remains covered by its reservation. An incomplete JSONL read or failed
journal write refuses the signature. Gate and benchmark records count
`paid_uusdc ?? worst_case_uusdc` for signed attempts whose outcome is
unknown; outstanding reservations continue to count if the audit append
fails. These controls assume append-only local ledgers, shared paths, and
the supplied `spendLedgerFromFiles` adapter. Custom API callers must supply
the shared adapter; `runDesk` without its optional `spend` counts only its
own purchase ledger and does not join the shared reservation cap.

## The precommitted rules

`desk/policy/gate-policy.v1.json` holds seven tasks over the six live
intents (M12 grid dispatch gates, M13 treasury/settlement/validator screens,
M14 execution screen, M4 filing diligence). The gate recomputes the policy
hash from the parsed policy and refuses to run when it differs from the
supplied hash; the CLI additionally refuses any policy whose content hash
differs from the committed anchor in `src/gatePolicy.ts`. Each run record
carries the policy hash and the sha256 of the exact task (including the
rule) it evaluated, so a copied task with a tuned threshold cannot pass
under the committed hash. Operator input is limited to the task's
`accepts_params` keys and is recorded verbatim. The selected task is
deep-copied before awaits, so a callback cannot change its rule mid-run.

## What verification means here

1. Payment binding: the escrow receipt must name our payer and the exact
   signed amount (decoded from X-PAYMENT-RESPONSE).
2. Node-level evidence (any provider): the signal hash is re-derived from
   the canonical payload (keccak256), the payload wallet is the payer, the
   serving identity is present and consistent with the receipt's on-chain
   registration in both directions, the signal timestamp belongs to this
   purchase and this run, the intent and params match the asked input, the
   engine's value equals the provider's recorded answer and the decision
   field's `field_status` is `ok`. An included delivery must match the
   receipt identity and have a valid proof shape. A pending delivery
   requires a recorded predecessor explicitly identifying `claimed_epoch - 1`,
   an ordered nonempty window ending no later than the receipt, and a
   successful epoch-consistency check. Missing, future, reversed or conflicting
   predecessor-window evidence produces HOLD. HTTP errors encountered by
   these checks fail closed; this is not a scan of every historical epoch.
3. Miner raw-byte chain: when the receipt names a known VeriReceipt
   registration (identity consistency is checked above), the stored raw
   upstream bytes are re-hashed and matched. For another provider this layer
   is recorded as `not_applicable`, never silently skipped; a payload
   claiming VeriReceipt under an unknown registration fails the identity
   check instead of downgrading verification.

## The five reviewer checks (mission acceptance)

1. **Run it** - the commands above with any accepted new input.
2. **Check it** - the record's `value`, `outcome` and `reasons`.
3. **Inspect it** - `purchase.receipt_hash`, `signal_hash`, the serving
   miner, the checks and the ledger line; the verification endpoints are
   public (signal record, epoch block and delivery lookups, miner receipts).
4. **Break it** - ask for a venue whose verified value cannot satisfy the
   precommitted floor (`--set protocol=…`) and the outcome is HOLD naming
   the rule; tamper with any evidence and the failed checks are named.
5. **Reproduce it** - `npm ci && npm run typecheck && npm test` (382 tests across 23 files,
   no network, no key); the gate flow is covered with mocked nodes including
   tamper cases.

## Frontier benchmark

`desk/benchmark/cases.v1.json` freezes eight cases over past immutable
states (two transaction settlements, four SEC filing counts, two grid price
intervals), committed **before any arm answered**. Each grader is bound to a
versioned primary snapshot in `desk/benchmark/snapshots.v1.json` (sha256 per
case; the revision policy there governs any later source revision - the
frozen snapshot stands, the revision is documented).

```bash
# question-only packet for the frontier arm (no key, no spend):
npm run benchmark -- --export-questions questions.json
# the run itself:
DESK_SECRETS_FILE=/path/to/env.txt npm run benchmark -- [--frontier answers.json]
```

The case set is pinned to a committed hash (`COMMITTED_CASES_SHA256`), so
`DESK_BENCHMARK_CASES` cannot swap the gold answers, and every snapshot must
cover its case. A frontier answers file is validated - schema, cases_hash
binding, timestamps, declared web search, and exactly one numeric answer
or explicit null abstention per case - **before** any paid run.

The gate arm answers each case through a fresh paid auto-routed probe
(`runProbe`, the benchmark's own verification API: no gate policy, no
decision rule). Before making a request, it hashes the supplied frozen
case set and matches the selected case's id, intent, params, question and
value field. The record carries these inputs, `case_input_hash` and the
case-set hash, and reports ANSWERED or ABSTAIN. Grading independently
matches those same recorded inputs against the frozen case. Duplicates,
unknown cases, mismatched inputs or hashes reject the run set, and every
paid attempt is disclosed in the report. The report (JSON + markdown in `desk/benchmark/results/`) shows
accuracy, precision-when-answered, false passes and abstains separately (an
ABSTAIN is never a correct answer), real testnet cost, and paid-request
round-trip latency (verification and grading excluded).

## Limits

Advisory evidence only: a PASS never executes a dispatch, trade or
allocation; a run's only effects are the testnet escrow purchase itself, the
journaled reservation and the audit record. Related-party Sepolia testnet
purchases through ranked auto-routing; not independent adoption, customer
revenue or a mainnet claim. A fresh purchase's delivery may legitimately
still be pending its epoch block (recorded as `delivery_status`), and the
delivery Merkle proof is shape-checked only (the leaf/node hash algorithm is
not documented), never walked.

## Primary-source verification after the first live run

The first frozen benchmark remains an as-run result of the earlier revision.
It is not rescored with later checks. Receipt integrity alone did not establish
answer correctness. The filing verifier now independently resolves the SEC
issuer, exact form and supported explicit year/date range, reads the main
submissions document and every listed history page, validates coverage and
deduplicates accessions before comparing the primary recount with the paid
answer. Contradictory returned form/date/source assertions also fail closed.
It applies regardless of the serving miner. Source URLs, exact response text,
SHA-256 digests and recount details are carried in `source_verification`.
Missing source evidence, unsupported query grammar or an absent SEC contact
User-Agent causes abstention/HOLD. Set `SEC_USER_AGENT` with a contact email;
the verifier does not infer one. Other intents do not gain source-truth
verification from this filing-specific check.

Returned filing assertions are also constrained to the independently matched
issuer and accession rows. SEC-hosted links alone do not establish ownership
or relevance. Wrong-typed optional arrays, unrecognized/contradictory title
formats, invented accession links and mismatched issuer/detail rows fail closed.

The filing result's entity may be the exact already-validated query echo,
as returned by the miner, or the independently verified issuer name/CIK.
Changing the issuer or form inside a query-shaped result is not an echo.
Primary document paths use the same invisible-character cleanup and
one-safe-subdirectory contract as the miner; traversal/deeper paths are refused.
