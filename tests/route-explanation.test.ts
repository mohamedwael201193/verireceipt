import { describe, expect, it } from "vitest";
import { explainRouteQuote } from "../src/core/routeExplanation";
const base = { blockNumber: 26465271, venue: "Uniswap V3 (fee 500)", amountOut: 1_681_090_835n, survivingQuotes: 3, degradedReasons: [] as string[] };

describe("route explanation, measured scope rather than global optimality", () => {
  it("keeps exact base units, six decimal USDC, pair, amount, venue and block", () => {
    const s = explainRouteQuote(base);
    for (const text of ["exactly 1 ETH", "Ethereum mainnet", "Uniswap V3 (fee 500)", "block 26465271", "1681.090835 USDC", "1681090835 base units, 6 decimals"]) expect(s).toContain(text);
  });
  it.each([[1n, "0.000001"], [1_000_000n, "1.000000"], [9_999_999_999n, "9999.999999"]])("formats %s exactly without float rounding", (amountOut, value) => {
    expect(explainRouteQuote({ ...base, amountOut })).toContain(`${value} USDC`);
  });
  it("scopes the above-range addition to explicit token decimals, not legacy registry rendering", () => {
    const high = { ...base, amountOut: 900_000_000_000n };
    expect(explainRouteQuote(high)).not.toContain("above the published");
    expect(explainRouteQuote({ ...high, buyDecimals: 6 })).toContain("above the published");
    expect(explainRouteQuote({ ...base, amountOut: 3n, buyDecimals: 6 })).not.toContain("stable-pair quote");
  });
  it("bounds selection to surviving supported venue quotes", () => {
    const s = explainRouteQuote(base);
    expect(s).toContain("3 venue quotes that survived");
    expect(s).toContain("not every pool, aggregator or split route");
    expect(s).toContain("plausibility filters");
  });
  it("does not claim net optimality, impact, protection, a user limit or execution", () => {
    const s = explainRouteQuote(base);
    for (const text of ["Gas costs are not deducted", "not a best-net-execution claim", "Price impact is not separately measured", "no slippage limit or MEV protection is applied", "does not submit a swap"]) expect(s).toContain(text);
    expect(s).not.toMatch(/0\.5%|1%|guarantee|risk.free|rank/i);
  });
  it("names missing coverage without changing the quote", () => {
    const s = explainRouteQuote({ ...base, survivingQuotes: 1, degradedReasons: ["fewer than three venues produced plausible quotes"] });
    expect(s).toContain("1 venue quote that survived");
    expect(s).toContain("Coverage is degraded: fewer than three venues produced plausible quotes.");
    expect(s).toContain("1681090835 base units");
  });
  it("does not invent degradation on a full run or mutate input", () => {
    const copy = { ...base, degradedReasons: [...base.degradedReasons] };
    expect(explainRouteQuote(base)).not.toContain("Coverage is degraded");
    expect(base).toEqual(copy);
  });
});
