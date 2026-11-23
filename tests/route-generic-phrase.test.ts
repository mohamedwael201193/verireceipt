import { describe, expect, it } from "vitest";
import { normalizeRoutePhrase, parseGenericPairSides, parsePair } from "../src/handlers/optimalRoute";
describe("explicit one-unit route phrases", () => {
 it.each([ ["1 ETH to USDC", "ETH/USDC"], ["WETH for USDT", "WETH/USDT"], ["USDC to ETH", "USDC/ETH"], ["LINK to USDC", "LINK/USDC"] ])("normalizes %s without reversing", (raw, pair) => {
  expect(normalizeRoutePhrase(raw)).toBe(pair); expect(parseGenericPairSides(pair)).not.toBeNull();
 });
 it.each(["2 ETH to USDC", "0.5 ETH to USDC", "ETH to SOL", "ETH\nto USDC", "ETH to USDC to DAI"])("never guesses identity or quantity for %s", raw => {
  const result = normalizeRoutePhrase(raw); expect(parsePair(result!)).toBeNull(); expect(parseGenericPairSides(result!)).toBeNull();
 });
});
