# Email DNS lookup status

`GET /v1/email-security?domain=www.iana.org&record_type=MX`

Backend implementation for `EMAIL_SECURITY_GENERAL`. This document describes the code, not confirmation of a live deployment or on-chain registration.

`lookup_ok` means the public resolver returned DNS status 0 (NOERROR). It does not mean an MX/TXT record exists. Empty answers and CNAME-only answers can still be NOERROR. Other valid DNS status codes return false. This is not a mailbox-delivery, sender-authentication, spam, phishing or domain-safety check.

- Names support IDNs, underscores, a trailing dot, numeric owner labels and the DNS root. URLs and email addresses are rejected. Numeric labels are not rewritten as IPv4 shorthand.
- Types accept current IANA RR type names, decimal values 1–65535, `TYPE<number>` notation, `ANY` and `*`. Both sources receive numeric types. The checked-in IANA registry snapshot was retrieved November 22, 2026. New future names can be queried by number.
- Unknown and repeated query keys are rejected, including repeated percent-decoded keys.
- Two fixed HTTPS sources, Google Public DNS and Cloudflare, are queried. No caller-supplied upstream URL is accepted, and redirects are refused.
- A source has a 900 ms whole-request deadline, including body reads, and a 256 KiB byte cap. At most 12 outstanding source reads share the helper. Ignored cancellation cannot create unlimited concurrent reads.
- Usable answers must match the requested DNS question. A positive/negative split returns an error rather than choosing or averaging. One usable source is explicitly labeled degraded. HTTP errors, malformed bodies and timeouts are not DNS false.
- A truncated response is identified as truncated. Only its DNS status is used; no record-presence claim is made.

The receipt hashes stored evidence JSON, including exact UTF-8 resolver response text, source URLs, query binding, actual fetch times and unavailable-source codes. Verify the bytes served by `/receipts/:id/raw` against the receipt hash. They are not a claim that a later refetch has identical bytes. Receipt persistence must succeed before an answer is returned.

This first implementation does not yet have a last-known-good cache or a per-source circuit breaker. UI, registration and deployment are separate work. Do not advertise this as a completed live intent until those stages are verified.

Request observability uses fixed intent labels, HTTP status and latency only. It does not collect request URLs, query values, payloads, headers, IP addresses or user identifiers. Aggregate counters appear under `requests` in `/health`; they reset when the process restarts. Intent responses also emit a small structured completion log.

Sources:
- https://developers.google.com/speed/public-dns/docs/doh/json
- https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/
- https://www.iana.org/assignments/dns-parameters/dns-parameters-4.csv
