// Tests for src/handlers/optimalRoute.ts
// Unit tests use local fixtures only. The live test hits REAL Ethereum
// mainnet RPCs and REAL quoter contracts (no mocks anywhere in handler code).
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/core/errors";
import {
  buildV2AmountsOutCalldata,
  buildV3QuoteCalldata,
  decodeV2AmountsOut,
  decodeV3QuoteReturn,
  handleRoute,
  pickBestQuote,
  type VenueQuote,
} from "../src/handlers/optimalRoute";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function fakeQuote(venue: string, amountOut: bigint): VenueQuote {
  return { venue, amountOut, request: {}, response: {} };
}

describe("pair validation (422, unbilled)", () => {
  it("pair missing -> 422 INVALID_PAIR", async () => {
    await expect(handleRoute({})).rejects.toMatchObject({
      status: 422,
      code: "INVALID_PAIR",
    });
    try {
      await handleRoute({});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      expect((err as ApiError).code).toBe("INVALID_PAIR");
    }
  });

  it('pair "BTC/USDC" -> 422 INVALID_PAIR', async () => {
    await expect(handleRoute({ pair: "BTC/USDC" })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_PAIR",
    });
  });

  it('pair "eth/usdc" (wrong case) -> 422 INVALID_PAIR', async () => {
    await expect(handleRoute({ pair: "eth/usdc" })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_PAIR",
    });
  });

  it('pair "ETH/USDC " (trailing space) -> 422 INVALID_PAIR', async () => {
    await expect(handleRoute({ pair: "ETH/USDC " })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_PAIR",
    });
  });
});

describe("max-pick logic", () => {
  it("the max amount_out wins", () => {
    const best = pickBestQuote([
      fakeQuote("Uniswap V3 (fee 500)", 1738281078n),
      fakeQuote("Uniswap V2", 1731634058n),
      fakeQuote("SushiSwap V2", 1704664137n),
    ]);
    expect(best?.venue).toBe("Uniswap V3 (fee 500)");
    expect(best?.amountOut).toBe(1738281078n);
  });

  it("ties keep the first venue (strict max)", () => {
    const best = pickBestQuote([
      fakeQuote("Uniswap V2", 1700000000n),
      fakeQuote("SushiSwap V2", 1700000000n),
    ]);
    expect(best?.venue).toBe("Uniswap V2");
  });

  it("empty quote list -> null", () => {
    expect(pickBestQuote([])).toBeNull();
  });

  it("a single quote wins by default", () => {
    expect(pickBestQuote([fakeQuote("Uniswap V2", 42n)])?.venue).toBe("Uniswap V2");
  });
});

describe("ABI encoding / decoding", () => {
  it("V3 calldata uses selector 0xc6a5026a and encodes 1 ETH + fee", () => {
    const data = buildV3QuoteCalldata(WETH, USDC, 1000000000000000000n, 3000);
    expect(data.startsWith("0xc6a5026a")).toBe(true);
    expect(data).toContain("c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
    expect(data).toContain("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(data).toContain("0de0b6b3a7640000"); // 1 ETH in wei
    expect(data).toContain("0000000000000000000000000000000000000000000000000000000000000bb8"); // fee 3000
    expect(data.length).toBe(2 + 8 + 64 * 5);
  });

  it("V2 calldata uses selector 0xd06ca61f and encodes the WETH->USDC path", () => {
    const data = buildV2AmountsOutCalldata(1000000000000000000n, [WETH, USDC]);
    expect(data.startsWith("0xd06ca61f")).toBe(true);
    expect(data).toContain("c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
    expect(data).toContain("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(data.length).toBe(2 + 8 + 64 * 5);
  });

  it("decodeV3QuoteReturn reads the first word as amountOut", () => {
    const amountOut = "0000000000000000000000000000000000000000000000000000000067a1e2b6";
    const rest = "00".repeat(96);
    expect(decodeV3QuoteReturn("0x" + amountOut + rest)).toBe(0x67a1e2b6n);
  });

  it("decodeV2AmountsOut reads the last element of the array", () => {
    const offset = "0000000000000000000000000000000000000000000000000000000000000020";
    const length = "0000000000000000000000000000000000000000000000000000000000000002";
    const inAmt = "0000000000000000000000000000000000000000000000000de0b6b3a7640000";
    const outAmt = "0000000000000000000000000000000000000000000000000000000067a1e2b6";
    expect(decodeV2AmountsOut("0x" + offset + length + inAmt + outAmt)).toBe(0x67a1e2b6n);
  });

  it("decoders reject malformed return data", () => {
    expect(() => decodeV3QuoteReturn("0x1234")).toThrow();
    expect(() => decodeV2AmountsOut("0x1234")).toThrow();
    expect(() => decodeV2AmountsOut("0x" + "00".repeat(64))).toThrow();
  });
});

describe("live: real mainnet RPCs + real quoter contracts", () => {
  it(
    'pair "ETH/USDC" returns a positive integer amount_out with a receipt',
    async () => {
      const result = await handleRoute({ pair: "ETH/USDC" });
      expect(typeof result.amount_out).toBe("number");
      expect(Number.isInteger(result.amount_out)).toBe(true);
      expect(result.amount_out as number).toBeGreaterThan(0);
      expect(result.verdict).toBe("verified");
      expect(result.confidence === 1.0 || result.confidence === 0.9).toBe(true);
      expect(typeof result.block_number).toBe("number");
      expect(typeof result.winning_venue).toBe("string");
      expect(typeof result.answer).toBe("string");
      expect(result.source).toContain("Block-pinned");

      const receipt = result.receipt as Record<string, unknown>;
      expect(typeof receipt.receipt_id).toBe("string");
      expect(receipt.intent).toBe("OPTIMAL_EXECUTION_ROUTE");
      expect(typeof receipt.upstream_url).toBe("string");
      expect(receipt.raw_response_sha256).toMatch(/^0x[0-9a-f]{64}$/);
      expect(typeof receipt.quorum_votes).toBe("string");
      expect(typeof receipt.fetched_at).toBe("string");
      expect(typeof receipt.audit_url).toBe("string");

      // Exact live observation, printed for the build report.
      console.log(
        `LIVE route: amount_out=${result.amount_out} block=${result.block_number} ` +
          `venue=${result.winning_venue} confidence=${result.confidence} ` +
          `upstream=${receipt.upstream_url} votes=${receipt.quorum_votes}`,
      );
    },
    { timeout: 60000 },
  );
});
