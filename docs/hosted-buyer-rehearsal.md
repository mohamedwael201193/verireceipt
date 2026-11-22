# Joined no-sign buyer rehearsal

This is an offline rehearsal, not a successful purchase. It uses a synthetic
escrow challenge and balance, a fake payer address, and a throw-only signer. No
key is loaded, no signature is generated, no paid transport request is permitted,
and nothing is deployed or enabled on a host. It does not prove source truth,
real network routing, settlement, a receipt or a paid PASS.

## What it joins

A fresh local Chromium profile loads the actual compiled buyer UI at an
intercepted HTTPS origin. Every request is intercepted and either served from
local frontend files, sent to the local rehearsal bridge, or refused. There is no
connection to that hostname. The bridge passes the browser's actual headers and
cookie into the real Fastify buyer routes, real SQLite authority and compiled
ranked buyer runtime/Gate. It never substitutes a prepared result envelope.

The runtime sees only a local synthetic balance and challenge. Its real durable
before-sign checkpoint commits. The injected signer then throws without signing.
The real runtime and authority retain an uncertain HOLD, rather than treating the
failure as a refund or permission to retry. Browser refresh, manual result check
and owner-bound evidence retrieval must not start another execution.

Assertions cover Secure/HttpOnly/SameSite=Strict owner cookie flags, exactly one
buy POST, one runtime execution, one committed durable checkpoint, one invocation
of the throw-only test signer, zero signatures and zero paid transport calls.
The report also reads the real local SQLite row and checks reserved/checkpoint
facts and uncertain state. Result screenshots and downloaded evidence are saved
only in the selected temporary output directory, never in experiment ledgers.

## Reproduce without installing or contacting anything

Use the supplied cached root, Desk and frontend dependencies. Chrome/Chromium,
Python 3 and websocket-client must already be available. CHROME_BIN can select a
local browser binary. Loopback ports 8771 and 9231 must be free; the harness checks
before starting. Run from repository root:

```sh
./node_modules/.bin/tsc -p tsconfig.json
node scripts/build-visitor.cjs
(cd frontend && npm run build)
python3 scripts/rehearse-buyer-browser.py /tmp/buyer-joined-rehearsal
```

Do not use the root npm build command for an offline check: its dependency-install
step is not needed when the cached dependencies are present. Do not run the
unrestricted root-wide test suite, which contains live read-only checks.

The rehearsal bridge default-denies global fetch, provides only two synthetic
transport responses, refuses any payment-bearing transport, and uses a fresh
temporary SQLite/scratch directory. Its runtime wrapper deliberately bypasses
production configuration only inside this named rehearsal process, using explicit
injected dependencies. This is not a deployment configuration or an operator
approval. Both local processes and the temporary browser profile are cleaned up
on exit. The browser's destination DNS and background networking are disabled.
The bridge is loopback-only and is not part of server startup or the app bundle.

Outputs are report.json, evidence.json, joined-rehearsal.png and local process
logs. The report records counts and flags, not cookie values or signing messages.
The screenshot banner identifies the no-sign rehearsal. Existing outer shell
status/footer labels are local build context, not live deployment findings.

## What remains before a genuine testnet demonstration

A real end-to-end purchase still requires a separately approved operator step.
Before any wallet operation, verify the actual owner authority, dedicated payer
identity, complete CLI/research exclusion sets, selected single-host persistent
volume and canonical private DB/scratch paths, no independent purchasing client,
SEC contact user-agent, deployed frontend/backend revisions and allowed origin.
Confirm the current node's testnet network, quote and deposit mechanism instead of
assuming remembered endpoint behavior. Do not load or create a key in a rehearsal.

The present runtime requires at least 1,010,000 micro test-USDC available, including
its 1 test-USDC reserve, before a 10,000 micro test-USDC call. Those are code checks,
not a verified balance or a funding recommendation. Generating/funding a payer,
depositing test tokens, signing, enabling the service and making even a test-credit
purchase remain outside this offline increment. No real-value token, gas purchase
or conversion is approved. The exact proposed testnet costs and limits must be
reported before proceeding.

After separate approval and readiness checks, one explicit purchase can establish
real ranked routing, public source recount, actual receipt identity/charge,
owner-bound evidence and read-only delivery observations. Preserve as-run HOLD or
uncertainty honestly; never force a PASS, perform a paid retry to improve a demo,
or present the offline rehearsal as proof that this later step happened.
