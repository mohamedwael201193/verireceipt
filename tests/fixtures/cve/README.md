# CVE source snapshots

Exact JSON responses retrieved on 2026-11-22 for parser and historical-question regression tests. These are dated source evidence, not fresh live state. Tests also query the live sources.

- `cve-log4j-nvd.json`: https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2021-44228
- `cve-log4j-mitre.json`: https://cveawg.mitre.org/api/cve/CVE-2021-44228
- `CVE-2024-3094.json`: https://cveawg.mitre.org/api/cve/CVE-2024-3094
- `CVE-2014-0160.json`: https://cveawg.mitre.org/api/cve/CVE-2014-0160
- `CVE-2017-0144.json`: https://cveawg.mitre.org/api/cve/CVE-2017-0144
- `cve-eternalblue-nvd.json`: https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2017-0144

The test that injects a conflicting score changes a parsed copy in memory solely to prove refusal. It does not change these original snapshots or production evidence.
