// Tests for src/handlers/tokenSupply.ts (TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL).
//
// Stubbed tests drive global fetch; LIVE tests hit the real keyless
// RPCs. Hermetic DB via a unique scratch SQLITE_PATH per run.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "supply-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import { sha256Hex } from "../src/core/receipt";
import { getReceiptEvidence } from "../src/core/storage";
import { CHAIN_RPCS } from "../src/config/chains";
import { handleTokenSupply, INTENT } from "../src/handlers/tokenSupply";
import { TOKEN_CONTRACTS } from "../src/handlers/tokenContracts";

const SHA256_RE = /^[0-9a-f]{64}$/;
const USDC_ETH = TOKEN_CONTRACTS.ethereum.USDC;

async function expectApiError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(status);
    expect(e.code).toBe(code);
    return;
  }
  throw new Error(`expected ApiError ${status}/${code} but the call succeeded`);
}

function abiString(s: string): string {
  const data = Buffer.from(s, "utf8").toString("hex");
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
  return "0x" + "20".padStart(64, "0") + s.length.toString(16).padStart(64, "0") + padded;
}

function uint256Hex(v: bigint): string {
  return "0x" + v.toString(16).padStart(64, "0");
}

function rpcResult(result: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result });
}

interface Behavior {
  results: Record<string, string>;
}

function stubSupplyFetch(table: Record<string, Behavior>): void {
  const fetchStub = async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    const behavior = table[u];
    if (!behavior) throw new Error(`unexpected fetch to ${u}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
    const data = (body.params[0] as { data: string }).data;
    const result = behavior.results[data.slice(0, 10)];
    if (result === undefined) throw new Error("leg failure");
    return { ok: true, status: 200, text: async () => rpcResult(result) } as Response;
  };
  vi.stubGlobal("fetch", fetchStub);
}

function supplyBehavior(supply: bigint, decimals: number, symbol: string): Behavior {
  return {
    results: {
      "0x18160ddd": uint256Hex(supply),
      "0x313ce567": uint256Hex(BigInt(decimals)),
      "0x95d89b41": abiString(symbol),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ETH = CHAIN_RPCS.ethereum;

describe("handleTokenSupply validation (no network use)", () => {
  it("rejects a missing token with 400 MISSING_PARAM", async () => {
    await expectApiError(handleTokenSupply({}), 400, "MISSING_PARAM");
  });

  it("rejects an unsupported chain with 400 UNSUPPORTED_CHAIN", async () => {
    await expectApiError(handleTokenSupply({ token: "USDC on solana" }), 400, "UNSUPPORTED_CHAIN");
  });

  it("rejects an unknown symbol with 422 UNSUPPORTED_TOKEN", async () => {
    await expectApiError(
      handleTokenSupply({ token: "NOPECOIN on ethereum" }),
      422,
      "UNSUPPORTED_TOKEN",
    );
  });

  it("rejects a native symbol with 422 UNSUPPORTED_TOKEN (no totalSupply contract)", async () => {
    await expectApiError(handleTokenSupply({ token: "ETH on ethereum" }), 422, "UNSUPPORTED_TOKEN");
  });

  it("rejects a contradictory chain suffix with 400 CHAIN_MISMATCH", async () => {
    await expectApiError(
      handleTokenSupply({ token: "USDC on base", chain: "ethereum" }),
      400,
      "CHAIN_MISMATCH",
    );
  });
});

describe("handleTokenSupply quorum (stubbed fetch)", () => {
  it("answers USDC supply from an agreeing 3-of-3 with decimals applied", async () => {
    const supply = 41000000123456n; // 41,000,000.123456 USDC at 6 decimals
    stubSupplyFetch({
      [ETH[0]]: supplyBehavior(supply, 6, "USDC"),
      [ETH[1]]: supplyBehavior(supply, 6, "USDC"),
      [ETH[2]]: supplyBehavior(supply, 6, "USDC"),
    });
    const res = await handleTokenSupply({ token: "USDC on ethereum" });
    expect(res.total_supply).toBe(41000000.123456);
    expect(res.token_symbol).toBe("USDC");
    expect(res.chain).toBe("ethereum");
    expect(res.confidence).toBe(1.0);
    const rc = res.receipt as { raw_response_sha256: string; quorum_votes: string; receipt_id: string };
    expect(rc.quorum_votes).toBe("3/3 sources agreed");
    const ev = await getReceiptEvidence(rc.receipt_id);
    expect(ev.found).toBe(true);
    expect(sha256Hex(ev.evidence!)).toBe(rc.raw_response_sha256);
  });

  it("accepts a raw contract address with a split chain param", async () => {
    const supply = 1000000n * 10n ** 18n;
    stubSupplyFetch({
      [ETH[0]]: supplyBehavior(supply, 18, "DAI"),
      [ETH[1]]: supplyBehavior(supply, 18, "DAI"),
      [ETH[2]]: { results: {} },
    });
    const res = await handleTokenSupply({ token: TOKEN_CONTRACTS.ethereum.DAI, chain: "ethereum" });
    expect(res.total_supply).toBe(1000000);
    expect(res.token_symbol).toBe("DAI");
    expect(res.confidence).toBe(0.9);
  });

  it("502 QUORUM_DISAGREEMENT on a persistent supply split", async () => {
    stubSupplyFetch({
      [ETH[0]]: supplyBehavior(1000n, 6, "USDC"),
      [ETH[1]]: supplyBehavior(2000n, 6, "USDC"),
      [ETH[2]]: { results: {} },
    });
    await expectApiError(handleTokenSupply({ token: "USDC on ethereum" }), 502, "QUORUM_DISAGREEMENT");
  }, 15000);

  it("502 QUORUM_UNREACHABLE when every leg fails", async () => {
    stubSupplyFetch({
      [ETH[0]]: { results: {} },
      [ETH[1]]: { results: {} },
      [ETH[2]]: { results: {} },
    });
    await expectApiError(handleTokenSupply({ token: "USDC on ethereum" }), 502, "QUORUM_UNREACHABLE");
  });
});

describe("handleTokenSupply LIVE (real RPCs, no stub)", () => {
  const LIVE_TIMEOUT_MS = 90000;

  it(
    "answers the live USDC total supply on ethereum with a verifiable receipt",
    async () => {
      const res = await handleTokenSupply({ token: "USDC on ethereum" });
      expect(res.token_symbol).toBe("USDC");
      expect(res.chain).toBe("ethereum");
      // USDC supply is tens of billions; assert a sane positive range.
      const supply = res.total_supply as number;
      expect(supply).toBeGreaterThan(1_000_000_000);
      expect(supply).toBeLessThan(1_000_000_000_000);
      const rc = res.receipt as { raw_response_sha256: string; receipt_id: string; intent: string };
      expect(rc.intent).toBe(INTENT);
      expect(rc.raw_response_sha256).toMatch(SHA256_RE);
      const ev = await getReceiptEvidence(rc.receipt_id);
      expect(ev.found).toBe(true);
      expect(sha256Hex(ev.evidence!)).toBe(rc.raw_response_sha256);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "answers the live WETH total supply on base (cross-chain map)",
    async () => {
      const res = await handleTokenSupply({ token: "WETH on base" });
      expect(res.token_symbol).toBe("WETH");
      expect(res.total_supply as number).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );
});
