# Official plain-200 policy expansion

One spaced direct request per candidate,26November2026, no follow redirects, browser/proxy workaround or retry of blocked pages. Discovery used official search hits, not free-text domain construction. Added exact US bindings for Best Buy, Macy's, Etsy, eBay and L.L.Bean. Numeric windows15/30only where the body explicitly supports them. Etsy/eBay seller-specific windows remain null. L.L.Bean one-calendar-year wording retained with days:null rather than a possibly wrong365dayconversion. Conditions and exceptions only from reviewed page section. Quotes, source URL and fetch time returned. Each read must match the reviewed section SHA-256 or refuse; existing review expiry1December2026retained. No order/item-specific eligibility calculation. Runtime receipt hashes actual full response bytes; test fixtures are extracted text sections with original full-response and section hashes, not represented as full HTTP captures.

Added sources:
- https://www.bestbuy.com/site/help-topics/return-exchange-policy/pcmcat260800050014.c?id=pcmcat260800050014
- https://www.macys.com/customer-service/articles/what-is-macys-return-policy
- https://help.etsy.com/hc/en-us/articles/7869401615255-How-do-I-Set-Return-Policies-on-My-Listings
- https://www.ebay.com/help/policies/member-behaviour-policies/return-policy?id=4041
- https://www.llbean.com/llb/shop/510624?page=returns-and-exchanges

Dropped candidates, no runtime fetch binding:
- Home Depot,Lowe's,Adidas,Newegg,B&H:403
- Wayfair:429
- Chewy:308redirect, not followed
- Nike,REI,Nordstrom:200but body missing readable policy content/JS-only
- Gap:200navigation sidebar only, no policy content
- Patagonia:200return-action page, no window policy content
- Amazon: prior unreadable coverage-only URL removed, not retried

Existing Apple,Walmart,Costco,Target,IKEA policy bindings retained. Existing rejected retailer names now get local coverage-only null with no attempted source or fetched-body claim. New bound source failure refuses; does not preserve old window. No unknown merchant URL is fetched.
