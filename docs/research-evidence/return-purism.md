# Purism US return policy binding

Source: https://docs.puri.sm/about/policy.html, fetched 26 November 2026 with the production reader's exact request (UA "VeriReceipt/2.0 public-source observer", Accept: application/json, redirects refused): HTTP 200, 88694 bytes, raw sha256 in tests/fixtures/return-expanded/section-provenance.json.

Reviewed section: from "All returned products are processed via Return Merchandise Authorization" up to the Refunds heading. Window 14 calendar days from initial date of delivery (RMA request), shipment postmarked within 3 calendar days of RMA receipt, like-new or better, original packaging, 20% restocking fee unless the return results from a Purism mistake in configuration or packaging. The fixture is the extracted section only, not a full HTTP capture; the committed section hash was also checked against the live response bytes.

# Framework return policy binding

Source: https://frame.work/terms-of-sale, Article 10 (10.1 to 10.3), fetched 26 November 2026. The production reader's default `Accept: application/json` gets HTTP 415 (content negotiation, not a block); the same URL with `Accept: text/html`, honest UA, no redirects, returns 200 (129369 bytes). The binding therefore carries a per-binding `accept: text/html`; every other binding and reader keeps the default. 10.1 is quoted as written ("within 30 days of the date the Product was delivered to you", "for any or no reason"). The article states no regions, so none is claimed; the binding name is "Framework" (not "Framework US"). Note the shared handler scope sentence still says "Standard US retailer policy only".
