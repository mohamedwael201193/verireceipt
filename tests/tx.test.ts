// Tests for src/handlers/txLookup.ts (ONCHAIN_TX_LOOKUP_GENERAL).
//
// Unit tests use local fixtures only. Live tests hit the REAL public archive
// RPCs from src/config/chains.ts — no mocks anywhere in handler code.
// Live hashes below were verified against the RPCs before being written here.
import { createHash, randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/core/errors";
import { envelope, makeReceipt, sha256Hex } from "../src/core/receipt";
import { handleTx, weiToEth } from "../src/handlers/txLookup";

// Verified live 2026-11-20 on ethereum-rpc.publicnode.com, eth.drpc.org,
// rpc.mevblocker.io and eth-mainnet.public.blastapi.io:
//   status 0x1, block 0x193a989 (26454409), value 0x0,
//   from 0x5875db54cd9ae2b2a875e09bb731772297ae9d92,
//   to   0x0000000aa232009084bd71a5797d089aa4edfad4
const CONFIRMED_TX = "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3";

// Verified live 2026-11-20 (publicnode + drpc): status 0x0,
// block 0x193a98b (26454411),
// from 0x60a518fbbc32d1bedcc02c7d6c7dff5f477e1aec,
// to   0x7156b23feaf295e109d69148665bff737809cea4
const REVERTED_TX = "0x1a1467893eaed124a13164b589f1ed7a70ec203257084a7be27eee8f93bd8ba9";

const SHA256_RE = /^0x[0-9a-f]{64}$/;

async function expectApiError(
  p: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(status);
    expect(apiErr.code).toBe(code);
    return;
  }
  throw new Error(`expected ApiError ${status}/${code} but the call succeeded`);
}

describe("handleTx validation (unit, no network)", () => {
  it("rejects a too-short hash with 400 INVALID_TX_HASH", async () => {
    await expectApiError(
      handleTx({ tx_hash: "0x1234", chain: "ethereum" }),
      400,
      "INVALID_TX_HASH",
    );
  });

  it("rejects a hash without the 0x prefix with 400 INVALID_TX_HASH", async () => {
    await expectApiError(
      handleTx({ tx_hash: "1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3", chain: "ethereum" }),
      400,
      "INVALID_TX_HASH",
    );
  });

  it("rejects non-hex characters with 400 INVALID_TX_HASH", async () => {
    await expectApiError(
      handleTx({ tx_hash: "0x" + "g".repeat(64), chain: "ethereum" }),
      400,
      "INVALID_TX_HASH",
    );
  });

  it("rejects an unsupported chain with 400 UNSUPPORTED_CHAIN", async () => {
    await expectApiError(
      handleTx({ tx_hash: CONFIRMED_TX, chain: "solana" }),
      400,
      "UNSUPPORTED_CHAIN",
    );
  });

  it("rejects missing params with 400 MISSING_PARAM", async () => {
    await expectApiError(handleTx({}), 400, "MISSING_PARAM");
    await expectApiError(handleTx({ tx_hash: CONFIRMED_TX }), 400, "MISSING_PARAM");
    await expectApiError(handleTx({ chain: "ethereum" }), 400, "MISSING_PARAM");
  });
});

describe("weiToEth (unit)", () => {
  it("converts 1 ETH exactly", () => {
    expect(weiToEth("0xde0b6b3a7640000")).toBe(1);
  });

  it("converts 0 wei to 0", () => {
    expect(weiToEth("0x0")).toBe(0);
  });

  it("converts 1 wei to 1e-18", () => {
    expect(weiToEth("0x1")).toBe(1e-18);
  });

  it("converts 10.5 ETH exactly", () => {
    expect(weiToEth("0x91b77e5e5d9a0000")).toBe(10.5);
  });
});

describe("receipt + envelope shape (unit, local fixtures)", () => {
  it("sha256Hex matches an independently computed SHA-256", () => {
    const input = "verireceipt-tx-fixture";
    const independent = "0x" + createHash("sha256").update(input).digest("hex");
    expect(sha256Hex(input)).toBe(independent);
    expect(sha256Hex(input)).toMatch(SHA256_RE);
  });

  it("receipt hash is recomputable from the raw body", () => {
    const rawBody = '{"jsonrpc":"2.0","id":1,"result":{"status":"0x1"}}';
    const receipt = makeReceipt(
      "ONCHAIN_TX_LOOKUP_GENERAL",
      "https://ethereum-rpc.publicnode.com",
      rawBody,
      "2/2 sources agreed",
    );
    expect(receipt.raw_response_sha256).toBe(sha256Hex(rawBody));
    expect(receipt.raw_response_sha256).toBe(
      "0x" + createHash("sha256").update(rawBody).digest("hex"),
    );
  });

  it("envelope carries the exact root fields plus a 0x-sha256 receipt", () => {
    const receipt = makeReceipt(
      "ONCHAIN_TX_LOOKUP_GENERAL",
      "https://ethereum-rpc.publicnode.com",
      '{"jsonrpc":"2.0","id":1,"result":null}',
      "2/2 sources agreed",
    );
    const out = envelope(
      "ONCHAIN_TX_LOOKUP_GENERAL",
      {
        tx_hash: CONFIRMED_TX,
        status: "confirmed",
        from: "0x5875db54cd9ae2b2a875e09bb731772297ae9d92",
        to: "0x0000000aa232009084bd71a5797d089aa4edfad4",
        block_number: 26454409,
        value_eth: 0,
      },
      receipt,
      {
        answer: `Transaction ${CONFIRMED_TX} on ethereum is confirmed in block 26454409.`,
        verdict: "verified",
        confidence: 1.0,
        source: "Archive RPC quorum (ethereum, 2-of-3)",
      },
    );
    expect(out.tx_hash).toBe(CONFIRMED_TX);
    expect(out.status).toBe("confirmed");
    expect(out.from).toBe("0x5875db54cd9ae2b2a875e09bb731772297ae9d92");
    expect(out.to).toBe("0x0000000aa232009084bd71a5797d089aa4edfad4");
    expect(out.block_number).toBe(26454409);
    expect(out.value_eth).toBe(0);
    expect(out.verdict).toBe("verified");
    expect(out.confidence).toBe(1.0);
    const rc = out.receipt as Record<string, unknown>;
    expect(rc.raw_response_sha256).toMatch(SHA256_RE);
    expect(typeof rc.receipt_id).toBe("string");
    expect(typeof rc.upstream_url).toBe("string");
    expect(typeof rc.quorum_votes).toBe("string");
    expect(typeof rc.fetched_at).toBe("string");
    expect(typeof rc.audit_url).toBe("string");
  });
});

describe("handleTx live (real public RPCs, no mocks)", () => {
  it(
    "confirmed mainnet tx returns status confirmed with exact fields",
    async () => {
      const out = await handleTx({ tx_hash: CONFIRMED_TX, chain: "ethereum" });
      expect(out.tx_hash).toBe(CONFIRMED_TX);
      expect(out.status).toBe("confirmed");
      expect(out.from).toBe("0x5875db54cd9ae2b2a875e09bb731772297ae9d92");
      expect(out.to).toBe("0x0000000aa232009084bd71a5797d089aa4edfad4");
      expect(out.block_number).toBe(26454409);
      expect(out.value_eth).toBe(0);
      expect(out.verdict).toBe("verified");
      expect(out.confidence).toBe(1.0);
      expect(out.source).toBe("Archive RPC quorum (ethereum, 2-of-3)");
      const rc = out.receipt as Record<string, unknown>;
      expect(rc.raw_response_sha256).toMatch(SHA256_RE);
      expect(typeof rc.upstream_url).toBe("string");
      expect((rc.upstream_url as string).startsWith("https://")).toBe(true);
    },
    30000,
  );

  it(
    "reverted mainnet tx returns status reverted",
    async () => {
      const out = await handleTx({ tx_hash: REVERTED_TX, chain: "ethereum" });
      expect(out.tx_hash).toBe(REVERTED_TX);
      expect(out.status).toBe("reverted");
      expect(out.from).toBe("0x60a518fbbc32d1bedcc02c7d6c7dff5f477e1aec");
      expect(out.to).toBe("0x7156b23feaf295e109d69148665bff737809cea4");
      expect(out.block_number).toBe(26454411);
      expect(out.verdict).toBe("reverted");
      expect(out.confidence).toBe(1.0);
    },
    30000,
  );

  it(
    "random unknown hash returns 200 status not_found (never 502)",
    async () => {
      const unknownHash = "0x" + randomBytes(32).toString("hex");
      const out = await handleTx({ tx_hash: unknownHash, chain: "ethereum" });
      expect(out.tx_hash).toBe(unknownHash);
      expect(out.status).toBe("not_found");
      expect(out.from).toBeNull();
      expect(out.to).toBeNull();
      expect(out.block_number).toBeNull();
      expect(out.value_eth).toBeNull();
      expect(out.verdict).toBe("not_found");
      expect(out.confidence).toBe(1.0);
    },
    30000,
  );
});
