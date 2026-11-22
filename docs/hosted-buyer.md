# Sponsored ranked filing buyer

Status: offline implementation in progress. No hosted payer is created or funded,
no purchase is authorized by this document, and nothing is enabled or deployed.
The existing dashboard direct probes remain unbilled and separate.

## Narrow product contract

One question: does a canonical SEC CIK have at least three exact 10-Q filings
in a selected completed calendar filing year? Only CIK and year are visitor
inputs. There is no visitor-selected form, threshold, market, provider, endpoint,
network, payer or signing message. Amendments are excluded. Unsupported inputs
are refused rather than broadened.

The separate hosted policy in `desk/src/buyerPolicy.ts` uses the reviewed Gate,
network-ranked routing and independent SEC source recount. Its criterion is
fixed at three. It does not edit the original gate-policy.v1.json, benchmark v1
or their anchors. A plan binds exact parameters, task/policy hashes, criterion,
expiry and one-call charge before the buy action. A local code/plan hash is not
an independently witnessed timestamp.

The operator sponsors one 0.01 test-USDC call on Ethereum Sepolia, under a
2 test-USDC UTC-day service cap, equivalent to at most 200 calls at 0.01
test USDC before other capacity limits. This is related-party testnet activity, not
customer revenue, independent adoption, a mainnet payment or real-money spend.
A PASS is advisory filing coverage, not reporting-compliance or investment
advice. Missing or contradictory evidence is HOLD. Fewer than three verified
filings also means HOLD against this fixed criterion.

## Dedicated payer and shared authority

The hosted payer must be separate from the existing CLI/research payer addresses.
Startup must require explicit, nonempty complete CLI and research payer exclusion
sets; no omitted-set default is allowed.
No payer is generated, funded or signed as part of this implementation. The
service design uses one SQLite WAL/FULL authority on a persistent single-host
volume for all its workers and requests,
with durable budget reservation and idempotent server-created plan IDs. This is
not a distributed/multi-host authority: replicas and independent database paths
for the same payer are unsupported and must not be enabled. It must
not share a funded account with an independent CLI or the older direct research
service. Per-run local Gate reservations are an additional fail-closed check,
not a competing global budget. Unknown signed exposure stays reserved.

## Chosen short retention contract

- Unbought plans expire after 10 minutes and can never be bought by an unknown
  or expired ID. A retried buy of an already-started ID cannot purchase again.
- Result/input/evidence access expires 24 hours after reservation. Download
  evidence before then. No key, signed message or request authorization is stored.
- Physical payload cleanup runs at least hourly while the service is healthy,
  and catches up before accepting new jobs on startup. A stopped service cannot
  promise physical erasure while it is stopped. Reads deny expired payloads.
- Minimal conservative accounting/idempotency tombstones last 48 hours, then
  are deleted. Unknown IDs never create purchases, including after deletion.
- An uncertain job is not retried or refunded automatically. Retention expiry
  does not imply settlement, a refund or the restoration of current-day budget.

These retention and authority rules are implementation requirements until the
corresponding service increment has passed review. This document is not an
instruction to turn the service on.

## Durable authority implementation (offline only)

`src/buyer/store.ts` now implements a synchronous SQLite WAL/FULL authority.
This does not validate any hosting setup. Startup must separately require an
absolute persistent database path on a single host, complete CLI/research payer
exclusions and the explicit dedicated-payer/single-host deployment contract.
No independently purchasing process may share that payer without this authority.
The schema pins the payer to the database; changing it fails startup.

Only trusted server-created plans are inserted. Starting a purchase takes a plan
ID, owner-session hash and previously shown plan hash. It cannot take a client
plan object. An IMMEDIATE transaction reserves the full call ceiling, UTC-day
exposure, retained-payload headroom and single-payer lease before execution.
Duplicate starts return the same job, including after a crash, without a retry.
A second durable transition checks exact terms, payer, unique nonce, live lease,
plan expiry and signing-day budget before permitting the signer to be called.
Signing intent is not proof that a signature or payment happened.

A reservation or uncertain outcome is never refunded by this authority. When a
lease times out, a later *different* explicit plan may start, but the old plan
cannot start again. The 180-second lease exceeds the accepted 120-second
maximum authorization validity and the planned 90-second execution bound.
Headers must persist before a paid body. Terminal result writes cannot overwrite
previous results, and follow-up records cannot start purchases. Actual charge and
settlement remain separate facts for the runtime to establish.

Payload access ends exactly 24 hours after reservation even if cleanup is late.
Cleanup removes input, result, headers, paid body, followups and owner/network
hashes, retaining only non-payload budget/idempotency facts until 48 hours after
signing intent or reservation. Unknown IDs never buy, including after deletion.
Healthy-service hourly cleanup and startup catch-up must be wired by the runtime.
Plan creation itself also cleans up. There are owner/network preview rate caps,
a global pending-plan bound, bounded result/body/header bytes, bounded followups,
and worst-case storage headroom before each reservation. These limits can reduce
the theoretical 200-call daily allowance.

Real local SQLite tests cover two connections, simultaneous workers, owner and
hash binding, crash/uncertainty, stale leases, unique nonces, 200-call cap and UTC
rollover, 24/48-hour boundaries, payload capacity and follow-up limits. They use
no network and no signer. No PostgreSQL or deployed-runtime test is claimed.

## Server-only runtime and wiring design

The separate buyer runtime bundle uses the existing ranked `runGate`, never the
old direct research path. Its transport only permits the exact frozen ask body,
one ranked challenge and one paid submission, the configured payer's node
ledger, bounded public signal/epoch/delivery reads, known VeriReceipt receipt
reads and the requested CIK's official SEC submission pages. No arbitrary URL or
foreign CIK can be fetched. It stops on 403/429, uses bounded bytes/calls, forces
redirect refusal, propagates aborts and paces SEC reads. A per-run private local
reservation journal is additional defense, not the shared budget authority.
Scratch files are removed in `finally`; crashed scratch directories expire at
24h and need the planned startup/hourly cleanup. Purge means application-level
row/file removal, not forensic erasure of disks, WALs, backups or snapshots.

Future startup must provide the dedicated address/key, both complete payer
exclusion arrays, `BUYER_EXCLUSIONS_COMPLETE=yes`,
`BUYER_SINGLE_HOST_PERSISTENT=yes`, `BUYER_NO_INDEPENDENT_PURCHASER=yes`, a
canonical private persistent scratch directory and a real SEC contact user-agent.
These acknowledgements do not independently prove the deployment promises or
payer-list completeness; the operator must actually satisfy them. No key is
created, funded or loaded by building this code. Importing/building is inert.

The signer can be invoked once, only after the durable guard commits. The
returned envelope is bound to the server plan, exact rule, params, payer and
policy/task hashes. A missing source check can never be presented as PASS. The
runtime distinguishes not-signed, node-reported receipt amount and uncertain
maximum exposure. None implies final settlement. No signed request, signed
message or private key is included in the stored response hooks or envelope.
Read-only delivery follow-up binds any ranked serving provider's exact receipt
identity, amount, epoch and proof shape. It has no signer and forbids paid asks.
It neither walks a Merkle proof nor claims finality.

Next route layer: disabled by default, fixed same-origin UI with private session
cookie, preview-only server plan creation, explicit buy by stored plan ID/hash,
owner-bound result/evidence reads and rate-limited read-only follow-up. No
startup job replay or paid retry. Abort work on shutdown and retain uncertain
exposure; arrange startup/hourly payload cleanup. Routes and the UI are not yet
mounted in this increment and need their own independent review.

## Additive HTTP wiring (still disabled)

`registerBuyer` is now mounted additively by the server but immediately returns
unless `BUYER_ENABLED=1`. It loads no buyer key, database or runtime while off.
When on, startup checks the runtime's configuration, requires a private canonical
absolute persistent database path (`BUYER_DATABASE_PATH`), pins the runtime payer
to the authority, then performs store/scratch cleanup and repeats it hourly.
This code was tested offline, not against a deployed volume or funded payer.

The UI's same-origin `/api` rewrite maps to these server routes:

- `GET /v1/buyer/session`: secure HttpOnly SameSite=Strict host cookie and terms.
- `POST /v1/buyer/plans`: CIK/year only, stores a trusted preview, no purchase.
- `POST /v1/buyer/plans/:id/buy`: only `plan_hash`, exact approved origin/session,
  loads the server plan by ID, reserves atomically, and starts it at most once.
- `GET /v1/buyer/jobs/:id`: owner-bound check summary, no raw primary payload.
- `GET /v1/buyer/jobs/:id/evidence`: owner-bound full evidence download, including
  captured public response header/body. No request authorization is included.
- `POST /v1/buyer/jobs/:id/delivery`: owner-bound read-only check; claims its
  one-minute cooldown durably before reading, so concurrent requests cannot
  bypass the fetch limit. It cannot launch a purchase or signature.

Reads never start or retry work. No automatic startup replay exists. Uncertain
results remain readable as HOLD with unknown charge exposure, without releasing
the payer lease early. A bound node receipt is still not final settlement.
Shutdown aborts active work and waits for its closeout, retaining unresolved
reservations. Validation rejects mismatched result plan/policy/task/payer/rule,
unknown-charge PASS, missing checks and false PASS before making results visible.
Hourly cleanup failure is logged without revealing private payloads or secrets;
per-read 24-hour denial and per-reservation purge still apply. These mechanisms
are not forensic erasure, and backup/snapshot policies need deployment review.

Named offline API tests use real local SQLite and injected synthetic no-payment
results. They cover preview-versus-buy separation, secure sessions, origin and
owner checks, rejection of client plan objects/rehashed terms, repeated and
concurrent starts, recovery GETs, unknown outcomes, response hooks, false PASS,
full evidence versus summary, followup cooldown, startup/hourly cleanup,
expiration and shutdown abort. Synthetic test results are not experiment data.
The UI is not implemented by this increment. No hosted purchase has been run.
