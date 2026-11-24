# BIN references and attribution

The secondary service https://api.dharun.dev/v1/bin/411111 provides a keyless JSON API. Its project README explicitly states calling the API does not impose a licence on the caller's app, and identifies card BIN data as CC BY4.0. No service implementation code was copied. The source response preserves its own dataset version and retrieval date. Current terms and source checked 2026-11-23.

Card prefixes from BIN List Data by Venelin Kochev (binlookup.io), CC BY4.0: https://creativecommons.org/licenses/by/4.0/ . The author and source are credited in every answer and evidence record. Network/type text is lowercased, empty fields omitted, and non-empty fields merged with binlist.net taking precedence. Conflicts remain listed. Reference snapshot data is not proof that an actual card is real or active; a BIN has no checksum.

Captured live bodies: 411111 is VISA debit, Poland; 516732 Mastercard debit, Greece; 999999 RuPay debit, India. The last is deliberately not hardcoded as no-record: binlist returns an empty record while the secondary reference returns a record. Both raw responses are preserved. Public reference data can be wrong or stale.

Both sources are attempted concurrently with3s timeouts, including body read. A found source supports a partial-coverage positive; a negative requires both sources to return no record. Both-down and incomplete-negative states return502. Results cache up to24h, retaining original bytes and acquisition time. No access-control workaround or HandyAPI call is used.
