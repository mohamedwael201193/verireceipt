# Definitive negative DNS for server uptime

A definitive two-resolver NXDOMAIN answer now returns reachable_now false, status unreachable, dns_result NXDOMAIN and http_attempted false. The answer states that the host does not resolve, so it is not reachable, and no HTTP measurement was possible. This is a point-in-time DNS observation, not an uptime percentage or history.

The existing public-target safety guard runs first. Private targets, unsupported ports and transient OS DNS failures never trigger confirmation. OS timeout, EAI_AGAIN, ESERVFAIL and ETIMEOUT remain unknown. After an eligible DNS failure, two fixed public DoH endpoints must both return Status3 for the exact requested A question, without truncation or answers. NOERROR, SERVFAIL, a wrong question, conflicting answers, bad bodies and HTTP errors remain unknown. No target HTTP request is made during confirmation. Public resolvable targets keep the existing pinned-address HTTP check.

Confirmation has one two-second deadline including abort-ignoring body reads, no redirects and a 64KiB body limit. The existing guard's DNS refusal metadata adds an optional temporary_failure flag; existing API-health semantics remain unchanged. Only locally marked guard errors can enter this path. Existing per-target/rate/capacity limits remain.

The NXDOMAIN receipt stores both exact DNS response bodies and URLs, with no made-up target measurement. Storage failure refuses rather than serving an unreceipted answer. Only the existing closed guard-code event is logged, never the hostname or DNS response text.

## Evidence

Self-recorded real public DNS responses and headers for the reserved negative name are in tests/fixtures/uptime-dns, with request URLs, capture time, hashes and byte lengths. These are capture provenance, not independently authenticated observations.

- https://dns.google/resolve?name=missing.verireceipt.invalid&type=A
- https://cloudflare-dns.com/dns-query?name=missing.verireceipt.invalid&type=A

## Local validation

- 266 root test files accounted across bounded chunks and route/transaction whole-describe partitions; 5,503 passing tests, 250 ordinary skips plus 19 excluded live-network route/transaction tests. This is not an unfiltered live integration pass. Conditional database skips are not claimed as database coverage.
- All final chunks and route/transaction partitions ran on reviewed metric v3 plus this replacement uptime change.
- Targeted uptime/API-health suite: 56 passing tests, including 28 new negative-DNS tests.
- 21 isolated mutants RED, including handler wiring, both-resolver requirement, exact DNS question/status, truncation/answer/body guards, HTTP status, deadline, OS temporary/deadline exclusions, false/status/no-HTTP disclosure and mandatory receipt persistence. Test controls were strengthened when early mutants survived instead of claiming false kills.
- Source TypeScript and diff whitespace checks pass after mutation restoration.

No backend deployment, registry change or wallet transaction is included.

Review revision: TC must be the boolean false. String true, numeric1, object, null and missing TC all remain unknown at the handler. The matching isolated mutant fails.
