// Tests for src/handlers/tokenHolders.ts (TOKEN_HOLDER_COUNT_GENERAL).
//
// Stubbed tests drive the fetch seam; LIVE tests hit the real keyless
// Blockscout indexers. Hermetic DB via a unique scratch SQLITE_PATH.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "holders-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import { getReceiptEvidence } from "../src/core/storage";
import {
  handleTokenHolders,
  INTENT,
  setTokenHoldersFetchForTests,
} from "../src/handlers/tokenHolders";
import { TOKEN_CONTRACTS } from "../src/handlers/tokenContracts";

const SHA256_RE = /^[0-9a-f]{64}$/;
const USDC_ETH = TOKEN_CONTRACTS.ethereum.USDC;
const USDC_OP = TOKEN_CONTRACTS.optimism.USDC;

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

function indexerBody(holders: number, symbol: string): string {
  return JSON.stringify({ holders_count: String(holders), symbol, decimals: "6" });
}

afterEach(() => {
  setTokenHoldersFetchForTests(null);
});

describe("validation", () => {
  it("400 when token or chain missing", async () => {
    await expectApiError(handleTokenHolders({}), 400, "MISSING_PARAM");
    await expectApiError(handleTokenHolders({ token: "USDC" }), 400, "MISSING_PARAM");
    await expectApiError(handleTokenHolders({ chain: "ethereum" }), 400, "MISSING_PARAM");
  });

  it("422 for a chain with no keyless indexer of record", async () => {
    await expectApiError(
      handleTokenHolders({ token: "USDC", chain: "base" }),
      422,
      "UNSUPPORTED_CHAIN",
    );
    await expectApiError(
      handleTokenHolders({ token: USDC_ETH, chain: "polygon" }),
      422,
      "UNSUPPORTED_CHAIN",
    );
  });

  it("422 for native coin and unverified symbol; 400 on chain conflict", async () => {
    await expectApiError(
      handleTokenHolders({ token: "ETH", chain: "ethereum" }),
      422,
      "UNSUPPORTED_TOKEN",
    );
    await expectApiError(
      handleTokenHolders({ token: "NOPE", chain: "ethereum" }),
      422,
      "UNSUPPORTED_TOKEN",
    );
    await expectApiError(
      handleTokenHolders({ token: "USDC on optimism", chain: "ethereum" }),
      400,
      "CHAIN_MISMATCH",
    );
  });
});

describe("display-label validation", () => {
  it.each([
    `USDC (${TOKEN_CONTRACTS.ethereum.DAI})`,
    `ETH (${TOKEN_CONTRACTS.ethereum.WETH})`,
  ])("rejects a contradictory label: %s", async (token) => {
    await expectApiError(handleTokenHolders({ token, chain: "ethereum" }), 400, "TOKEN_CONTRACT_MISMATCH");
  });

  it.each([
    `USDC (${USDC_ETH.slice(0, -1)})`,
    `USDC (${USDC_ETH}) (${USDC_ETH})`,
    `USDC (${USDC_ETH}) trailing`,
  ])("does not mine an address from malformed input: %s", async (token) => {
    await expectApiError(handleTokenHolders({ token, chain: "ethereum" }), 422, "UNSUPPORTED_TOKEN");
  });

  it("keeps the chain contradiction guard for display tokens", async () => {
    await expectApiError(handleTokenHolders({ token: `USDC (${USDC_ETH}) on optimism`, chain: "ethereum" }), 400, "CHAIN_MISMATCH");
  });
});

describe("stubbed indexer", () => {
  it.each([
    { token: `USDC (${USDC_ETH}) on Ethereum` },
    { token: `USDC (${USDC_ETH})`, chain: "ethereum" },
    { token: `USD Coin ( ${USDC_ETH} ) on ethereum` },
  ])("accepts display token input with receipt: %j", async (query) => {
    const body = indexerBody(9618845, "USDC");
    let seen = "";
    setTokenHoldersFetchForTests(async (url) => { seen = url; return body; });
    const out = await handleTokenHolders(query);
    expect(seen).toBe(`https://eth.blockscout.com/api/v2/tokens/${USDC_ETH}`);
    expect(out.token).toBe(USDC_ETH);
    expect(out.token_symbol).toBe("USDC");
    expect(out.holders_count).toBe(9618845);
    const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string };
    const evidence = await getReceiptEvidence(receipt.receipt_id);
    const { sha256Hex } = await import("../src/core/receipt");
    expect(sha256Hex(evidence.evidence!)).toBe(receipt.raw_response_sha256);
  });

  it("returns the count with a receipt over the exact upstream bytes", async () => {
    const body = indexerBody(9618845, "USDC");
    let seenUrl = "";
    setTokenHoldersFetchForTests(async (url) => {
      seenUrl = url;
      return body;
    });
    const out = await handleTokenHolders({ token: "USDC", chain: "ethereum" });
    expect(seenUrl).toBe(`https://eth.blockscout.com/api/v2/tokens/${USDC_ETH}`);
    expect(out.holders_count).toBe(9618845);
    expect(out.token_symbol).toBe("USDC");
    expect(out.chain).toBe("ethereum");
    expect(out.token).toBe(USDC_ETH);
    expect(out.verdict).toBe("verified");
    const receipt = out.receipt as Record<string, unknown>;
    expect(receipt.intent).toBe(INTENT);
    expect(receipt.raw_response_sha256).toMatch(SHA256_RE);
    const ev = await getReceiptEvidence(receipt.receipt_id as string);
    expect(ev.found).toBe(true);
    const { sha256Hex } = await import("../src/core/receipt");
    expect(sha256Hex(ev.evidence!)).toBe(receipt.raw_response_sha256);
    expect(Buffer.from(ev.evidence!).toString("utf8")).toBe(body);
  });

  it("accepts 'token on chain' packing and 0x contracts", async () => {
    setTokenHoldersFetchForTests(async () => indexerBody(671778, "USDC"));
    const out = await handleTokenHolders({ token: `${USDC_OP} on optimism` });
    expect(out.chain).toBe("optimism");
    expect(out.holders_count).toBe(671778);
  });

  it.each(["USDC", `USDC (${USDC_ETH})`])("422 when the indexer contradicts the requested symbol: %s", async (token) => {
    setTokenHoldersFetchForTests(async () => indexerBody(100, "USDT"));
    await expectApiError(
      handleTokenHolders({ token, chain: "ethereum" }),
      422,
      "TOKEN_SYMBOL_MISMATCH",
    );
  });

  it("502 when the indexer fails or returns garbage", async () => {
    setTokenHoldersFetchForTests(async () => {
      throw new Error("HTTP 503");
    });
    await expectApiError(
      handleTokenHolders({ token: "USDC", chain: "ethereum" }),
      502,
      "INDEXER_UNREACHABLE",
    );
    setTokenHoldersFetchForTests(async () => "<html>challenge</html>");
    await expectApiError(
      handleTokenHolders({ token: "USDC", chain: "ethereum" }),
      502,
      "INDEXER_UNREACHABLE",
    );
    setTokenHoldersFetchForTests(async () => JSON.stringify({ holders_count: "99999999999" }));
    await expectApiError(
      handleTokenHolders({ token: "USDC", chain: "ethereum" }),
      502,
      "INDEXER_UNREACHABLE",
    );
  });
});

describe("LIVE keyless indexers", () => {
  it("ethereum USDC holder count is real and large", async () => {
    const out = await handleTokenHolders({ token: `USDC (${USDC_ETH})`, chain: "ethereum" });
    expect(out.holders_count).toBeGreaterThan(1_000_000);
    expect(out.token_symbol).toBe("USDC");
    expect(out.verdict).toBe("verified");
  }, 30000);

  it("optimism USDC holder count is real", async () => {
    const out = await handleTokenHolders({ token: `USDC (${USDC_OP}) on optimism` });
    expect(out.holders_count).toBeGreaterThan(100_000);
    expect(out.token_symbol).toBe("USDC");
  }, 30000);

  it("arbitrary 0x contract resolves on ethereum (WETH)", async () => {
    const out = await handleTokenHolders({
      token: TOKEN_CONTRACTS.ethereum.WETH,
      chain: "ethereum",
    });
    expect(out.holders_count).toBeGreaterThan(10_000);
    expect(out.token_symbol).toBe("WETH");
  }, 30000);
});
