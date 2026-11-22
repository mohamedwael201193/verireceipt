// Shared alias selection only. Unknown networks must remain unsupported.
// Network identity references:
// https://docs.arbitrum.io/chain-info.md
// https://docs.optimism.io/op-mainnet/network-information/connecting-to-op
// https://docs.polygon.technology/pos/reference/rpc-endpoints
import { describe, expect, it } from "vitest";
import { normalizeChain } from "../src/handlers/txLookup";

describe("shared exact chain aliases", () => {
  it.each([
    ["Arbitrum One", "arbitrum"],
    ["  ARBITRUM   ONE  ", "arbitrum"],
    ["arbitrum-one", "arbitrum"],
    ["arb", "arbitrum"],
    ["on Arbitrum One", "arbitrum"],
    ["OP Mainnet", "optimism"],
    ["op-mainnet", "optimism"],
    ["on OP Mainnet", "optimism"],
    ["Polygon PoS", "polygon"],
    ["polygon-pos", "polygon"],
    ["MATIC", "polygon"],
    ["on polygon pos", "polygon"],
    ["Ethereum", "ethereum"],
    ["Ethereum Mainnet", "ethereum"],
    ["base-sepolia", "base-sepolia"],
    ["sepolia", "sepolia"],
    // Coverage expansion 2026-11-22 (epoch-36+ question mix):
    ["op", "optimism"],
    ["BSC", "bsc"],
    ["BNB", "bsc"],
    ["BNB Smart Chain", "bsc"],
    ["binance smart chain", "bsc"],
    ["56", "bsc"],
    ["eip155:56", "bsc"],
    ["Avalanche", "avalanche"],
    ["AVAX", "avalanche"],
    ["Avalanche C-Chain", "avalanche"],
    ["43114", "avalanche"],
    ["eip155:43114", "avalanche"],
    ["Gnosis", "gnosis"],
    ["Gnosis Chain", "gnosis"],
    ["xdai", "gnosis"],
    ["100", "gnosis"],
    ["eip155:100", "gnosis"],
    ["Linea", "linea"],
    ["59144", "linea"],
    ["eip155:59144", "linea"],
    ["Scroll", "scroll"],
    ["534352", "scroll"],
    ["eip155:534352", "scroll"],
  ])("%s selects exactly %s", (input, expected) => {
    expect(normalizeChain(input)).toBe(expected);
  });

  it.each([
    "arbitrum nova", "arbitrum sepolia", "polygon zkevm",
    "op sepolia", "optimism sepolia", "arb-nova", "polkadot",
  ])("does not collapse a different or unknown network: %s", (input) => {
    expect(normalizeChain(input)).toBe(input);
  });

  it("keeps missing input missing", () => {
    expect(normalizeChain(undefined)).toBeUndefined();
  });
});
