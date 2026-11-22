# Verify the recorded research example without a wallet

This is a read-only replay of the published Tesla filing-coverage example. It uses public GET requests, makes no purchase, loads no key and writes no report or ledger. It does not call the purchase command, request a 402 challenge or sign an authorization.

## Run

Requires Node 20.18+ and network access to the public Telegraph node and VeriReceipt's stored evidence service.

From the repository root:

```bash
npm ci
npm --prefix desk ci
npm --prefix desk run judge:verify
```

The last line is the verification command. No environment secret or wallet setup is needed. The dependency installs write local dependency folders; the verification command itself is read-only.

Expected final line for intact, available evidence:

```text
PASS historical SUPPORTED; count=3; current delivery=included
```

The output prints the original completion time and the current check time separately. It also prints every check and the limitations. Exit code 0 means all checks passed. Exit code 1 means HOLD, with the count withheld. Do not change code or saved records just to force a green result.

## What it checks

- Canonical pre-purchase research policy and its hash.
- Public signal hash, payer, Provider and Intent.
- The recorded numerical claim against the signal answer.
- Stored source metadata and raw-byte SHA-256.
- Exact SEC CIK, form and calendar filing dates, required main/history coverage and independent source recount.
- Source freshness relative to the **original run time**, not today.
- Saved outcome against the newly recomputed research result.
- Current block-33 delivery identity, amount, epoch and proof shape.
- Receipt timestamp against its recorded epoch window.

The command reuses the same source and payment-evidence verification functions as the research workflow. It does not trust saved PASS booleans. Its network wrapper accepts only GET requests to the fixed public node/evidence origins and evidence path families, rejects redirects, caches duplicate successful reads within one replay, and has a 90-second total request budget with a 20-second per-request cap. It never automatically retries a failure.

## What this does not establish

This is one historical, direct, related-party Sepolia testnet purchase. A free rehearsal already returned 3, so the outcome was not blind. The local plan hash is not an independently timestamped public commitment. A matching source digest proves byte integrity, not truth of SEC submissions or the filing contents. It is not investment advice, a legal reporting-compliance verdict, independent adoption, ranked routing, real revenue or whole-mission acceptance.

The original run recorded delivery as pending. A separate later record reports block-33 inclusion. The command checks today's public delivery record without changing either historical file. It checks proof shape, not a local Merkle walk or finalized settlement.

## Evidence

- [Original public-safe research packet](research-evidence/tesla-2024-10q-20261121.json)
- [Human-readable appendix](research-evidence/tesla-2024-10q-20261121.md)
- [Separate delivery reconciliation](research-evidence/tesla-2024-10q-20261121-delivery.json)
- [Paid signal](https://devnode.telegraphprotocol.com/engine/v1/signal/0x96d87b16a15c10e8be803eeb4d491c74adf9382ede0e4955d4de2f6f24db372e)
- [Block-33 delivery](https://devnode.telegraphprotocol.com/v1/blocks/33/deliveries/0x69fb3b0a9b4b48359d6925595388b75ad2735f0ac119deed1ef4e01e765dac67)

## Test failure behavior without paying

```bash
npm --prefix desk test
npm --prefix desk run typecheck
```

`desk/tests/judge-replay.test.ts` uses a labeled synthetic network fixture. It checks wrong signal identity, altered raw bytes, mismatched delivery payer/amount, malformed proof, wrong epoch, pending delivery, unavailable evidence, changed plans and false saved status. It also tests refusal of write requests, unrelated URLs, embedded credentials and non-evidence paths. These are fixture tests, not extra paid runs or production accuracy measurements.

## Troubleshooting

- Missing `tsx` or another dependency: run the two install commands from the repository root.
- Public node or stored evidence unavailable: the command returns HOLD. Check the failed public link, then rerun manually later. No payment occurred, and no wallet is needed.
- Altered or incomplete clone: compare with a clean checkout and inspect the diff. A saved record is input to verification, not an authority to override failed checks.
- Need a new question rather than replaying this one: follow [the research CLI guide](research-packet.md). Planning is free and local; a new purchase is separate, requires a securely configured authorized testnet payer and is never triggered by this verification command.
