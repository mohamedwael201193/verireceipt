# Short holder failure cache

24 November 2026. Source policy only, no new endpoint, token binding, manifest or deployment change.

GeckoTerminal retains five-minute fresh reuse. After expiry, one source attempt is allowed per check. A source HTTP/network failure or invalid response may reuse the same URL's validated original body only below ten minutes acquisition age. Thus there are at most five additional minutes of disclosed stale fallback. The provider holders.last_updated must still pass the existing 24-hour age check. Neither original bytes nor acquisition timestamp is advanced. At ten minutes or with no valid cached observation, failures remain errors. HTTP429 cooldown remains; no automatic second Gecko request.

Synthetic failure controls replay the already-recorded real Base USDC body; no new Gecko probes or fabricated live captures. Controls cover exact boundary, timestamp/bytes, cross-token isolation, disclosure, persistence, deadlines, queue pacing, and single-attempt behavior.

Blockscout alternatives were not added. Single access checks returned HTTP403; no alternate access was attempted. Official documentation lists explorer hosts, but that is not proof of current keyless API availability. See https://docs.blockscout.com/devs/replace-links and https://docs.blockscout.com/base-api .

Existing shared registry already resolves USDT/WBTC on Ethereum, Arbitrum, Optimism and Polygon. Base USDT/WBTC remain unbound in this slice. Base-native WBTC is listed at https://docs.wbtc.network/resources/contract-addresses but differs from a separately surfaced bridged representation. This slice does not select between them. Tether's supported-protocol page https://tether.to/supported-protocols/ does not establish a Base USDT binding.
