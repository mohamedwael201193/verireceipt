# Market-aware grid policy v2, design only

Status: proposed. Not executable policy, not a new benchmark freeze, not wired to
the hosted filing buyer, not a live experiment. No source was fetched for this
document. It describes existing code behavior and the changes required for a
separately reviewed release. No dispatch, trade or allocation is authorized.

## Why a new release

The frozen v1 grid tasks/cases omit `market` in their request params. The v1
benchmark question text distinguishes NYISO real-time from CAISO day-ahead, but
that distinction was not completely represented in the paid request contract.
A receipt can prove which bytes were delivered without proving the intended
market. The current `gridContract` therefore rejects omitted markets before a
purchase. Do not silently repair v1, substitute a different expected value or
rescore its historical results as though the request had been different.

The v1 policy, case set, source snapshots and as-run ledgers remain unchanged.
The file-hash anchors below identify their current source artifacts, not new
policy/task hashes and not proof of a new precommitment.

## Proposed exact products

| Field | NYISO product | CAISO product |
| --- | --- | --- |
| Operator | NYISO | CAISO |
| Required request `market` | `RTM` | `DAM` |
| First-release fixed node | `ZONE_J`, normalized to `N.Y.C.` | `TH_NP15_GEN-APND` |
| Value | `lmp_usd_per_mwh` | `lmp_usd_per_mwh` |
| Unit/currency | USD/MWh, `USD` | USD/MWh, `USD` |
| UTC alignment required by current verifier | Five minutes | One hour |
| Official row selection in current verifier | Exact zone, timestamp, LBMP column | Exact UTC start/end, node, `LMP_PRC`, `MARKET_RUN_ID=DAM` |
| Evidence duration | Five-minute timestamp contract, no invented averaging | Exactly one-hour start/end |

The supported pairings above are deliberately narrow. CAISO RTM, NYISO DAM,
other nodes, currencies, products, aggregated prices and unaligned intervals
remain unsupported. A bare `NYISO` or `CAISO` label is not product evidence. Do
not infer DAM/RTM from a familiar operator or a plausible numeric value.

For the initial v2 artifact, require an explicit UTC interval from the operator.
Do not silently reuse v1's rolling time defaults. A later current-interval mode
needs a separately verified publication-lag/freshness policy. A past interval can
be checked as historical evidence but must not be advertised as a current price.

## Proposed policy artifact, not created here

Use a new file, proposed `desk/policy/grid-policy.v2.json`, and new task IDs such
as `grid-v2-nyiso-zone-j-rtm` and `grid-v2-caiso-np15-dam`. "v2" names this product
release, not an already-supported serialization format. The current validator
only accepts `gate-policy-v1`. Keep that serialization version unless a separate
schema migration is reviewed; distinguish the release with its file, task IDs,
notes, immutable commit and policy/task hashes. Never make the existing loader
silently select this new artifact instead of v1.

Each task fixes `market` and its first-release node in `fixed_params`. Only
`interval_start` is an allowed runtime override. Do not allow callers to change
market, node family, units, price ceiling, network, route or payee. Intent remains
`GRID_POWER_PRICE_GENERAL`, network remains Sepolia, ranked auto routing remains
explicit, and the maximum call remains 10000 micro-test-USDC.

A proposed advisory rule retains the existing numeric ceiling, `price <= 150
USD/MWh`, rather than selecting a threshold after seeing new answers. This is a
research screen, not an operational electricity contract. The rule text should
name its exact product/node and historical UTC interval. The threshold and text
must be frozen and independently reviewed before any v2 paid arm runs. PASS must
never trigger an energy purchase, dispatch or other downstream action.

## Required verification chain

1. Preflight exact product, fixed node and aligned UTC interval before obtaining
   or signing an authorization. Unsupported or ambiguous inputs HOLD without a
   paid request.
2. Preserve the existing ranked payment/signal identity, wallet, intent, params,
   freshness, delivery and epoch checks. Known VeriReceipt registrations also
   require their existing raw-byte receipt chain. A foreign provider is not
   treated as a known VeriReceipt raw-byte proof.
3. Reconcile only explicitly unavailable nonnumeric fields using the existing
   hash-verified provider data rule. Never fill numeric price, missing or
   rejected fields from a fallback, expected benchmark value or local default.
4. Require mutually consistent operator/product/node/UTC/currency claims from
   the engine and hash-bound provider response. Product evidence is explicit
   metadata or a strictly checked official product receipt URL. A CAISO URL
   window must contain the exact requested hour, remain bounded to 26 hours,
   have no duplicate parameters, and name DAM/PRC_LMP/the exact node.
5. Independently read the official source using the current source verifier.
   NYISO uses the requested local-date daily real-time file, with a dated
   monthly ZIP fallback only after a genuine 404. CAISO uses the exact requested
   hour's OASIS DAM query. A receipt URL alone never replaces that source read.
6. Preserve source bytes, retrieval time, digest and selected row identity.
   Validate CSV schemas/row widths, ZIP bounds/CRC/size, exact units/product,
   unique matching row, CAISO duration and NYISO local-to-UTC/DST chronology.
   Ambiguous fall-back-hour data, nonexistent local times, duplicates,
   contradictory metadata, source errors and missing rows all HOLD.
7. Require a finite numeric price exactly matching the independently parsed row
   before evaluating the frozen rule. Negative prices are valid finite prices,
   not missing-data sentinels. An unavailable placeholder zero cannot PASS.
8. Keep delivery pending, included and error separate. Pending is allowed only
   with the existing positive predecessor/epoch evidence. A shape-checked Merkle
   proof is not a proof walk or settlement finality.

These are code-grounded contracts in `desk/src/gridSource.ts`, `gate.ts`,
`sourceTypes.ts` and `verify.ts`. This document does not independently re-check
current ISO publication schedules, external retention policies or tariff rules.

## New benchmark freeze and independent anchors

Proposed artifacts: `desk/benchmark/grid-cases.v2.json`,
`grid-snapshots.v2.json` and a new `grid-runs.v2.jsonl` ledger. Do not overwrite
`cases.v1.json`, `snapshots.v1.json` or any existing ledger. Include explicit
`market` in every request and in every question. The first corrected cases may
reuse the old historical intervals only after a fresh independent source review;
old expected prices are not automatically promoted into v2 gold.

Before any arm answers, a separate source-review step must obtain each primary
snapshot, document the operator/product/node/UTC row and units, record retrieval
and source revision status, hash the original bytes and selected row, freeze the
case/grader/rounding rule, and commit all anchors. No such new snapshots or gold
values are supplied here. Do not claim an ISO price is immutable or final without
checking the current source's revision policy. A corrected source release gets
an append-only revision record and new benchmark version, not a hidden edit.

Expose only questions/params to answering arms. Keep expected values and source
snapshot hashes out of paid request prompts and verifier decision inputs. The
source verifier computes from the requested official data, never benchmark
answers. Use identical product/interval/unit questions across arms. Separately
report correct answers, wrong answers, abstentions/HOLD, spend and coverage;
never count a HOLD as a correct price. Keep the original v1 score visible with
its original request ambiguity.

## Release checks before any execution

- Golden positives: both exact product contracts, finite positive/zero/negative
  prices, exact ceiling equality, below/above-ceiling outcomes, source byte
  digests and distinct policy/task hashes.
- Negative controls: omitted/swapped market, ISO-only labels, unsupported node,
  shifted interval, wrong currency, wrong CAISO product/duration, conflicting
  engine/provider price, altered raw bytes, duplicate rows, incomplete ZIP,
  source 403/429/timeout, DST gaps/repeats and missing predecessor epoch evidence.
- Isolation controls: old v1 artifact byte hashes unchanged; old under-specified
  requests still HOLD before purchase; hosted filing policy cannot select grid;
  no automatic activation, purchase retry, signing, funding or paid run.
- Review the new policy, independent gold freeze and precommitment hashes first.
  A separate user-approved execution envelope must name the payer, testnet
  budget, route and permitted calls. A design commit grants none of that.

## Existing v1 byte anchors

Generated from the local committed files at the design commit's parent. These
are raw-file SHA256 values, distinct from the Gate's canonical object hashes.

- `desk/policy/gate-policy.v1.json`: `2973372884621031fadf15bd826c4a50082381768883a221b5e5e5cd88fcc994`

- `desk/benchmark/cases.v1.json`: `b820aae9b39321f92361bf8e9281d4031733e6721fd833ccfa442d43bebbce39`

- `desk/benchmark/snapshots.v1.json`: `f9040b194343f07998614b2b6e01d5064696f48388a4bb52bf143a6b715756dc`
