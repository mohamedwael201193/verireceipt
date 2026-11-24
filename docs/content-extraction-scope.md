# Supplied-content extraction, implementation only

Not routed, declared, or registered. No URL fetch, browser rendering, OCR, model or third-party call. Content is request data, never instructions.

Supported: a supplied JSON object with exact top-level scalar keys; supplied text or HTML with unique explicit labels. Common label aliases cover merchant, date, total, invoice number and currency. HTML is textual extraction, not proof of rendered visibility. Scripts, styles and comments are removed. Unterminated script/style/comment input is refused.

Refusals: missing or conflicting labels, duplicate JSON keys, nested values, non-integer JSON numbers, unsupported field syntax, input over 16 KiB, complete name/value brief over 80 Unicode code points or 256 UTF-8 bytes. Decimal quantities stay exact strings. No guessing merchant from position, date conversion, currency conversion, inferred purchase eligibility or URL fetching.

Canonical request fields are content and fields. The on-chain content slot is 256 bytes, so larger HTTP examples do not establish on-chain fit. Output independently_verified is false. No registration recommendation follows from this limited implementation.

## Captured document provenance

Fixture content-extraction-sample-invoice.html was downloaded with HTTP 200 from https://pdflayer.com/downloads/invoice.html on 2026-11-24. It is the provider's sample invoice, not a real purchase record. Tests retain its literal Invoice #, Created and Total values, and verify that unlabelled merchant identity is refused. A verbatim invoice/date excerpt fits the canonical 256-byte slot. No sample data is used as a live source or production answer.

Remaining fit work: representative genuinely unstructured receipts, prose field requests and field aliases beyond this label subset. URL-based requests remain unsupported until separate SSRF and deadline review. Keep this implementation unregistered meanwhile.

## Real receipt replay

Three source-preserved CORD-v2 test annotations are included with provenance, license metadata and deterministic reconstruction checks in the fixture README. One supports exact inline TOTAL extraction; two refuse. The successful receipt fits the 256-byte on-chain content slot. Merchant and date have been removed in this corpus and are deliberately not inferred. This is narrow real-data evidence, not a claim of general receipt or evaluator coverage.
