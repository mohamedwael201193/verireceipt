# Liquidity source deadline

Captured 2026-11-23 at 20:59:51 UTC from:

https://api.dexscreener.com/latest/dex/pairs/ethereum/0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640

The capture returned HTTP 200 in 0.162 seconds. Its full response body is retained in `tests/fixtures/liquidity-deadline/ethereum-usdc-weth.json`. This one fast response does not measure slower production calls.

## Change

The DexScreener network deadline is 2500 ms, previously 850 ms. The liquidity observation runner deadline is 3000 ms, previously 900 ms. Increasing only the network deadline would still leave normal slower responses rejected by the runner.

No cache is added. Each successful call still obtains a new source body. The runner preserves the original retrieval timestamp, raw body, identity validation and receipt digest. Price and yield deadlines remain unchanged. CEX depth uses its existing separate handler.

## Checks

Four deadline tests replay the captured body. A response delayed to 2400 ms succeeds through the wired handler, with the exact source bytes and independently recomputed receipt digest. A 2700 ms response is aborted at 2500 ms. An upstream that ignores abort is rejected by the runner at 3000 ms and cannot create a late receipt. Price and yield still reject slow observations under their existing deadlines.

Reverting either deadline independently fails the slow-success regression. Removing either deadline independently fails its refusal regression. Nine focused suites pass, 118 tests. The selected liquidity-related route controls pass, 8 tests. The build passes.

A broader route suite run exceeded a 45-second execution bound before its summary. It is not counted as a completed suite. No changes to route execution are included in this slice.
