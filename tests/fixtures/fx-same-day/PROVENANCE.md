# Same-day FX source evidence

Retrieved November 23, 2026 at about 15:52 UTC. The exact requested source
URLs are in urls.json. Files are unmodified upstream bodies. ecb.txt is
independent reference evidence, not an extra runtime source.

All five source date labels are November 23, yet their snapshot values
differ. EUR and SEK exceed the 0.5% full-pool tolerance. The two ECB-fix
republishers form a tight pair. This demonstrates same-date divergence;
it does not prove publication timing caused every excluded quote.

Tests also mutate these real bodies for deliberately invalid no-pair
controls. Those variants are test-only and are never served as live data.
