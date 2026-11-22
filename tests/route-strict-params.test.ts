// External QA-09 (2026-11-21): /v1/route?pair=ETH/USDC&amount=2 returned 200
// with a 1-ETH quote — the unsupported economic parameter was silently
// ignored. pair is the only declared parameter (miner.yaml); any other key
// is now 400 UNKNOWN_PARAM, decided before a single RPC call, unbilled and
// with no receipt (same contract as /v1/validator and /v1/filings).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { ApiError } from "../src/core/errors";
import { handleRouteWithRpcs } from "../src/handlers/optimalRoute";

let rpcHits = 0;
let server: Server;
let rpcUrl = "";

beforeAll(async () => {
  server = createServer((_req, res) => {
    rpcHits += 1;
    res.writeHead(500).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function expectUnknown(query: Record<string, string | undefined>, key: string) {
  const before = rpcHits;
  try {
    await handleRouteWithRpcs(query, [rpcUrl, rpcUrl, rpcUrl]);
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).code).toBe("UNKNOWN_PARAM");
    expect((err as ApiError).message).toContain(`"${key}"`);
    expect((err as ApiError).message).toContain("takes only pair");
  }
  expect(rpcHits).toBe(before);
}

describe("QA-09 /v1/route strict parameter contract", () => {
  it("amount=2 is 400 UNKNOWN_PARAM, never a 200 1-ETH quote", async () => {
    await expectUnknown({ pair: "ETH/USDC", amount: "2" }, "amount");
  });

  it.each(["slippage", "recipient", "token", "amount_in", "chain"])("%s is rejected", async (key) => {
    await expectUnknown({ pair: "ETH/USDC", [key]: "1" }, key);
  });

  it("an unknown key is rejected even when pair is missing or wrong", async () => {
    await expectUnknown({ amount: "2" }, "amount");
    await expectUnknown({ pair: "BTC/USDC", amount: "2" }, "amount");
  });

  it("pair alone still reaches validation and the RPC path (no false refusal)", async () => {
    // 2026-11-22 (owner decision): a well-formed unregistered pair gets
    // the 400 unavailable envelope before any RPC work, not a 422.
    const err = await handleRouteWithRpcs({ pair: "BTC/USDC" }, [rpcUrl]).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).responseBody).toMatchObject({ status: "unavailable" });
    const before = rpcHits;
    await expect(handleRouteWithRpcs({ pair: "ETH/USDC" }, [rpcUrl, rpcUrl, rpcUrl])).rejects.toBeInstanceOf(ApiError);
    expect(rpcHits).toBeGreaterThan(before);
  });
});
