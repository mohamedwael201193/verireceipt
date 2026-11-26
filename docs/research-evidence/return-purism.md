# Purism US return policy binding

Source: https://docs.puri.sm/about/policy.html, fetched 26 November 2026 with the production reader's exact request (UA "VeriReceipt/2.0 public-source observer", Accept: application/json, redirects refused): HTTP 200, 88694 bytes, raw sha256 in tests/fixtures/return-expanded/section-provenance.json.

Reviewed section: from "All returned products are processed via Return Merchandise Authorization" up to the Refunds heading. Window 14 calendar days from initial date of delivery (RMA request), shipment postmarked within 3 calendar days of RMA receipt, like-new or better, original packaging, 20% restocking fee unless the return results from a Purism mistake in configuration or packaging. The fixture is the extracted section only, not a full HTTP capture; the committed section hash was also checked against the live response bytes.

# Framework return policy binding

Source: https://frame.work/terms-of-sale, Article 10 (10.1 to 10.3), fetched 26 November 2026. The production reader's default `Accept: application/json` gets HTTP 415 (content negotiation, not a block); the same URL with `Accept: text/html`, honest UA, no redirects, returns 200 (129369 bytes). The binding therefore carries a per-binding `accept: text/html`; every other binding and reader keeps the default. 10.1 is quoted as written ("within 30 days of the date the Product was delivered to you", "for any or no reason"). The article states no regions, so none is claimed; the binding name is "Framework" (not "Framework US"). Note the shared handler scope sentence still says "Standard US retailer policy only".

# Verified batch (26 November 2026), production request (UA "VeriReceipt/2.0 public-source observer", Accept: application/json, no redirects)

Bound (200, readable policy text, section hash matched on three separate fetches): Samsung US (15 days from delivery), GameStop (15 days new unopened, 7 days collector, pre-owned and PC/TV), Walgreens (30 days from purchase). Fixtures are extracted sections only; raw sha256 in section-provenance.json.

Not bound, with status: Dell 200 on the first fetch but 403 on an immediate repeat (unstable access, no retry or bypass); Amazon 406 on JSON accept (200 with text/html but no readable window text found); Ulta 200 with no policy text; Gap 200 but the URL is loyalty terms, not the return policy; Wayfair 429; B&H, Sephora, CVS, Adidas, Home Depot, Lowe's 403; Chewy and Lenovo redirect (refused); REI connection error. Skip list from the parent (Kohl's, Nike, Staples, Micro Center, Newegg, Zappos, Nordstrom, Patagonia) not attempted. Probes ran from the build sandbox, not the production host; a production-side 403 would surface as POLICY_UNVERIFIED, never a guessed window.
