# Reported company profile parser, implementation only

This parser is not routed, declared, or registered. It does not claim general B2B enrichment or current payroll. It accepts source bytes only, not user-selected URLs. A future source adapter needs live fetch/deadline/cache policy and raw-response receipt persistence review.

Reviewed source pair, fetched25November2026:
- https://www.microsoft.com/investor/reports/ar26/index.html , official Microsoft annual report, HTTP200.
- https://data.sec.gov/submissions/CIK0000789019.json , official SEC submissions metadata, HTTP200.

Fixtures retain the source bodies, not generated company details. Public full-time count223000 is approximate and as of30June2026, from the Human Capital Resources section. Industry is the SEC SIC description, not a free-form model judgement. The reported business address is not labelled headquarters. Domain microsoft.com is bound to the official source host. Source-byte capture is not cryptographic proof of source authenticity or continuing live availability.

The parser binds Microsoft identity, reviewed SIC, latest annual10-K accession/report date/document and source title. A newer10-K or annual amendment refuses rather than carrying old counts forward. Duplicated/absent human-capital sentence, basis changes, changed report date, future filing, over400-day report age, malformed/misaligned arrays or missing address refuse. Hardcoded identity/date constraints are support boundaries, not fallback company values. The numeric count is extracted, not hardcoded.

This is narrow prototype coverage. Other companies are unsupported. GLEIF alone supplies legal-entity data, not universal employee count/industry. Apple submissions worked, but direct filing HTML returned403, and structured companyfacts did not expose headcount; that path was stopped rather than bypassed. Official source documentation: https://www.sec.gov/search-filings/edgar-application-programming-interfaces and https://www.gleif.org/en/lei-data/access-and-use-lei-data/ .

The canonical B2B intent has employee_count with no explicit date/basis slot. Any future route must expose/report the date and basis prominently, never imply that an annual count is measured now. No declaration recommendation follows from this parser alone.
