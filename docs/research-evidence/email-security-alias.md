# Email DNS record_type aliases

The observed evaluation failure was400 INVALID_RECORD_TYPE. The actual requested record_type value was not recorded, so a security-mechanism label such as DMARC as its cause remains an inference, not a recovered fact.

This slice accepts case-insensitive SPF, DMARC, DKIM, BIMI, MTA-STS and TLS-RPT labels. They resolve respectively to TXT at domain, _dmarc.domain, bare domain, default._bimi.domain, _mta-sts.domain and _smtp._tls.domain. DKIM explicitly does not guess a selector and does not claim a selector-specific check. All mappings are disclosed in the answer and evidence. Unrecognized types default to bare-domain TXT with explicit disclosure. Standard IANA names and valid numeric DNS types retain their existing queries. Missing parameters, invalid domain names and unknown parameters still fail400. Derived names are validated before lookup, and resolver Question name/type must exactly bind to the derived request.

lookup_ok remains DNS Status0, not record presence or email safety. BIMI NXDOMAIN is false. No absent record is fabricated. Original requested record_type is logged as JSON-escaped structured data, truncated to80 UTF-16 code units with a truncation flag. This is a bounded diagnostic requested to distinguish the inferred label issue in future evaluations.

Fixtures in tests/fixtures/email-alias are exact Google Public DNS and Cloudflare DNS JSON bodies retrieved November23,2026. provenance.json records each URL/time. Positive queries use google.com; BIMI uses default._bimi.verireceipt-probe.invalid and both resolvers returned actual NXDOMAIN Status3. No DNS body was invented or modified. Numeric16 and default/junk label tests reuse the matching actual google.com TXT query, not a made-up response.
