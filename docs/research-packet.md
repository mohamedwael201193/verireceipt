# Receipted filing-coverage research packet

A narrow Mission 13 workflow, not an investment advisor or a full fund model.
Give the Desk a CIK, a completed calendar year, an exact filing form and an
analyst's minimum-count criterion. It fixes that policy **before** payment,
buys one answer through Telegraph Sepolia escrow, independently recounts the
hash-checked stored SEC main/history bytes, then produces a research appendix:

- **SUPPORTED**: verified count is at least the frozen criterion.
- **NOT_SUPPORTED**: the evidence verifies, but the criterion is not met.
- **HOLD**: identity, freshness, source extraction, payment or delivery evidence
  is missing, inconsistent or unavailable. No unverified count is shown.

These are research-coverage results, not a conclusion that a company complied
with reporting law, that a security is safe, or that an investment should be made.
A zero count can be a valid negative research result. Amendments are excluded.
The year means calendar **filing date**, not company fiscal year or report period.

## What is new, and what is not yet proved

The existing Desk purchases and retrospective demo-policy report remain
unchanged. This workflow accepts new inputs and applies a pre-purchase policy.
It is local CLI software, not a paid endpoint on the hosted dashboard. The UI
must not label a local plan as a completed purchase or independent adoption.

Its automated tests use synthetic network fixtures. Passing tests is not a live
paid mission run or an independent judge acceptance. Record real runs separately
and publish only inspected, reviewed, public-safe evidence.

## Requirements

- Node 20.18+ and `npm ci` in both the repository root and `desk`.
- A dedicated **Sepolia testnet** payer with an existing supported Telegraph
  escrow balance and a securely stored private key. No mainnet funds needed.
- An explicit `DESK_PAYER_ADDRESS` matching that key.
- Network access to the public Telegraph engine, ledger and signal/delivery
  APIs and VeriReceipt's stored receipt bytes.
- Local write access for the frozen plan, conservative spend reservation and
  response evidence. Never commit keys, secret files or private run directories.

The payer key is read in-process from `DESK_SECRETS_FILE`, field `private_key`.
Do not put a key in a command, source file, screenshot or chat. Use your approved
secret-storage workflow. Do not set a key at all just to prepare a plan.

## 1. Prepare a new input

Create `research-input.json` with exactly these four fields. CIK is a string of
canonical positive digits, with no leading zeros. This avoids guessing a
company from an ambiguous name. The example tests a research criterion, not an
SEC rule about how many filings a company must make.

```json
{"cik":"320193","year":2025,"form":"10-Q","minimum_count":3}
```

Supported exact forms: `10-Q`, `10-K`, `8-K`. Year must be completed and at least
1994. The criterion must be an integer from 1 to 1000.

## 2. Freeze the plan, without buying anything

From `desk`:

```bash
npm run research -- plan research-input.json research-runs/apple-2025
```

Create the parent `research-runs` directory first if needed. Each destination
must be new. Inspect `plan.json` and `plan.sha256`. The plan fixes identity,
calendar period, exact form, criterion, 300-second evidence-age bound, Sepolia
network and maximum 10,000 micro test-USDC per call ($0.01 test USDC).

This command loads no key and makes no network request. A local hash documents
normal program order; it is **not an independent timestamp or proof that a
person cannot edit local files**. The hash is also bound into the signed ask's
nonce. For an externally witnessed precommit, publish the public-safe plan/hash
before a run through an approved channel, rather than claiming a local file did
that. Creating a plan does not grant permission to spend.

## 3. Buy once, explicitly

Only after you have authority to use that testnet account and cost:

```bash
# Set DESK_SECRETS_FILE and DESK_PAYER_ADDRESS via your secure environment.
npm run research -- buy research-runs/apple-2025
```

Plans must be under an hour old. The command refuses reuse of an attempt
folder, writes a conservative reservation before signing, and never retries a
paid ask automatically. It checks the existing Desk ledger plus research spend
reservations against the $2 test-USDC UTC-day cap. Failed/uncertain research
attempts retain their full reservation, so this accounting can deliberately
understate remaining budget. Do not run another purchasing program concurrently;
the lock serializes this research command, not every client that might share a
wallet. Keep the research journal when moving run folders or processes. A
missing/deleted local journal is not proof of unused budget.

The existing client checks the challenge's Sepolia network, resource, amount,
escrow balance, validity window and matching payer before signing. A receipt
must match the payer, served registration and charge. This is a direct ask to
our own Provider, not evidence of ranked routing or independent demand.

## 4. Inspect the result and evidence

The new run directory contains:

- `plan.json` and `plan.sha256`, created before the attempt.
- `attempt.json`, a no-retry marker created before payment.
- `paid-response.json`, if a response arrived. It contains public authorization
  fields and signed message, **not the payer private key or payment signature**.
- `report.json`, machine-readable policy, checks, result and accounting state.
- `appendix.md`, a usable research table of dates, SEC accessions and document
  links where the paid answer supplied links matching the independently parsed
  source metadata. File contents themselves are not audited.
- `incomplete.json` after an interrupted/failed run. Treat charge status as
  unknown until inspected against live records. Do not retry automatically.

The shared reservation journal is under `desk/research-runs`, regardless of
where an individual run folder was created. Run artifacts are ignored by Git by
default. Do not publish whole folders blindly: they include wallet/account data.

A pending delivery is labeled pending. It is not included or finalized
settlement. The workflow checks included delivery identity, epoch and proof
shape when available. It does not claim a local Merkle walk. Preserve the
original run, and check delivery through the supported node interface later
before making a settlement claim.

## What the verification actually proves

The existing verifier rederives the signal hash and binds the payer, Provider,
Intent, numeric result and stored receipt digest. The new replay checks the
frozen request params, exact CIK source URL, source CIK, fresh fetch timestamp,
every overlapping SEC history page and its digest, conflicting duplicate
accessions, calendar dates, exact forms and independent count. Another company's
response or a missing required history page produces HOLD.

This checks extraction from stored SEC bytes. It does not establish that every
SEC submission is true, prove the economic value of a filing, check filing
contents, or constitute multiple independent data sources.

## Reproduce and break it

```bash
npm run typecheck
npm test
```

Useful new live research inputs after review/authority: a different CIK, a
different completed year, and a criterion that the resulting evidence does not
meet. Do not change the criterion after seeing the answer. One genuine negative
result is more useful than repeatedly buying the same passing result.

Unit/integration fixtures cover changed policy, wrong CIK, wrong request params,
stale/future timestamps, changed bytes, missing history, malformed source rows,
conflicting duplicates, forged document links, spend caps, reservation failure,
wrong-intent receipt, mismatched included delivery, and lost paid response with
no automatic retry. Local fixture errors are not real-world paid failures.

## Troubleshooting

- Invalid input or unknown fields: fix input before any purchase.
- Stale plan: create and inspect a new plan, without changing it to fit an old
  answer. Do not relabel an old answer as a new precommitted run.
- Lock exists: inspect the previous process and evidence. Do not remove a lock
  just to force a second buy.
- Missing source/history or timeout: HOLD is correct. Do not substitute a
  company, date or data provider silently.
- Lost response or incomplete run: inspect reservation, captured reply, escrow
  accounting and signal/delivery records before deciding whether a new attempt
  is needed. A failed HTTP response alone does not prove that no charge occurred.
- To compare a no-Telegraph baseline: manually obtain the same SEC main/history
  files and count the same exact form/date filters. Measure effort if making a
  time-saving claim. No time or money savings are assumed here.

## Why this workflow, rather than imitating a winner's surface

Season I's official winner descriptions emphasize useful work inside real user
workflows, evidence before irreversible action, and acceptance criteria fixed
before funding. Here the analyst's research question is fixed before the paid
call, the evidence is checked before the research verdict, and the output is a
portable appendix instead of an isolated receipt. A Gmail extension, SMS access,
a trading signer and a fund optimizer are separate projects with separate
privacy/safety requirements, not extra features we can honestly claim from this
small workflow.

Sources: https://hackathon.telegraphprotocol.com/rules ;
https://hackathon.telegraphprotocol.com/missions/asset-management ;
https://hackathon.telegraphprotocol.com/winners .
