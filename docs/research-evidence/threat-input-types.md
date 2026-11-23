# Threat indicator type boundary, 2026-11-24

The current source set screens IPv4 addresses, DNS domains and HTTP(S) URLs.
Previously any other non-IP string was treated as a domain. A CVE identifier,
file hash, malformed IPv4 or IPv6 address could therefore receive
malicious=false solely because it was absent from unrelated domain feeds.
That is not evidence about such an identifier.

The adapter and exported matcher now validate supported types before any
feed read. CVE/hash/opaque strings refuse with UNSUPPORTED_INDICATOR_TYPE;
malformed numeric/IP-like input refuses INVALID_INDICATOR; bare IPv6 refuses
UNSUPPORTED_IP_VERSION because these feeds cover IPv4. Existing canonical
HTTP(S) URL checks and actual IPv4/CIDR/domain matching remain unchanged.
No CVE detector, new feed or new intent is claimed. Tor use alone remains
context, not maliciousness.

Existing real feed excerpts continue to exercise positive/negative IPv4,
CIDR, domain/wildcard and URL matches. Additional controls establish that
unsupported input never fetches feeds or acquires a clean-negative receipt.
This fixes a demonstrated type error. It does not identify the historical
scored question or claim a measured score improvement.
