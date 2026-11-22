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
