// Tests for src/handlers/optimalRoute.ts
// Unit tests use local fixtures only. The live test hits REAL Ethereum
// mainnet RPCs and REAL quoter contracts (no mocks anywhere in handler code).
// The stubbed-RPC tests below run local HTTP JSON-RPC servers and exercise
// the handler through handleRouteWithRpcs with injectable RPC URLs.
import { countReceipts, storedReceiptRow } from "./helpers/storeView";
import { describe, expect, it } from "vitest";
import { createServer } from "http";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { AddressInfo } from "net";
import { ApiError } from "../src/core/errors";
import {
  applyAbsoluteCap,
  applyAgreementBand,
  applyMedianOutlierFilter,
  buildV2AmountsOutCalldata,
  buildV3QuoteCalldata,
  CALL_TIMEOUT_MS,
  CHECKPOINT_BLOCK,
  CHECKPOINT_TIMESTAMP_SEC,
  decodeV2AmountsOut,
  decodeV3QuoteReturn,
  DELTA1_MAX_TIMESTAMP_GAP_SEC,
  expectedBlockHeight,
  filterPlausibleQuotes,
  FIRST_SUCCESS_GRACE_MS,
  handleRoute,
  handleRouteWithRpcs,
  HEIGHT_ANCHOR_TOLERANCE_BLOCKS_FUTURE,
  HEIGHT_ANCHOR_TOLERANCE_BLOCKS_PAST,
  impliedBlockTimestamp,
  isQuorumBlockHeightAnchored,
  isQuorumBlockStale,
  isQuorumBlockTimestampConsistent,
  isQuorumBlockTimestampFuture,
  MAX_BLOCK_AGE_SEC,
  MAX_FUTURE_TIMESTAMP_SKEW_SEC,
  MAX_VENUE_RPCS,
  medianAmountOut,
  pickBestQuote,
  pinQuorumBlock,
  PLAUSIBLE_MAX_AMOUNT_OUT,
  QUORUM_BLOCK_TOLERANCE,
  QUORUM_STRAGGLER_GRACE_MS,
  QUORUM_TIMEOUT_MS,
  quorumBlocksAgree,
  ROUTE_PERSIST_RESERVE_MS,
  ROUTE_TOTAL_DEADLINE_MS,
  timestampConsistencyToleranceSec,
  TIMESTAMP_CONSISTENCY_DRIFT_RATE,
  TIMESTAMP_CONSISTENCY_MAX_LAG_SEC,
  TIMESTAMP_CONSISTENCY_SLACK_SEC,
  type QuorumBlock,
  type VenueQuote,
  venueCallTimeoutMsForDeadline,
} from "../src/handlers/optimalRoute";

// A7: the handler now persists every receipt via saveReceipt, and getDb()
// is a per-process singleton that reads SQLITE_PATH at first open — point
// it at a temp file so the suite never writes to the repo's ./data DB
// (same pattern as tests/server.test.ts). Set at module load, before any
// handler call in this file.
process.env.SQLITE_PATH = join(
  mkdtempSync(join(tmpdir(), "route-a7-")),
  "verireceipt.sqlite",
);

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function fakeQuote(venue: string, amountOut: bigint): VenueQuote {
  return {
    venue,
    amountOut,
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    request: {},
    response: {},
  };
}

describe("pair validation (400 missing / 422 wrong, unbilled)", () => {
  it("pair missing -> 400 MISSING_PARAM", async () => {
    await expect(handleRoute({})).rejects.toMatchObject({
      status: 400,
      code: "MISSING_PARAM",
    });
    try {
      await handleRoute({});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).code).toBe("MISSING_PARAM");
    }
  });

  it('pair "BTC/USDC" -> 422 INVALID_PAIR', async () => {
    await expect(handleRoute({ pair: "BTC/USDC" })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_PAIR",
    });
  });

  it('pair "eth/usdc" (lowercase, A7) -> 200: pair is case-normalized, not rejected', async () => {
    // A7: the old version of this test asserted 422 for lowercase — that
    // PINNED the defect. Lowercase (and mixed case) is the same pair.
    // Stubbed RPCs (not handleRoute/live) so the test stays hermetic.
    for (const pair of ["eth/usdc", "Eth/Usdc", "eTh/UsDc"]) {
      const blockNumber = FRESH_BLOCK;
      const blockHash = "0x" + "ab".repeat(32);
      const mk = () =>
        startStubRpc({
          blockNumber,
          blockHash,
          failCalls: false,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1730000000n,
        });
      const a = await mk();
      const b = await mk();
      try {
        const result = await handleRouteWithRpcs({ pair }, [a.url, b.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(1.0);
      } finally {
        await a.close();
        await b.close();
      }
    }
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

  it("decodeV3QuoteReturn rejects a truncated 1-word return (QuoterV2 always returns 4 words)", () => {
    const oneWord = "000000000000000000000000000000000000000000000000000000000000007b";
    expect(() => decodeV3QuoteReturn("0x" + oneWord)).toThrow();
  });

  it("decodeV2AmountsOut rejects an offset word of 0x60 (must be 0x20)", () => {
    const offset = "0000000000000000000000000000000000000000000000000000000000000060";
    const length = "0000000000000000000000000000000000000000000000000000000000000002";
    const inAmt = "0000000000000000000000000000000000000000000000000de0b6b3a7640000";
    const outAmt = "0000000000000000000000000000000000000000000000000000000067a1e2b6";
    expect(() => decodeV2AmountsOut("0x" + offset + length + inAmt + outAmt)).toThrow();
  });

  it("decodeV2AmountsOut rejects trailing garbage words after the array", () => {
    const offset = "0000000000000000000000000000000000000000000000000000000000000020";
    const length = "0000000000000000000000000000000000000000000000000000000000000002";
    const inAmt = "0000000000000000000000000000000000000000000000000de0b6b3a7640000";
    const outAmt = "0000000000000000000000000000000000000000000000000000000067a1e2b6";
    const garbage = "00000000000000000000000000000000000000000000000000000000000000ff";
    expect(() => decodeV2AmountsOut("0x" + offset + length + inAmt + outAmt + garbage)).toThrow();
  });
});

// Shared stub-RPC harness (hoisted to module level in round 4 so the
// filter/latency describes below can use it too).
function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

interface StubRpcOptions {
  blockNumber: number;
  blockHash: string;
  /** When true, eth_blockNumber/eth_getBlockByNumber answer but every eth_call errors. */
  failCalls: boolean;
  v3AmountOut: bigint;
  v2AmountOut: bigint;
  /** When true, only V3 (QuoterV2) eth_calls error; V2 calls still answer. */
  failV3?: boolean;
  /** When true, only V2 (getAmountsOut) eth_calls error; V3 calls still answer. */
  failV2?: boolean;
  /** Per-V2-venue failures/amounts (default: both share v2AmountOut). */
  failUni?: boolean;
  failSushi?: boolean;
  uniAmountOut?: bigint;
  sushiAmountOut?: bigint;
  /** When true, eth_call never responds (hangs until the client's CALL_TIMEOUT_MS). */
  hangCalls?: boolean;
  /** When true, eth_blockNumber never responds (hangs until the quorum timeout). */
  hangBlockNumber?: boolean;
  /** When true, eth_blockNumber errors immediately (fast leg failure). */
  failBlock?: boolean;
  /** Delay (ms) before answering eth_blockNumber / eth_call. */
  blockDelayMs?: number;
  callDelayMs?: number;
  /** Absolute unix-seconds timestamp for eth_getBlockByNumber (default: shared fresh value below). */
  blockTimestampSec?: number;
  /** Parent hash served in eth_getBlockByNumber (A7): the higher block of
   * a Δ=1 pair must report the lower block's hash here to pair with it. */
  blockParentHash?: string;
  /** Raw timestamp string sent verbatim (round 7, J1 O1): bypasses the
   * hex encoding so malformed timestamps (non-hex, "0x0", "-1") can be
   * served to the handler. When set, blockTimestampSec is ignored. */
  blockTimestampRaw?: string;
  /** When true, eth_getBlockByNumber omits the timestamp field entirely. */
  omitBlockTimestamp?: boolean;
}

// Shared fresh timestamp for every stub in this file, captured once at
// import: the quorum now requires agreement on number+hash+timestamp, and
// per-request Date.now() values from two stubs could straddle a wall
// second and flake the quorum. The file runs in minutes, far inside the
// 1800 s staleness bound, so the shared value stays fresh throughout.
const DEFAULT_BLOCK_TIMESTAMP_SEC = Math.floor(Date.now() / 1000);

// Round 7: the height anchor refuses pins >10,000 blocks below / >12 blocks
// above the extrapolated live height, so a FIXED historical block number as the
// "honest fresh pin" would rot within ~33 h of the checkpoint. Every stub
// below that models an honest fresh pin therefore uses the expected live
// height at import time. This changes no assertion — the block number is
// incidental to the quorum/filter/latency behaviour those tests pin, and
// the height-anchor tests below use expectedBlockHeight() explicitly.
// (The forged-pin tests keep their fixed 26,000,000 — that is the point.)
const FRESH_BLOCK = expectedBlockHeight(Math.floor(Date.now() / 1000));

function startStubRpc(options: StubRpcOptions): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    res.on("error", () => {});
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    req.on("end", () => {
      let body: { id?: unknown; method?: string; params?: unknown[] } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
      } catch {
        // Fall through to the unknown-method error below.
      }
      const reply = (result: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }));
      };
      const replyError = (code: number, message: string) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, error: { code, message } }),
        );
      };
      // Delayed replies (latency tests): the client may already have
      // timed out and destroyed the socket; a failed write is swallowed.
      const sendDelayed = (fn: () => void, delayMs: number | undefined) => {
        if (delayMs === undefined) {
          fn();
          return;
        }
        setTimeout(() => {
          try {
            if (!res.writableEnded) fn();
          } catch {
            // Client already gone; nothing to do.
          }
        }, delayMs);
      };
      if (body.method === "eth_blockNumber") {
        if (options.hangBlockNumber) return; // Never reply: hangs until the quorum timeout.
        if (options.failBlock) return replyError(-32000, "stub RPC refuses eth_blockNumber");
        return sendDelayed(
          () => reply("0x" + options.blockNumber.toString(16)),
          options.blockDelayMs,
        );
      }
      if (body.method === "eth_getBlockByNumber") {
        const result: Record<string, unknown> = {
          number: "0x" + options.blockNumber.toString(16),
          hash: options.blockHash,
        };
        if (options.blockParentHash !== undefined) {
          result.parentHash = options.blockParentHash;
        }
        if (!options.omitBlockTimestamp) {
          result.timestamp =
            options.blockTimestampRaw ??
            "0x" + (options.blockTimestampSec ?? DEFAULT_BLOCK_TIMESTAMP_SEC).toString(16);
        }
        return reply(result);
      }
      if (body.method === "eth_call") {
        const answerCall = () => {
          if (options.hangCalls) return; // Never reply: hangs until CALL_TIMEOUT_MS.
          if (options.failCalls) return replyError(-32000, "stub RPC refuses eth_call");
          const params = (body.params ?? []) as Array<{ to?: string; data?: string }>;
          const to = (params[0]?.to ?? "").toLowerCase();
          const data = params[0]?.data ?? "";
          if (data.startsWith("0xc6a5026a")) {
            if (options.failV3) return replyError(-32000, "stub RPC: V3 quoter reverts");
            // QuoterV2: exactly 4 words, amountOut first.
            return reply("0x" + word(options.v3AmountOut) + "00".repeat(96));
          }
          if (data.startsWith("0xd06ca61f")) {
            if (options.failV2) return replyError(-32000, "stub RPC: V2 router reverts");
            const isSushi =
              to === "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f";
            if (isSushi && options.failSushi)
              return replyError(-32000, "stub RPC: Sushi router reverts");
            if (!isSushi && options.failUni)
              return replyError(-32000, "stub RPC: Uni V2 router reverts");
            const amountOut = isSushi
              ? (options.sushiAmountOut ?? options.v2AmountOut)
              : (options.uniAmountOut ?? options.v2AmountOut);
            // getAmountsOut: offset 0x20, length 2, [amountIn, amountOut].
            return reply(
              "0x" +
                word(0x20n) +
                word(2n) +
                word(1000000000000000000n) +
                word(amountOut),
            );
          }
          return replyError(-32602, "stub RPC: unknown eth_call data");
        };
        return sendDelayed(answerCall, options.callDelayMs);
      }
      return replyError(-32601, "stub RPC: unknown method");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe("stubbed RPCs: failover provenance + block-hash quorum", () => {
  it(
    "single-RPC failover: RPC A blockNumber-only, RPC B full quotes -> upstream is B, confidence 0.9",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = "0x" + "ab".repeat(32);
      const stubA = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: true,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      const stubB = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url]);
        expect(result.amount_out).toBe(1739203982);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.block_number).toBe(blockNumber);
        expect(result.confidence).toBe(0.9);
        const receipt = result.receipt as Record<string, unknown>;
        expect(receipt.upstream_url).toBe(stubB.url);
        expect(receipt.intent).toBe("OPTIMAL_EXECUTION_ROUTE_GENERAL");
        expect(result.source).toContain("degraded");
      } finally {
        await stubA.close();
        await stubB.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "all-healthy stubs: both RPCs serve full quotes -> confidence 1.0, upstream is the first (agreeing) RPC",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = "0x" + "ab".repeat(32);
      const stubA = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      const stubB = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url]);
        expect(result.amount_out).toBe(1739203982);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.block_number).toBe(blockNumber);
        expect(result.confidence).toBe(1.0);
        const receipt = result.receipt as Record<string, unknown>;
        expect(receipt.upstream_url).toBe(stubA.url);
        expect(result.source).not.toContain("degraded");
      } finally {
        await stubA.close();
        await stubB.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "block-hash disagreement at the same height -> 502 QUORUM_UNREACHABLE (no fork passes quorum)",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const stubA = await startStubRpc({
        blockNumber,
        blockHash: "0x" + "ab".repeat(32),
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      const stubB = await startStubRpc({
        blockNumber,
        blockHash: "0x" + "cd".repeat(32),
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url]),
        ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
      } finally {
        await stubA.close();
        await stubB.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "block-number disagreement -> 502 QUORUM_UNREACHABLE",
    async () => {
      const blockHash = "0x" + "ab".repeat(32);
      const stubA = await startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      const stubB = await startStubRpc({
        blockNumber: FRESH_BLOCK + 1,
        blockHash,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url]),
        ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
      } finally {
        await stubA.close();
        await stubB.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "mirror single-RPC failover: RPC A full quotes, RPC B blockNumber-only -> upstream is A, confidence 0.9",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = "0x" + "ab".repeat(32);
      const stubA = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      const stubB = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: true,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url]);
        expect(result.amount_out).toBe(1739203982);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.block_number).toBe(blockNumber);
        expect(result.confidence).toBe(0.9);
        const receipt = result.receipt as Record<string, unknown>;
        expect(receipt.upstream_url).toBe(stubA.url);
        expect(receipt.intent).toBe("OPTIMAL_EXECUTION_ROUTE_GENERAL");
        expect(result.source).toContain("degraded");
      } finally {
        await stubA.close();
        await stubB.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "hung venue fails over within ~4.0s (CALL_TIMEOUT_MS 4000, A7 hedged parallel): RPC A hangs on eth_call, RPC B serves",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = "0x" + "ab".repeat(32);
      const stubA = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        hangCalls: true,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      const stubB = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      const startedAt = Date.now();
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url]);
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeLessThan(6000);
        expect(result.amount_out).toBe(1739203982);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.block_number).toBe(blockNumber);
        // Only B served a quote call, so confidence is capped at 0.9.
        expect(result.confidence).toBe(0.9);
        const receipt = result.receipt as Record<string, unknown>;
        expect(receipt.upstream_url).toBe(stubB.url);
      } finally {
        await stubA.close();
        await stubB.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "hung third quorum leg (round 4, Part B): the 2-agree quorum answers at agreement time, NOT after the quorum budget — wall < 6000 ms, correct result, confidence 1.0",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = "0x" + "ab".repeat(32);
      const stubA = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      const stubB = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      const stubC = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        hangBlockNumber: true,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
      });
      const startedAt = Date.now();
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [stubA.url, stubB.url, stubC.url],
        );
        const elapsedMs = Date.now() - startedAt;
        expect(result.amount_out).toBe(1739203982);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.block_number).toBe(blockNumber);
        expect(result.confidence).toBe(1.0);
        // Part B short-circuit: quorum2of3 resolves as soon as 2 legs
        // agree; the hung 3rd leg must NOT delay the response to its
        // timeout budget. (The old test asserted >= 9000 ms here — that
        // pinned the defective behaviour and was deleted in round 4.)
        expect(elapsedMs).toBeLessThan(6000);
        console.log(`HUNG-LEG wall: ${elapsedMs} ms`);
      } finally {
        await stubA.close();
        await stubB.close();
        await stubC.close();
      }
    },
    { timeout: 30000 },
  );

  it(
    "absurd V2 quote (2^256 - 1) is dropped as implausible; normal V3 wins",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = "0x" + "ab".repeat(32);
      const stubA = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 2n ** 256n - 1n,
      });
      const stubB = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 2n ** 256n - 1n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.verdict).toBe("verified");
        // Only the V3 quote survived the plausibility filter, so confidence is 0.9.
        expect(result.confidence).toBe(0.9);
      } finally {
        await stubA.close();
        await stubB.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "all venues absurd -> 502 ALL_QUOTERS_FAILED",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = "0x" + "ab".repeat(32);
      const stubA = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 2n ** 256n - 1n,
        v2AmountOut: 2n ** 256n - 1n,
      });
      const stubB = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 2n ** 256n - 1n,
        v2AmountOut: 2n ** 256n - 1n,
      });
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url]),
        ).rejects.toMatchObject({ status: 502, code: "ALL_QUOTERS_FAILED" });
      } finally {
        await stubA.close();
        await stubB.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "normal quotes unaffected by the plausibility bounds (1.74e9 vs 1.73e9)",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = "0x" + "ab".repeat(32);
      const stubA = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
      });
      const stubB = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(1.0);
        expect(result.source).not.toContain("degraded");
      } finally {
        await stubA.close();
        await stubB.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "V3 family outage: V3 reverts on every RPC, V2 normal -> V2 wins, confidence 0.9",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = "0x" + "ab".repeat(32);
      const stubA = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        failV3: true,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
      });
      const stubB = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        failV3: true,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url]);
        expect(result.amount_out).toBe(1730000000);
        expect(result.winning_venue).toBe("Uniswap V2");
        expect(result.confidence).toBe(0.9);
        expect(result.source).toContain("degraded");
      } finally {
        await stubA.close();
        await stubB.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "V2 family outage: V2 reverts on every RPC, V3 normal -> V3 wins, confidence 0.9",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = "0x" + "ab".repeat(32);
      const stubA = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        failV2: true,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
      });
      const stubB = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        failV2: true,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(0.9);
        expect(result.source).toContain("degraded");
      } finally {
        await stubA.close();
        await stubB.close();
      }
    },
    { timeout: 15000 },
  );
});

describe("plausibility filter units (round 4)", () => {
  const q = (venue: string, amountOut: bigint) => fakeQuote(venue, amountOut);
  const V3 = "Uniswap V3 (fee 500)";
  const UNI = "Uniswap V2";
  const SUSHI = "SushiSwap V2";

  it("medianAmountOut is the lower median (an actual quote value)", () => {
    expect(medianAmountOut([q(V3, 100n), q(UNI, 200n), q(SUSHI, 300n)])).toBe(200n);
    expect(medianAmountOut([q(V3, 100n), q(UNI, 200n)])).toBe(100n);
    expect(medianAmountOut([q(V3, 1740000000n)])).toBe(1740000000n);
    expect(() => medianAmountOut([])).toThrow();
  });

  it("absolute cap (round 5, 1e10): 1e10 - 1 is kept, exactly 1e10 is dropped, 2^256 - 1 is dropped", () => {
    expect(PLAUSIBLE_MAX_AMOUNT_OUT).toBe(10_000_000_000n);
    expect(applyAbsoluteCap([q(V3, 9_999_999_999n)])).toHaveLength(1);
    expect(applyAbsoluteCap([q(V3, 10_000_000_000n)])).toHaveLength(0);
    expect(applyAbsoluteCap([q(UNI, 2n ** 256n - 1n)])).toHaveLength(0);
    expect(filterPlausibleQuotes([q(V3, 10_000_000_000n)])).toHaveLength(0);
  });

  it("median rule (old M3 case): V3=5e9 vs Uni 1.74e9 / Sushi 1.73e9 -> 5e9 dropped", () => {
    // Direct stage test (not the pipeline): the agreement band would also
    // drop 5e9, so only a direct call guards the median rule itself.
    const out = applyMedianOutlierFilter([
      q(V3, 5000000000n),
      q(UNI, 1740000000n),
      q(SUSHI, 1730000000n),
    ]);
    expect(out.map((x) => x.amountOut)).toEqual([1740000000n, 1730000000n]);
  });

  it("median rule boundary: winner at exactly 2x the median is kept, +1 is dropped", () => {
    const kept = applyMedianOutlierFilter([
      q(V3, 3480000000n),
      q(UNI, 1740000000n),
      q(SUSHI, 1730000000n),
    ]);
    expect(kept).toHaveLength(3);
    const dropped = applyMedianOutlierFilter([
      q(V3, 3480000001n),
      q(UNI, 1740000000n),
      q(SUSHI, 1730000000n),
    ]);
    expect(dropped.map((x) => x.amountOut)).toEqual([1740000000n, 1730000000n]);
  });

  it("agreement band boundary: exactly +5% of the median is kept, +1 is dropped", () => {
    const kept = applyAgreementBand([
      q(V3, 1827000000n),
      q(UNI, 1740000000n),
      q(SUSHI, 1730000000n),
    ]);
    expect(kept).toHaveLength(3);
    const dropped = applyAgreementBand([
      q(V3, 1827000001n),
      q(UNI, 1740000000n),
      q(SUSHI, 1730000000n),
    ]);
    expect(dropped.map((x) => x.amountOut)).toEqual([1740000000n, 1730000000n]);
  });

  it("agreement band boundary (low side): exactly -5% of the median is kept, -1 is dropped", () => {
    // Sorted [1653e6, 1740e6, 1750e6]: the median is exactly 1740000000,
    // so -5% is exactly 1653000000.
    const kept = applyAgreementBand([
      q(V3, 1653000000n),
      q(UNI, 1740000000n),
      q(SUSHI, 1750000000n),
    ]);
    expect(kept).toHaveLength(3);
    const dropped = applyAgreementBand([
      q(V3, 1652999999n),
      q(UNI, 1740000000n),
      q(SUSHI, 1750000000n),
    ]);
    expect(dropped.map((x) => x.amountOut)).toEqual([1740000000n, 1750000000n]);
  });

  it("two disagreeing quotes: the band anchors on the lower median — a wrong-high quote never wins", () => {
    expect(
      filterPlausibleQuotes([q(V3, 1900000000n), q(UNI, 1740000000n)]).map(
        (x) => x.amountOut,
      ),
    ).toEqual([1740000000n]);
    // Documented conservative bias: a wrong-low quote can only win
    // degraded at 0.9 (it understates the return — the safe direction).
    expect(
      filterPlausibleQuotes([q(V3, 1000000000n), q(UNI, 1740000000n)]).map(
        (x) => x.amountOut,
      ),
    ).toEqual([1000000000n]);
  });

  it("single-quote path: a lone absurd quote is dropped (502 upstream), a lone sane quote survives", () => {
    expect(filterPlausibleQuotes([q(UNI, 900000000000n)])).toHaveLength(0);
    expect(filterPlausibleQuotes([q(UNI, 1740000000n)])).toHaveLength(1);
  });

  it("live-shaped quotes pass at full strength (V3 1.738e9 / Uni 1.7377e9 / Sushi 1.7116e9)", () => {
    const out = filterPlausibleQuotes([
      q(V3, 1738027049n),
      q(UNI, 1737688271n),
      q(SUSHI, 1711579650n),
    ]);
    expect(out).toHaveLength(3);
    expect(pickBestQuote(out)?.venue).toBe(V3);
  });
});

describe("stubbed RPCs: plausibility filter end-to-end (round 4, J2 attacks)", () => {
  const BLOCK = FRESH_BLOCK;
  const HASH = "0x" + "ab".repeat(32);
  async function twoStubs(opts: {
    v3: bigint;
    uni?: bigint;
    sushi?: bigint;
    v2?: bigint;
    failV3?: boolean;
    failUni?: boolean;
    failSushi?: boolean;
  }) {
    const mk = () =>
      startStubRpc({
        blockNumber: BLOCK,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: opts.v3,
        v2AmountOut: opts.v2 ?? 1730000000n,
        uniAmountOut: opts.uni,
        sushiAmountOut: opts.sushi,
        failV3: opts.failV3,
        failUni: opts.failUni,
        failSushi: opts.failSushi,
      });
    return [await mk(), await mk()] as const;
  }

  it(
    "B1 trio: V3=9e11, Uni=8e11, Sushi=1.74e9 -> the sane 1.74e9 wins, never 9e11",
    async () => {
      const [a, b] = await twoStubs({
        v3: 900000000000n,
        uni: 800000000000n,
        sushi: 1740000000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("SushiSwap V2");
        // Only one quote survived the cap, so confidence is degraded.
        expect(result.confidence).toBe(0.9);
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "B1 cap-1 trio: 999999999999 / 9e11 / 8e11 -> 502 ALL_QUOTERS_FAILED (all above the cap)",
    async () => {
      const [a, b] = await twoStubs({
        v3: 999999999999n,
        uni: 900000000000n,
        sushi: 800000000000n,
      });
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
        ).rejects.toMatchObject({ status: 502, code: "ALL_QUOTERS_FAILED" });
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "B1 single absurd quote: only Uni quoting 9e11 -> 502, never a 200",
    async () => {
      const [a, b] = await twoStubs({ v3: 1740000000n, uni: 900000000000n, failV3: true, failSushi: true });
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
        ).rejects.toMatchObject({ status: 502, code: "ALL_QUOTERS_FAILED" });
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "B1 cap boundary (round 5 — FIXES the test that pinned the bug): every venue at 99,999,999,999 (the old 1e11 - 1 boundary) is now dropped entirely -> 502. The round-4 version of this test asserted confidence 1.0 for the 99,999,999,999 winner — that assertion PINNED the round-4 defect (an absurd unanimous value winning at full confidence) and was therefore wrong, not merely stale. Under the tightened 1e10 cap the value is dropped by the cap stage, so no winner exists at any confidence.",
    async () => {
      const [a, b] = await twoStubs({ v3: 99_999_999_999n, v2: 99_999_999_999n });
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
        ).rejects.toMatchObject({ status: 502, code: "ALL_QUOTERS_FAILED" });
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "B1 cap boundary (round 5): every venue at 1e10 - 1 is kept (winner 9999999999 at 1.0) — the unanimous-absurd residual (A2), bounded by the cap at <=~5.7x the live reference",
    async () => {
      const [a, b] = await twoStubs({ v3: 9_999_999_999n, v2: 9_999_999_999n });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(9999999999);
        // All three venues agree and nothing was dropped: this is the
        // disclosed A2 residual — no relative filter can catch unanimous
        // absurdity, and the cap bounds it at <=~5.7x live. 1.0 here is
        // honest ONLY because the cap now bounds it (round 4's 1e11 cap
        // let the same shape win at 99,999,999,999 — 57.5x live).
        expect(result.confidence).toBe(1.0);
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "B1 cap boundary (round 5): every venue at exactly 1e10 is dropped -> 502",
    async () => {
      const [a, b] = await twoStubs({ v3: 10_000_000_000n, v2: 10_000_000_000n });
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
        ).rejects.toMatchObject({ status: 502, code: "ALL_QUOTERS_FAILED" });
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "B3: V3=5e9 dropped by the median rule + V2 normal -> correct winner, confidence 0.9 (V3 family out post-filter)",
    async () => {
      const [a, b] = await twoStubs({ v3: 5000000000n, v2: 1740000000n });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("Uniswap V2");
        expect(result.confidence).toBe(0.9);
        expect(result.source).toContain("degraded");
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "B3 mirror: V2 family fully dropped (Uni reverts, Sushi 5e9 dropped as implausible) + V3 normal -> V3 wins, confidence 0.9",
    async () => {
      const [a, b] = await twoStubs({
        v3: 1740000000n,
        sushi: 5000000000n,
        failUni: true,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(0.9);
        expect(result.source).toContain("degraded");
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "B6: V3=1.9e9 (wrong high, plausible) vs Uni 1.74e9 / Sushi 1.73e9 -> the agreeing 1.74e9 wins, confidence 0.9",
    async () => {
      const [a, b] = await twoStubs({
        v3: 1900000000n,
        uni: 1740000000n,
        sushi: 1730000000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("Uniswap V2");
        expect(result.confidence).toBe(0.9);
        expect(result.source).toContain("degraded");
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "B6 boundary: V3 at exactly +5% of the median (1827000000) is kept and wins at 1.0",
    async () => {
      const [a, b] = await twoStubs({
        v3: 1827000000n,
        uni: 1740000000n,
        sushi: 1730000000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(1827000000);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(1.0);
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "B6 boundary: V3 at +5% + 1 (1827000001) is dropped -> agreeing 1.74e9 wins at 0.9",
    async () => {
      const [a, b] = await twoStubs({
        v3: 1827000001n,
        uni: 1740000000n,
        sushi: 1730000000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("Uniswap V2");
        expect(result.confidence).toBe(0.9);
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );
});

describe("round 5: any dropped quote caps confidence at 0.9 (J1 B1 + J2 B1)", () => {
  const BLOCK = FRESH_BLOCK;
  const HASH = "0x" + "ab".repeat(32);
  async function twoStubs(opts: {
    v3: bigint;
    uni?: bigint;
    sushi?: bigint;
    v2?: bigint;
    failUni?: boolean;
    failSushi?: boolean;
  }) {
    const mk = () =>
      startStubRpc({
        blockNumber: BLOCK,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: opts.v3,
        v2AmountOut: opts.v2 ?? 1730000000n,
        uniAmountOut: opts.uni,
        sushiAmountOut: opts.sushi,
        failUni: opts.failUni,
        failSushi: opts.failSushi,
      });
    return [await mk(), await mk()] as const;
  }

  it(
    "A1 (J1 reproduction): V3=99e9, Uni=99e9, Sushi=1.74e9 -> sane 1.74e9 wins at 0.9, never 1.0 (round 4 scored 99e9 at 1.0)",
    async () => {
      const [a, b] = await twoStubs({
        v3: 99_000_000_000n,
        uni: 99_000_000_000n,
        sushi: 1_740_000_000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("SushiSwap V2");
        expect(result.confidence).toBe(0.9);
        expect(result.source).toContain("dropped by the plausibility filter");
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "A3: V3=50e9, Uni=50e9, Sushi=1.74e9 (28.7x) -> sane 1.74e9 wins at 0.9, never 1.0",
    async () => {
      const [a, b] = await twoStubs({
        v3: 50_000_000_000n,
        uni: 50_000_000_000n,
        sushi: 1_740_000_000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("SushiSwap V2");
        expect(result.confidence).toBe(0.9);
        expect(result.source).toContain("dropped by the plausibility filter");
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "A4 (J2 reproduction): V3=9e10, Uni=8.8e10, Sushi=1.74e9 (~52x) -> sane 1.74e9 wins at 0.9, never 1.0",
    async () => {
      const [a, b] = await twoStubs({
        v3: 90_000_000_000n,
        uni: 88_000_000_000n,
        sushi: 1_740_000_000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("SushiSwap V2");
        expect(result.confidence).toBe(0.9);
        expect(result.source).toContain("dropped by the plausibility filter");
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "wrong-low majority (J2 reproduction): V3=1.05e8, Uni=1.1e8, Sushi=1.74e9 -> winner 1.1e8 ($110 for 1 ETH, 16x too low) at 0.9, never 1.0 — refutes the round-4 claim that a wrong-low quote 'can only win degraded at 0.9' was already enforced; round 4 scored it 1.0",
    async () => {
      const [a, b] = await twoStubs({
        v3: 105_000_000n,
        uni: 110_000_000n,
        sushi: 1_740_000_000n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(110000000);
        expect(result.winning_venue).toBe("Uniswap V2");
        expect(result.confidence).toBe(0.9);
        expect(result.source).toContain("dropped by the plausibility filter");
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "two quotes only, both absurd and agreeing under the cap (J2 variant, sub-cap values): V3=9e9, Uni=8.8e9, Sushi absent -> winner 9e9 at 0.9, never 1.0 (a missing venue is a missing corroborating voice)",
    async () => {
      const [a, b] = await twoStubs({
        v3: 9_000_000_000n,
        uni: 8_800_000_000n,
        failSushi: true,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(9000000000);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(0.9);
        expect(result.source).toContain("fewer than three venues produced plausible quotes");
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "two quotes only, both absurd and agreeing at the literal J2 values: V3=9e10, Uni=8.8e10, Sushi absent -> 502 (the tightened 1e10 cap drops both; the attack no longer wins at any confidence)",
    async () => {
      const [a, b] = await twoStubs({
        v3: 90_000_000_000n,
        uni: 88_000_000_000n,
        failSushi: true,
      });
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
        ).rejects.toMatchObject({ status: 502, code: "ALL_QUOTERS_FAILED" });
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "clean 3-quote live-like run (fresh live values measured this round, block 26,455,162) -> winner 1,755,251,736 at 1.0: no drops, all three venues plausible",
    async () => {
      const [a, b] = await twoStubs({
        v3: 1_755_251_736n,
        uni: 1_747_201_523n,
        sushi: 1_719_479_531n,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(1755251736);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(1.0);
        expect(result.source).not.toContain("degraded");
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "miner.yaml /v1/route description names no Curve venue (round 5, J1 B2): the handler quotes only Uniswap V2/V3 + SushiSwap V2, so the registration file must not advertise Curve pools",
    () => {
      const yaml = readFileSync(resolve(process.cwd(), "miner.yaml"), "utf8");
      const routeStart = yaml.indexOf("- path: /v1/route");
      const gridStart = yaml.indexOf("- path: /v1/grid-price");
      expect(routeStart).toBeGreaterThan(-1);
      expect(gridStart).toBeGreaterThan(routeStart);
      const routeSection = yaml.slice(routeStart, gridStart);
      expect(routeSection).toContain("Uniswap V2/V3, SushiSwap V2");
      expect(routeSection).not.toContain("Curve");
    },
  );
});

describe("round 6: quorum-block freshness bound (J2 B1)", () => {
  const HASH = "0x" + "ab".repeat(32);
  const nowSec = () => Math.floor(Date.now() / 1000);
  async function stubs(opts: {
    blockNumber: number;
    blockTimestampSec?: number;
    omitBlockTimestamp?: boolean;
    v3?: bigint;
    uni?: bigint;
    sushi?: bigint;
    v2?: bigint;
    count?: number;
  }) {
    const mk = (timestampSec?: number) =>
      startStubRpc({
        blockNumber: opts.blockNumber,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: opts.v3 ?? 1740000000n,
        v2AmountOut: opts.v2 ?? 1740000000n,
        uniAmountOut: opts.uni,
        sushiAmountOut: opts.sushi,
        blockTimestampSec: timestampSec ?? opts.blockTimestampSec,
        omitBlockTimestamp: opts.omitBlockTimestamp,
      });
    const n = opts.count ?? 2;
    const out = [];
    for (let i = 0; i < n; i++) out.push(await mk());
    return out as Array<{ url: string; close: () => Promise<void> }>;
  }
  async function closeAll(ss: Array<{ close: () => Promise<void> }>) {
    for (const s of ss) await s.close();
  }

  it(
    "B1 (J2 exact case): quorum block 26,000,000 (~63 days / ~455k blocks old) with sane quotes -> 502 STALE_BLOCK_PIN, never 200 at 1.0",
    async () => {
      const ss = await stubs({
        blockNumber: 26_000_000,
        blockTimestampSec: nowSec() - 63 * 86400,
        v3: 1_740_000_000n,
        v2: 1_740_000_000n,
      });
      try {
        await expect(
          handleRouteWithRpcs(
            { pair: "ETH/USDC" },
            ss.map((s) => s.url),
          ),
        ).rejects.toMatchObject({ status: 502, code: "STALE_BLOCK_PIN" });
      } finally {
        await closeAll(ss);
      }
    },
    { timeout: 15000 },
  );

  it(
    "ROUND 7 FLIP (J2 round-6 BLOCKER B1): same block number 26,000,000 with a FRESH timestamp -> 502 STALE_BLOCK_PIN. The round-6 version of this test asserted 200 at 1.0 ('the trigger is the age, not the block number') — that assertion PINNED the bypass: a forged-fresh timestamp on a 63-day-old block sailed through the age bound because the timestamp is an unauthenticated JSON field. Round 7 refuses it via the height anchor (26,000,000 is ~455k blocks below the expected height, ~45x outside the ±10,000 tolerance), whatever timestamp the legs claim.",
    async () => {
      const ss = await stubs({
        blockNumber: 26_000_000,
        blockTimestampSec: nowSec(),
        v3: 1_740_000_000n,
        v2: 1_740_000_000n,
      });
      try {
        await expect(
          handleRouteWithRpcs(
            { pair: "ETH/USDC" },
            ss.map((s) => s.url),
          ),
        ).rejects.toMatchObject({ status: 502, code: "STALE_BLOCK_PIN" });
      } finally {
        await closeAll(ss);
      }
    },
    { timeout: 15000 },
  );

  it("boundary (pure function, exact): age exactly MAX_BLOCK_AGE_SEC is served, +1s is refused", () => {
    expect(MAX_BLOCK_AGE_SEC).toBe(1800);
    const now = nowSec();
    expect(isQuorumBlockStale(now - 1800, now)).toBe(false);
    expect(isQuorumBlockStale(now - 1801, now)).toBe(true);
    expect(isQuorumBlockStale(now - 1799, now)).toBe(false);
    // A timestamp slightly in the future (proposer clock skew) is served, never refused.
    expect(isQuorumBlockStale(now + 60, now)).toBe(false);
  });

  it(
    "boundary (stub integration, ±1s margins so a wall-second tick cannot flake it): 1799s old -> 200, 1801s old -> 502 STALE_BLOCK_PIN",
    async () => {
      const fresh = await stubs({ blockNumber: FRESH_BLOCK, blockTimestampSec: nowSec() - 1799 });
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          fresh.map((s) => s.url),
        );
        expect(result.amount_out).toBe(1740000000);
        expect(result.confidence).toBe(1.0);
      } finally {
        await closeAll(fresh);
      }
      const stale = await stubs({ blockNumber: FRESH_BLOCK, blockTimestampSec: nowSec() - 1801 });
      try {
        await expect(
          handleRouteWithRpcs(
            { pair: "ETH/USDC" },
            stale.map((s) => s.url),
          ),
        ).rejects.toMatchObject({ status: 502, code: "STALE_BLOCK_PIN" });
      } finally {
        await closeAll(stale);
      }
    },
    { timeout: 15000 },
  );

  it(
    "header-fetch failure (round 6, failure mode d): every header omits the timestamp -> the legs cannot vote -> 502 QUORUM_UNREACHABLE, never a served pin of unprovable age",
    async () => {
      const ss = await stubs({ blockNumber: FRESH_BLOCK, omitBlockTimestamp: true });
      try {
        await expect(
          handleRouteWithRpcs(
            { pair: "ETH/USDC" },
            ss.map((s) => s.url),
          ),
        ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
      } finally {
        await closeAll(ss);
      }
    },
    { timeout: 15000 },
  );

  it(
    "timestamp disagreement (same number+hash, fresh vs 63-day-old timestamp) -> no quorum -> 502 QUORUM_UNREACHABLE (a liar's fresh timestamp for a stale pin is excluded, not trusted)",
    async () => {
      const a = await startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1740000000n,
        blockTimestampSec: nowSec(),
      });
      const b = await startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1740000000n,
        blockTimestampSec: nowSec() - 63 * 86400,
      });
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
        ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "3 stubs, one liar timestamp (A+B fresh agree, C reports a 63-day-old timestamp for the same block+hash) -> 200 at 1.0 (the liar is excluded by the number+hash+timestamp triple) — round 7 strengthens it: the liar must also never serve the winning quote (upstream is A or B, never C)",
    async () => {
      const mk = (timestampSec: number) =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1740000000n,
          blockTimestampSec: timestampSec,
        });
      const fresh = nowSec();
      const a = await mk(fresh);
      const b = await mk(fresh);
      const c = await mk(fresh - 63 * 86400);
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [a.url, b.url, c.url],
        );
        expect(result.amount_out).toBe(1740000000);
        expect(result.confidence).toBe(1.0);
        // Round 7 (J2 Minor X): the timestamp liar is excluded from the
        // QUOTE path too — the winning quote's upstream is one of the
        // agreeing legs, never the liar.
        const receipt = result.receipt as Record<string, unknown>;
        expect([a.url, b.url]).toContain(receipt.upstream_url);
        expect(receipt.upstream_url).not.toBe(c.url);
      } finally {
        await a.close();
        await b.close();
        await c.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "A1 below-cap shape (J1 O3, dedicated test): V3=9e9, Uni=9e9, Sushi=1.74e9 -> wrong winner 9e9 at 0.9, sane 1.74e9 dropped (the disclosed A1 residual, below the cap)",
    async () => {
      const ss = await stubs({
        blockNumber: FRESH_BLOCK,
        v3: 9_000_000_000n,
        uni: 9_000_000_000n,
        sushi: 1_740_000_000n,
      });
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          ss.map((s) => s.url),
        );
        expect(result.amount_out).toBe(9000000000);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(0.9);
        expect(result.source).toContain("dropped by the plausibility filter");
      } finally {
        await closeAll(ss);
      }
    },
    { timeout: 15000 },
  );
});

describe("stubbed RPCs: quorum latency (round 4, Part B)", () => {
  const BLOCK = FRESH_BLOCK;
  const HASH = "0x" + "ab".repeat(32);
  const base = {
    blockNumber: BLOCK,
    blockHash: HASH,
    failCalls: false,
    v3AmountOut: 1739203982n,
    v2AmountOut: 1730000000n,
  };

  it(
    "early-fail: 2 legs fail fast on blockNumber -> 502 QUORUM_UNREACHABLE without waiting for the 3rd leg",
    async () => {
      const stubA = await startStubRpc({ ...base, failBlock: true });
      const stubB = await startStubRpc({ ...base, failBlock: true });
      const stubC = await startStubRpc(base);
      const startedAt = Date.now();
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url, stubC.url]),
        ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
        expect(Date.now() - startedAt).toBeLessThan(3000);
      } finally {
        await stubA.close();
        await stubB.close();
        await stubC.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "hung quorum leg + hung venue, still a success: wall < 6000 ms, correct winner, confidence 0.9 — ROUND 8 BEHAVIOUR CHANGE (J2 F1, was: 1.0): the hung leg no longer serves quotes (no-header-no-quotes), so only ONE RPC serves a quote here (the hung venue serves nothing, the hung leg is excluded) and the pre-existing '>= 2 RPCs served a quote' rule caps confidence at 0.9. NOT a weakening: the old 1.0 was bought with the exact mechanism (unknown legs serve quotes) that let erroring/malformed/hung liars WIN at 1.0 — liar-resistance is the reason. A hung leg ALONE (venues healthy) still earns 1.0 from the two agreeing legs; the 0.9 here is the old rule firing on a single serving RPC.",
    async () => {
      const stubA = await startStubRpc(base);
      const stubB = await startStubRpc({ ...base, hangCalls: true });
      const stubC = await startStubRpc({ ...base, hangBlockNumber: true });
      const startedAt = Date.now();
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [stubA.url, stubB.url, stubC.url],
        );
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeLessThan(6000);
        console.log(`HUNG-LEG+VENUE wall: ${elapsedMs} ms`);
        expect(result.amount_out).toBe(1739203982);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(0.9);
      } finally {
        await stubA.close();
        await stubB.close();
        await stubC.close();
      }
    },
    { timeout: 30000 },
  );

  it(
    "all-hung blockNumber: 502 QUORUM_UNREACHABLE in ~one 4.0 s timeout (wall 3500–6000 ms), not ~10 s",
    async () => {
      const stubA = await startStubRpc({ ...base, hangBlockNumber: true });
      const stubB = await startStubRpc({ ...base, hangBlockNumber: true });
      const stubC = await startStubRpc({ ...base, hangBlockNumber: true });
      const startedAt = Date.now();
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url, stubC.url]),
        ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeGreaterThanOrEqual(3500);
        expect(elapsedMs).toBeLessThan(6000);
        console.log(`ALL-HUNG-BLOCK wall: ${elapsedMs} ms`);
      } finally {
        await stubA.close();
        await stubB.close();
        await stubC.close();
      }
    },
    { timeout: 30000 },
  );

  it(
    "all-slow 5.22 s blockNumber: TRUE behaviour — every 5.22 s leg times out at 4.0 s, run 502s in ~4.0 s (the old 'no-race preserves 5.22 s quotes' claim was false)",
    async () => {
      const stubA = await startStubRpc({ ...base, blockDelayMs: 5220 });
      const stubB = await startStubRpc({ ...base, blockDelayMs: 5220 });
      const stubC = await startStubRpc({ ...base, blockDelayMs: 5220 });
      const startedAt = Date.now();
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url, stubC.url]),
        ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeGreaterThanOrEqual(3500);
        expect(elapsedMs).toBeLessThan(6000);
        console.log(`ALL-SLOW-5220 wall: ${elapsedMs} ms`);
      } finally {
        await stubA.close();
        await stubB.close();
        await stubC.close();
      }
    },
    { timeout: 30000 },
  );

  it(
    "all-hung eth_call (A7: hedged parallel, ~4.0 s): 502 ALL_QUOTERS_FAILED after one parallel timeout round — the round-9 ~9.0 s figure (2 sequential 4.5 s venue failovers) is superseded by the hedged tryVenue + 4000 ms timeout",
    async () => {
      const stubA = await startStubRpc({ ...base, hangCalls: true });
      const stubB = await startStubRpc({ ...base, hangCalls: true });
      const stubC = await startStubRpc({ ...base, hangCalls: true });
      const startedAt = Date.now();
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [stubA.url, stubB.url, stubC.url]),
        ).rejects.toMatchObject({ status: 502, code: "ALL_QUOTERS_FAILED" });
        const elapsedMs = Date.now() - startedAt;
        console.log(`ALL-HUNG eth_call wall: ${elapsedMs} ms`);
        expect(elapsedMs).toBeLessThan(20000);
      } finally {
        await stubA.close();
        await stubB.close();
        await stubC.close();
      }
    },
    { timeout: 30000 },
  );
});

describe("refusal matrix + adversarial pairs (round 4)", () => {
  it('pair "" (empty) -> 422 INVALID_PAIR', async () => {
    await expect(handleRoute({ pair: "" })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_PAIR",
    });
  });

  it('pair with a null byte "ETH/USDC\\0" -> 422 INVALID_PAIR', async () => {
    await expect(handleRoute({ pair: "ETH/USDC\u0000" })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_PAIR",
    });
  });

  it('pair with a newline "ETH/USDC\\n" -> 422 INVALID_PAIR', async () => {
    await expect(handleRoute({ pair: "ETH/USDC\n" })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_PAIR",
    });
  });

  it('pair with a fullwidth slash "ETH／USDC" (unicode) -> 422 INVALID_PAIR', async () => {
    await expect(handleRoute({ pair: "ETH／USDC" })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_PAIR",
    });
  });

  it('pair "USDC/ETH" (reversed) -> 422 INVALID_PAIR', async () => {
    await expect(handleRoute({ pair: "USDC/ETH" })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_PAIR",
    });
  });

  it('oversized pair (10k chars, injection-shaped) -> 422 INVALID_PAIR', async () => {
    await expect(
      handleRoute({ pair: "ETH/USDC" + "x".repeat(10000) }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_PAIR" });
    await expect(
      handleRoute({ pair: "ETH/USDC'; DROP TABLE receipts; --" }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_PAIR" });
  });

  it("fewer than 2 RPCs configured -> 502 RPC_CONFIG (fail-closed, no network hit)", async () => {
    await expect(
      handleRouteWithRpcs({ pair: "ETH/USDC" }, ["http://127.0.0.1:9"]),
    ).rejects.toMatchObject({ status: 502, code: "RPC_CONFIG" });
    await expect(handleRouteWithRpcs({ pair: "ETH/USDC" }, [])).rejects.toMatchObject({
      status: 502,
      code: "RPC_CONFIG",
    });
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
      expect(receipt.intent).toBe("OPTIMAL_EXECUTION_ROUTE_GENERAL");
      expect(typeof receipt.upstream_url).toBe("string");
      expect(receipt.raw_response_sha256).toMatch(/^[0-9a-f]{64}$/);
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

describe("round 7: height anchor + future skew + timestamp-agreeing quote path (J2 B1/B2/Minor X, J1 O1)", () => {
  const HASH = "0x" + "ab".repeat(32);
  const nowSec = () => Math.floor(Date.now() / 1000);

  it("checkpoint constants: block 26,455,162 at 2026-11-20T08:38:00Z, 12 s/block, asymmetric anchor (10,000 below / 12 above), 120 s future skew", () => {
    expect(CHECKPOINT_BLOCK).toBe(26_455_162);
    expect(CHECKPOINT_TIMESTAMP_SEC).toBe(1_795_163_880);
    expect(new Date(CHECKPOINT_TIMESTAMP_SEC * 1000).toISOString()).toBe(
      "2026-11-20T08:38:00.000Z",
    );
    // Round 8 (J2 F3): the anchor tolerance is ASYMMETRIC — the honest tip
    // can never exceed nominal expected height, so the future side is tight.
    expect(HEIGHT_ANCHOR_TOLERANCE_BLOCKS_PAST).toBe(10_000);
    expect(HEIGHT_ANCHOR_TOLERANCE_BLOCKS_FUTURE).toBe(12);
    expect(MAX_FUTURE_TIMESTAMP_SKEW_SEC).toBe(120);
    // Cross-check against the recorded live observation (round 7 header):
    // block 26,455,025 at 2026-11-20T08:10:52Z; 137 blocks x 12 s = 1644 s
    // later is 08:38:16Z, within 16 s of the checkpoint time. Round 8 (J2
    // F6): this is an INFERENCE, not verification — the recorded value is
    // the block's FETCH time (checked_at), not its timestamp; the inference
    // assumes 025's true timestamp is within ~12 s before its fetch and
    // ~1% missed slots over the gap. The arithmetic itself (137 x 12 =
    // 1644 s) is confirmed by J1.
    expect(expectedBlockHeight(1_795_163_880)).toBe(26_455_162);
    expect(expectedBlockHeight(1_795_163_880 + 12)).toBe(26_455_163);
    expect(expectedBlockHeight(1_795_163_880 - 12)).toBe(26_455_161);
  });

  it("height anchor (pure function, exact boundary, ASYMMETRIC round 8): expected − 10,000 served / − 10,001 refused, expected + 12 served / + 13 refused", () => {
    // Fixed now so the boundary is deterministic (no wall-clock tick).
    const now = CHECKPOINT_TIMESTAMP_SEC + 3600; // expected = 26455162 + 300
    const expected = expectedBlockHeight(now);
    expect(expected).toBe(26_455_462);
    expect(isQuorumBlockHeightAnchored(expected, now)).toBe(true);
    expect(isQuorumBlockHeightAnchored(expected - 10_000, now)).toBe(true);
    expect(isQuorumBlockHeightAnchored(expected - 10_001, now)).toBe(false);
    // Round 8 (J2 F3): the future side is tight (12 blocks, not 10,000) —
    // the honest tip can never exceed nominal expected height, so a pin
    // ahead of it is ahead only by checkpoint-time error + clock lag.
    expect(isQuorumBlockHeightAnchored(expected + 12, now)).toBe(true);
    expect(isQuorumBlockHeightAnchored(expected + 13, now)).toBe(false);
    expect(isQuorumBlockHeightAnchored(expected + 10_000, now)).toBe(false);
    expect(isQuorumBlockHeightAnchored(expected + 10_001, now)).toBe(false);
    // J2's attack pin is ~455k blocks behind — ~45x outside the tolerance.
    expect(isQuorumBlockHeightAnchored(26_000_000, now)).toBe(false);
    // A naive genesis+12s estimate overestimates the true height by ~3.2M
    // blocks (pre-merge ~13.5 s/block): it would refuse every honest pin.
    // The checkpoint design exists precisely to avoid that failure.
    expect(expected - 26_000_000).toBeGreaterThan(400_000);
  });

  it(
    "J2 exact forged-fresh case (round 7, dedicated): 2 legs agree on (block 26,000,000, old hash, timestamp = now) -> 502 STALE_BLOCK_PIN, never 200 at 1.0",
    async () => {
      const mk = () =>
        startStubRpc({
          blockNumber: 26_000_000,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1_740_000_000n,
          v2AmountOut: 1_740_000_000n,
          blockTimestampSec: nowSec(),
        });
      const a = await mk();
      const b = await mk();
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
        ).rejects.toMatchObject({ status: 502, code: "STALE_BLOCK_PIN" });
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "ROUND 8 BEHAVIOUR CHANGE (J2 F3, was: served at 1.0): forged-fresh with a SMALL lag (5,000 blocks behind, inside the ±10,000 anchor past side) -> 502 STALE_BLOCK_PIN. The round-7 expectation PINNED a forgery as correct; the round-8 number-vs-timestamp cross-check refuses it — a pin 5,000 blocks behind claims 'now' for a number implying 'now − 60,000 s', a ~60,000 s discrepancy vs a ~924 s tolerance 3 h after the checkpoint (0.03 × 10,800 + 600). NOT a weakening: the old 200 was a 16.7 h-stale 'verified at 1.0' quote, off by several percent of ETH movement; the anchor alone could not see it because the number lies inside its tolerance.",
    async () => {
      const block = expectedBlockHeight(nowSec()) - 5_000;
      const mk = () =>
        startStubRpc({
          blockNumber: block,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1_740_000_000n,
          v2AmountOut: 1_740_000_000n,
          blockTimestampSec: nowSec(),
        });
      const a = await mk();
      const b = await mk();
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
        ).rejects.toMatchObject({ status: 502, code: "STALE_BLOCK_PIN" });
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "honest fresh pin (expected live height, fresh timestamp) -> 200 at 1.0 (unchanged behaviour)",
    async () => {
      const mk = () =>
        startStubRpc({
          blockNumber: expectedBlockHeight(nowSec()),
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1_740_000_000n,
          v2AmountOut: 1_740_000_000n,
          blockTimestampSec: nowSec(),
        });
      const a = await mk();
      const b = await mk();
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.confidence).toBe(1.0);
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "stale-side anchor (stub integration, round 8): a CONSISTENT 100-block-old pin (block expected − 100, timestamp now − 1200 s, number and timestamp agreeing) is served — the cross-check passes it because the discrepancy is ~0 s — while expected − 10,001 with a FRESH timestamp is refused (anchor past side + cross-check). NOTE: the round-7 served side (expected − 10,000 with a fresh timestamp) can no longer be served by ANY design that checks number-vs-timestamp consistency: a 33 h-old number with a fresh timestamp is exactly the forgery the cross-check exists to refuse, and a consistent timestamp for it (now − 120,000 s) is refused by the 1800 s age bound. The exact −10,000 boundary stays pinned by the pure-function test above.",
    async () => {
      const now = nowSec();
      const expected = expectedBlockHeight(now);
      const mk = (block: number, ts: number) =>
        startStubRpc({
          blockNumber: block,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1_740_000_000n,
          v2AmountOut: 1_740_000_000n,
          blockTimestampSec: ts,
        });
      const served = await mk(expected - 100, nowSec() - 1200);
      const served2 = await mk(expected - 100, nowSec() - 1200);
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [served.url, served2.url],
        );
        expect(result.amount_out).toBe(1740000000);
        expect(result.block_number).toBe(expected - 100);
      } finally {
        await served.close();
        await served2.close();
      }
      const refused = await mk(expected - HEIGHT_ANCHOR_TOLERANCE_BLOCKS_PAST - 1, nowSec());
      const refused2 = await mk(expected - HEIGHT_ANCHOR_TOLERANCE_BLOCKS_PAST - 1, nowSec());
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [refused.url, refused2.url]),
        ).rejects.toMatchObject({ status: 502, code: "STALE_BLOCK_PIN" });
      } finally {
        await refused.close();
        await refused2.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "ROUND 8 BEHAVIOUR CHANGE (J2 F3, was: expected + 10,000 served): future height (stub integration): expected + 12 served, expected + 13 refused — a block ahead of wall-clock height cannot exist; only checkpoint-timestamp error of seconds plus handler clock lag could explain a few blocks ahead, and 12 blocks (~144 s) covers that with ~2x margin. The old +10,000 served expectation PINNED a non-existent future block as correct.",
    async () => {
      const now = nowSec();
      const expected = expectedBlockHeight(now);
      const mk = (block: number) =>
        startStubRpc({
          blockNumber: block,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1_740_000_000n,
          v2AmountOut: 1_740_000_000n,
          blockTimestampSec: nowSec(),
        });
      const served = await mk(expected + HEIGHT_ANCHOR_TOLERANCE_BLOCKS_FUTURE);
      const served2 = await mk(expected + HEIGHT_ANCHOR_TOLERANCE_BLOCKS_FUTURE);
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [served.url, served2.url],
        );
        expect(result.amount_out).toBe(1740000000);
        expect(result.block_number).toBe(expected + HEIGHT_ANCHOR_TOLERANCE_BLOCKS_FUTURE);
      } finally {
        await served.close();
        await served2.close();
      }
      const refused = await mk(expected + HEIGHT_ANCHOR_TOLERANCE_BLOCKS_FUTURE + 1);
      const refused2 = await mk(expected + HEIGHT_ANCHOR_TOLERANCE_BLOCKS_FUTURE + 1);
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [refused.url, refused2.url]),
        ).rejects.toMatchObject({ status: 502, code: "STALE_BLOCK_PIN" });
      } finally {
        await refused.close();
        await refused2.close();
      }
    },
    { timeout: 15000 },
  );

  it("future-skew bound (pure function, exact): now+60 served, +120 served, +121 refused, +10y refused", () => {
    const now = nowSec();
    expect(MAX_FUTURE_TIMESTAMP_SKEW_SEC).toBe(120);
    expect(isQuorumBlockTimestampFuture(now + 60, now)).toBe(false);
    expect(isQuorumBlockTimestampFuture(now + 120, now)).toBe(false);
    expect(isQuorumBlockTimestampFuture(now + 121, now)).toBe(true);
    expect(isQuorumBlockTimestampFuture(now + 10 * 365 * 86400, now)).toBe(true);
    expect(isQuorumBlockTimestampFuture(now, now)).toBe(false);
    expect(isQuorumBlockTimestampFuture(now - 1800, now)).toBe(false);
  });

  it(
    "future-skew (stub integration): now+60 served at 1.0 (existing pin, kept), now+10y -> 502 STALE_BLOCK_PIN (J2's exact case); boundary via ±5 s margins so a wall-second tick cannot flake it (+115 served, +125 refused — the exact 120/121 boundary is pinned by the pure-function test above)",
    async () => {
      // A7-fix drive-by hardening (J1's recommendation for this exact
      // flake): ONE captured `now` for the whole test. The old code
      // called nowSec() fresh per stub pair, so a wall-second tick
      // between the two calls gave the pair timestamps 1 s apart and the
      // Δ=0 triple (correctly) refused the quorum — the test then failed
      // with QUORUM_UNREACHABLE instead of the pinned outcome.
      const now = nowSec();
      const mk = (timestampSec: number) =>
        startStubRpc({
          blockNumber: expectedBlockHeight(now),
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1_740_000_000n,
          v2AmountOut: 1_740_000_000n,
          blockTimestampSec: timestampSec,
        });
      const skewed60 = await mk(now + 60);
      const skewed60b = await mk(now + 60);
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [skewed60.url, skewed60b.url],
        );
        expect(result.amount_out).toBe(1740000000);
        expect(result.confidence).toBe(1.0);
      } finally {
        await skewed60.close();
        await skewed60b.close();
      }
      const skewed115 = await mk(now + 115);
      const skewed115b = await mk(now + 115);
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [skewed115.url, skewed115b.url],
        );
        expect(result.amount_out).toBe(1740000000);
      } finally {
        await skewed115.close();
        await skewed115b.close();
      }
      const future10y = await mk(now + 10 * 365 * 86400);
      const future10yb = await mk(now + 10 * 365 * 86400);
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [future10y.url, future10yb.url]),
        ).rejects.toMatchObject({ status: 502, code: "STALE_BLOCK_PIN" });
      } finally {
        await future10y.close();
        await future10yb.close();
      }
      const skewed125 = await mk(now + 125);
      const skewed125b = await mk(now + 125);
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [skewed125.url, skewed125b.url]),
        ).rejects.toMatchObject({ status: 502, code: "STALE_BLOCK_PIN" });
      } finally {
        await skewed125.close();
        await skewed125b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "Minor X, liar-first (J2 exact shape): leg0 reports the quorum's number+hash but a 63-day-old timestamp and a HIGHER quote (1,745,000,000); legs 1-2 agree fresh -> the liar's quote never wins, the winning quote's upstream is an AGREEING leg, confidence 1.0 (the two agreeing RPCs still serve all three venues with nothing dropped, no missing family, >=2 RPCs — every round-5 ground for 1.0 is met, so 1.0 is what the code yields; it is NOT degraded to 0.9)",
    async () => {
      const mk = (timestampSec: number, v3: bigint) =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: v3,
          v2AmountOut: 1_730_000_000n,
          blockTimestampSec: timestampSec,
        });
      const fresh = nowSec();
      const liar = await mk(fresh - 63 * 86400, 1_745_000_000n);
      const a = await mk(fresh, 1_740_000_000n);
      const b = await mk(fresh, 1_740_000_000n);
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [liar.url, a.url, b.url],
        );
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(1.0);
        const receipt = result.receipt as Record<string, unknown>;
        expect([a.url, b.url]).toContain(receipt.upstream_url);
        expect(receipt.upstream_url).not.toBe(liar.url);
      } finally {
        await liar.close();
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "Minor X, liar-last +5% boundary: the liar's quotes (V3 1,827,000,000 AND Sushi 1,827,000,000 — each exactly +5% of the 1,740,000,000 median, in-band, would win if served) do NOT win — the agreeing legs' 1,740,000,000 wins from an agreeing upstream at confidence 1.0 (round 8, no-header-no-quotes: the liar never enters the quote order because it has not reported an agreeing header when the order is built, so its quotes are never requested — the round-7 straggler wait + post-quote drop + retry are gone. The Sushi quote is the sharp edge: venue rotation starts Sushi on the THIRD RPC, and the liar's header is systematically still in flight when the quorum resolves — the round-7 worker proved the triple filter ALONE lets it win at 1,827,000,000. This test FAILS if unknown legs are let back into the quote order (mutant f).)",
    async () => {
      const mk = (timestampSec: number, v3: bigint, sushi: bigint) =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: v3,
          v2AmountOut: 1_740_000_000n,
          uniAmountOut: 1_740_000_000n,
          sushiAmountOut: sushi,
          blockTimestampSec: timestampSec,
        });
      const fresh = nowSec();
      const a = await mk(fresh, 1_740_000_000n, 1_730_000_000n);
      const b = await mk(fresh, 1_740_000_000n, 1_730_000_000n);
      const liar = await mk(fresh - 63 * 86400, 1_827_000_000n, 1_827_000_000n);
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [a.url, b.url, liar.url],
        );
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(1.0);
        const receipt = result.receipt as Record<string, unknown>;
        expect([a.url, b.url]).toContain(receipt.upstream_url);
        expect(receipt.upstream_url).not.toBe(liar.url);
      } finally {
        await a.close();
        await b.close();
        await liar.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "Minor X, DELAYED liar (header 500 ms late): the liar's blockNumber answers 500 ms after the agreeing pair resolves the quorum, so it is 'unknown' when the quote order is built — under round 8 no-header-no-quotes it serves nothing, so its 1,827,000,000 quote must STILL not win (and the run still scores 1.0: the two agreeing legs serve all three venues with nothing dropped). Round 7 needed the straggler wait + post-quote drop + retry here; round 8 needs none of them, and the liar cannot win at ANY header delay (see the round-8 delay sweep below, 500 ms → 6 s).",
    async () => {
      const mk = (timestampSec: number, v3: bigint, sushi: bigint, blockDelayMs?: number) =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: v3,
          v2AmountOut: 1_740_000_000n,
          uniAmountOut: 1_740_000_000n,
          sushiAmountOut: sushi,
          blockTimestampSec: timestampSec,
          blockDelayMs,
        });
      const fresh = nowSec();
      const a = await mk(fresh, 1_740_000_000n, 1_730_000_000n);
      const b = await mk(fresh, 1_740_000_000n, 1_730_000_000n);
      const liar = await mk(fresh - 63 * 86400, 1_827_000_000n, 1_827_000_000n, 500);
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [a.url, b.url, liar.url],
        );
        expect(result.amount_out).toBe(1740000000);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(1.0);
        const receipt = result.receipt as Record<string, unknown>;
        expect([a.url, b.url]).toContain(receipt.upstream_url);
        expect(receipt.upstream_url).not.toBe(liar.url);
      } finally {
        await a.close();
        await b.close();
        await liar.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "J1 O1 (a): non-hex-string timestamp on every leg -> the legs cannot vote -> 502 QUORUM_UNREACHABLE, never a served pin of unprovable age",
    async () => {
      const mk = () =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1_740_000_000n,
          v2AmountOut: 1_740_000_000n,
          blockTimestampRaw: "not-a-timestamp",
        });
      const a = await mk();
      const b = await mk();
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
        ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "J1 O1 (b): timestamp 0x0 (zero) on every leg -> 502 QUORUM_UNREACHABLE",
    async () => {
      const mk = () =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1_740_000_000n,
          v2AmountOut: 1_740_000_000n,
          blockTimestampRaw: "0x0",
        });
      const a = await mk();
      const b = await mk();
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
        ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "J1 O1 (c): negative timestamp ('-1', fails the hex check) on every leg -> 502 QUORUM_UNREACHABLE",
    async () => {
      const mk = () =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1_740_000_000n,
          v2AmountOut: 1_740_000_000n,
          blockTimestampRaw: "-1",
        });
      const a = await mk();
      const b = await mk();
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
        ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "J1 O1 (d) FIXED round 8 (J2 F1a): ONE leg with a malformed (non-hex) timestamp + two healthy legs -> 200, and the malformed leg NEVER serves a quote. The round-7 version of this test was BLIND: it gave the malformed leg the SAME amounts as the healthy legs and asserted only 200, so a malformed-leg win was invisible. Here the malformed leg quotes HIGH (1,827,000,000 on every venue — the winning value if served), and the test asserts the healthy 1,740,000,000 wins from a HEALTHY upstream. Round 8 no-header-no-quotes: the malformed leg never reports a header (its header is recorded as 'garbage' failure evidence), so it never enters the quote order.",
    async () => {
      const bad = await startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1_827_000_000n,
        v2AmountOut: 1_827_000_000n,
        sushiAmountOut: 1_827_000_000n,
        blockTimestampRaw: "not-a-timestamp",
      });
      const mk = () =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1_740_000_000n,
          v2AmountOut: 1_730_000_000n,
          blockTimestampSec: nowSec(),
        });
      const a = await mk();
      const b = await mk();
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [bad.url, a.url, b.url],
        );
        expect(result.amount_out).toBe(1740000000);
        expect(result.confidence).toBe(1.0);
        const receipt = result.receipt as Record<string, unknown>;
        expect([a.url, b.url]).toContain(receipt.upstream_url);
        expect(receipt.upstream_url).not.toBe(bad.url);
      } finally {
        await bad.close();
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );
});

describe("round 8: no-header-no-quotes + asymmetric anchor + number-vs-timestamp cross-check (J2 F1–F6)", () => {
  const HASH = "0x" + "ab".repeat(32);
  const nowSec = () => Math.floor(Date.now() / 1000);

  it("F1b: a leg whose eth_blockNumber ERRORS immediately, quoting HIGH (1,827,000,000) -> it never serves a quote: healthy 1,740,000,000 wins from a healthy upstream at 1.0", async () => {
    const bad = await startStubRpc({
      blockNumber: FRESH_BLOCK,
      blockHash: HASH,
      failBlock: true,
      failCalls: false,
      v3AmountOut: 1_827_000_000n,
      v2AmountOut: 1_827_000_000n,
      sushiAmountOut: 1_827_000_000n,
    });
    const mk = () =>
      startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1_740_000_000n,
        v2AmountOut: 1_730_000_000n,
        blockTimestampSec: nowSec(),
      });
    const a = await mk();
    const b = await mk();
    try {
      const result = await handleRouteWithRpcs(
        { pair: "ETH/USDC" },
        [bad.url, a.url, b.url],
      );
      expect(result.amount_out).toBe(1740000000);
      expect(result.confidence).toBe(1.0);
      const receipt = result.receipt as Record<string, unknown>;
      expect([a.url, b.url]).toContain(receipt.upstream_url);
      expect(receipt.upstream_url).not.toBe(bad.url);
    } finally {
      await bad.close();
      await a.close();
      await b.close();
    }
  }, { timeout: 15000 });

  it("F1c: a leg HUNG on eth_blockNumber, quoting HIGH (1,827,000,000) -> it never serves a quote: healthy 1,740,000,000 wins from a healthy upstream at 1.0, wall < 2000 ms (round 7: 4,501 ms — the straggler wait is gone)", async () => {
    const hung = await startStubRpc({
      blockNumber: FRESH_BLOCK,
      blockHash: HASH,
      hangBlockNumber: true,
      failCalls: false,
      v3AmountOut: 1_827_000_000n,
      v2AmountOut: 1_827_000_000n,
      sushiAmountOut: 1_827_000_000n,
    });
    const mk = () =>
      startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1_740_000_000n,
        v2AmountOut: 1_730_000_000n,
        blockTimestampSec: nowSec(),
      });
    const a = await mk();
    const b = await mk();
    const startedAt = Date.now();
    try {
      const result = await handleRouteWithRpcs(
        { pair: "ETH/USDC" },
        [hung.url, a.url, b.url],
      );
      const elapsedMs = Date.now() - startedAt;
      console.log(`F1c hung-leg wall: ${elapsedMs} ms`);
      expect(elapsedMs).toBeLessThan(2000);
      expect(result.amount_out).toBe(1740000000);
      expect(result.confidence).toBe(1.0);
      const receipt = result.receipt as Record<string, unknown>;
      expect([a.url, b.url]).toContain(receipt.upstream_url);
      expect(receipt.upstream_url).not.toBe(hung.url);
    } finally {
      await hung.close();
      await a.close();
      await b.close();
    }
  }, { timeout: 30000 });

  it("F4 headline: hung leg ALONE (venues healthy) -> wall < 2000 ms at 1.0 (round 7: ~4,600 ms — the straggler wait taxed even this shape). The hung leg serves nothing, and the two agreeing legs serve all three venues.", async () => {
    const a = await startStubRpc({
      blockNumber: FRESH_BLOCK,
      blockHash: HASH,
      failCalls: false,
      v3AmountOut: 1_740_000_000n,
      v2AmountOut: 1_740_000_000n,
      blockTimestampSec: nowSec(),
    });
    const b = await startStubRpc({
      blockNumber: FRESH_BLOCK,
      blockHash: HASH,
      failCalls: false,
      v3AmountOut: 1_740_000_000n,
      v2AmountOut: 1_740_000_000n,
      blockTimestampSec: nowSec(),
    });
    const c = await startStubRpc({
      blockNumber: FRESH_BLOCK,
      blockHash: HASH,
      hangBlockNumber: true,
      failCalls: false,
      v3AmountOut: 1_740_000_000n,
      v2AmountOut: 1_740_000_000n,
    });
    const startedAt = Date.now();
    try {
      const result = await handleRouteWithRpcs(
        { pair: "ETH/USDC" },
        [a.url, b.url, c.url],
      );
      const elapsedMs = Date.now() - startedAt;
      console.log(`HUNG-LEG-ONLY wall: ${elapsedMs} ms`);
      expect(elapsedMs).toBeLessThan(2000);
      expect(result.amount_out).toBe(1740000000);
      expect(result.confidence).toBe(1.0);
    } finally {
      await a.close();
      await b.close();
      await c.close();
    }
  }, { timeout: 30000 });

  it("F2 sweep: a timestamp liar delaying ONLY its header by 500 / 4490 / 5000 / 6000 ms NEVER wins — healthy 1,740,000,000 from a healthy upstream at every delay, wall < 3000 ms even at 6 s delay (no wait to outrun; round 7 cliff was between 4490 ms caught and 4520 ms WON)", async () => {
    for (const delayMs of [500, 4490, 5000, 6000]) {
      const fresh = nowSec();
      const mk = (timestampSec: number, v3: bigint, sushi: bigint, blockDelayMs?: number) =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: v3,
          v2AmountOut: 1_740_000_000n,
          uniAmountOut: 1_740_000_000n,
          sushiAmountOut: sushi,
          blockTimestampSec: timestampSec,
          blockDelayMs,
        });
      const a = await mk(fresh, 1_740_000_000n, 1_730_000_000n);
      const b = await mk(fresh, 1_740_000_000n, 1_730_000_000n);
      const liar = await mk(fresh - 63 * 86400, 1_827_000_000n, 1_827_000_000n, delayMs);
      const startedAt = Date.now();
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [a.url, b.url, liar.url],
        );
        const elapsedMs = Date.now() - startedAt;
        console.log(`F2 sweep headerDelay=${delayMs}ms wall=${elapsedMs}ms amount=${result.amount_out} conf=${result.confidence}`);
        expect(elapsedMs).toBeLessThan(3000);
        expect(result.amount_out).toBe(1740000000);
        expect(result.confidence).toBe(1.0);
        const receipt = result.receipt as Record<string, unknown>;
        expect([a.url, b.url]).toContain(receipt.upstream_url);
        expect(receipt.upstream_url).not.toBe(liar.url);
      } finally {
        await a.close();
        await b.close();
        await liar.close();
      }
    }
    // Timestamp-only liar (60 s off), header 5 s late — still never wins.
    const fresh = nowSec();
    const mk2 = (timestampSec: number, v3: bigint, sushi: bigint, blockDelayMs?: number) =>
      startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: v3,
        v2AmountOut: 1_740_000_000n,
        uniAmountOut: 1_740_000_000n,
        sushiAmountOut: sushi,
        blockTimestampSec: timestampSec,
        blockDelayMs,
      });
    const a2 = await mk2(fresh, 1_740_000_000n, 1_730_000_000n);
    const b2 = await mk2(fresh, 1_740_000_000n, 1_730_000_000n);
    const liar2 = await mk2(fresh - 60, 1_827_000_000n, 1_827_000_000n, 5000);
    try {
      const result = await handleRouteWithRpcs(
        { pair: "ETH/USDC" },
        [a2.url, b2.url, liar2.url],
      );
      expect(result.amount_out).toBe(1740000000);
      const receipt = result.receipt as Record<string, unknown>;
      expect(receipt.upstream_url).not.toBe(liar2.url);
    } finally {
      await a2.close();
      await b2.close();
      await liar2.close();
    }
  }, { timeout: 60000 });

  it("F3: two COLLUDING legs, 9,000 blocks behind (30 h stale) with a fresh timestamp -> 502 STALE_BLOCK_PIN (round 7: served at 1.0)", async () => {
    const block = expectedBlockHeight(nowSec()) - 9_000;
    const mk = () =>
      startStubRpc({
        blockNumber: block,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1_740_000_000n,
        v2AmountOut: 1_740_000_000n,
        blockTimestampSec: nowSec(),
      });
    const a = await mk();
    const b = await mk();
    try {
      await expect(
        handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
      ).rejects.toMatchObject({ status: 502, code: "STALE_BLOCK_PIN" });
    } finally {
      await a.close();
      await b.close();
    }
  }, { timeout: 15000 });

  it("F3: a pin 9,999 blocks AHEAD of expected height (a block that does not exist yet) with a fresh timestamp -> 502 STALE_BLOCK_PIN (round 7: served)", async () => {
    const block = expectedBlockHeight(nowSec()) + 9_999;
    const mk = () =>
      startStubRpc({
        blockNumber: block,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1_740_000_000n,
        v2AmountOut: 1_740_000_000n,
        blockTimestampSec: nowSec(),
      });
    const a = await mk();
    const b = await mk();
    try {
      await expect(
        handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]),
      ).rejects.toMatchObject({ status: 502, code: "STALE_BLOCK_PIN" });
    } finally {
      await a.close();
      await b.close();
    }
  }, { timeout: 15000 });

  it("F3 cross-check (pure function, exact boundaries): the number-implied timestamp, the drift-scaled tolerance, and the age-bound low side", () => {
    // Fixed now: 1 h after the checkpoint (elapsed 3600 s -> tolerance 708 s).
    const now = CHECKPOINT_TIMESTAMP_SEC + 3600;
    const expected = expectedBlockHeight(now);
    expect(expected).toBe(26_455_462);
    expect(impliedBlockTimestamp(CHECKPOINT_BLOCK)).toBe(CHECKPOINT_TIMESTAMP_SEC);
    expect(impliedBlockTimestamp(expected)).toBe(now);
    expect(TIMESTAMP_CONSISTENCY_DRIFT_RATE).toBe(0.03);
    expect(TIMESTAMP_CONSISTENCY_SLACK_SEC).toBe(600);
    expect(TIMESTAMP_CONSISTENCY_MAX_LAG_SEC).toBe(MAX_BLOCK_AGE_SEC);
    expect(timestampConsistencyToleranceSec(now)).toBe(708); // 3% of 3600 + 600
    // Honest pin: number and timestamp agree -> consistent.
    expect(isQuorumBlockTimestampConsistent(expected, now, now)).toBe(true);
    // Fresh-timestamp forgery 60 blocks behind: discrepancy 720 s > 708 s -> refused.
    expect(isQuorumBlockTimestampConsistent(expected - 60, now, now)).toBe(false);
    // ...but 59 blocks behind is exactly at the tolerance (708 s) -> served (boundary-inclusive).
    expect(isQuorumBlockTimestampConsistent(expected - 59, now, now)).toBe(true);
    // Fresh-timestamp forgery 5,000 behind: discrepancy 60,000 s -> refused.
    expect(isQuorumBlockTimestampConsistent(expected - 5000, now, now)).toBe(false);
    // Age-boundary pin (fresh block, timestamp 1799 s old): the low side is
    // deliberately the age bound itself, so it passes the cross-check.
    expect(isQuorumBlockTimestampConsistent(expected, now - 1799, now)).toBe(true);
    // Low-side boundary, exact (implied timestamp of `expected` is exactly
    // `now`, so the discrepancy is exactly the timestamp lag).
    expect(isQuorumBlockTimestampConsistent(expected, now - 1800, now)).toBe(true);
    expect(isQuorumBlockTimestampConsistent(expected, now - 1801, now)).toBe(false);
    // High-side boundary, exact: tolerance 708 s at this `now`.
    expect(isQuorumBlockTimestampConsistent(expected, now + 708, now)).toBe(true);
    expect(isQuorumBlockTimestampConsistent(expected, now + 709, now)).toBe(false);
    // Near the checkpoint the slack dominates: at the checkpoint itself the
    // tolerance is exactly 600 s, so a forgery 51 blocks behind (612 s) is
    // refused while 50 blocks behind (600 s) is served (boundary-inclusive).
    const atCheckpoint = CHECKPOINT_TIMESTAMP_SEC;
    expect(timestampConsistencyToleranceSec(atCheckpoint)).toBe(600);
    expect(isQuorumBlockTimestampConsistent(CHECKPOINT_BLOCK - 50, atCheckpoint, atCheckpoint)).toBe(true);
    expect(isQuorumBlockTimestampConsistent(CHECKPOINT_BLOCK - 51, atCheckpoint, atCheckpoint)).toBe(false);
    // At Dec 1 00:00Z the tolerance is 28,179 s (~2,348 blocks): a 5,000-block
    // forgery is still refused there, with ~2.1x margin.
    const dec1 = Math.floor(new Date("2026-12-01T00:00:00Z").getTime() / 1000);
    expect(dec1 - CHECKPOINT_TIMESTAMP_SEC).toBe(919_320);
    expect(timestampConsistencyToleranceSec(dec1)).toBe(28_179); // floor(3% of 919,320) = 27,579 + 600
    expect(isQuorumBlockTimestampConsistent(expectedBlockHeight(dec1) - 5000, dec1, dec1)).toBe(false);
    expect(isQuorumBlockTimestampConsistent(expectedBlockHeight(dec1) - 2348, dec1, dec1)).toBe(true);
    expect(isQuorumBlockTimestampConsistent(expectedBlockHeight(dec1) - 2349, dec1, dec1)).toBe(false);
  });

  it("F5 rot detection (independent height source): the anchor predicts two INDEPENDENT live observations within 1,000 blocks — the pairs are hardcoded and do NOT call expectedBlockHeight to construct the expectation, so a rotten checkpoint (wrong constants) fails this test", () => {
    // Pair 1: J1's live probe, 2026-11-20T11:14:42Z — block 26,455,941 observed
    // live; the anchor expected 26,455,945 (live 4 below expected).
    const t1 = 1_795_173_282; // 2026-11-20T11:14:42Z
    expect(new Date(t1 * 1000).toISOString()).toBe("2026-11-20T11:14:42.000Z");
    expect(isQuorumBlockHeightAnchored(26_455_941, t1)).toBe(true);
    expect(Math.abs(26_455_941 - expectedBlockHeight(t1))).toBeLessThanOrEqual(1000);
    expect(expectedBlockHeight(t1)).toBe(26_455_945);
    // Pair 2: the round-4 live observation, block 26,455,025 fetched at
    // 2026-11-20T08:10:52Z (route-r4-scratch/live-route-r4.json, checked_at);
    // the anchor expected 26,455,026 (live 1 below expected — note
    // Math.floor(-1628/12) = -136, not -135).
    const t2 = 1_795_162_252; // 2026-11-20T08:10:52Z
    expect(new Date(t2 * 1000).toISOString()).toBe("2026-11-20T08:10:52.000Z");
    expect(isQuorumBlockHeightAnchored(26_455_025, t2)).toBe(true);
    expect(Math.abs(26_455_025 - expectedBlockHeight(t2))).toBeLessThanOrEqual(1000);
    expect(expectedBlockHeight(t2)).toBe(26_455_026);
  });

  it("F5 checkpoint-age alarm: the checkpoint must be at most 46 days old (the 3%-missed exhaustion bound, ~Jan 5) — a deliberate re-pin alarm, not a flaky time test: if the miner runs past early January without a re-pin, this fails BEFORE live honest pins start refusing", () => {
    const ageSec = Math.floor(Date.now() / 1000) - CHECKPOINT_TIMESTAMP_SEC;
    // 46 days = 3,974,400 s: at 3% missed slots the 10,000-block tolerance
    // is exhausted after ~46.3 days (10,000 / (0.03 x 7200 blocks/day)).
    expect(ageSec).toBeLessThanOrEqual(46 * 86400);
  });

  it("F4 slow-quote shape (J2 G4, A7): hung leg + 1.5 s-slow quotes -> wall < 8000 ms, correct winner at 0.9. The wall is dominated by the 1.5 s slow quotes plus the straggler grace for the hung leg (A7-fix, J2 F2/F3: the hung venue's loser is aborted on the fast win, so the venue phase no longer costs a 4.0 s parallel timeout round) — the envelope for slow-quote shapes is ~2.5 s, and the suite's 6000 ms bound is scoped to fast-quorum shapes (see JUDGE.md §5).", async () => {
    const a = await startStubRpc({
      blockNumber: FRESH_BLOCK,
      blockHash: HASH,
      failCalls: false,
      v3AmountOut: 1739203982n,
      v2AmountOut: 1730000000n,
      blockTimestampSec: nowSec(),
      callDelayMs: 1500,
    });
    const b = await startStubRpc({
      blockNumber: FRESH_BLOCK,
      blockHash: HASH,
      failCalls: false,
      hangCalls: true,
      v3AmountOut: 1739203982n,
      v2AmountOut: 1730000000n,
      blockTimestampSec: nowSec(),
    });
    const c = await startStubRpc({
      blockNumber: FRESH_BLOCK,
      blockHash: HASH,
      hangBlockNumber: true,
      failCalls: false,
      v3AmountOut: 1739203982n,
      v2AmountOut: 1730000000n,
      blockTimestampSec: nowSec(),
      callDelayMs: 1500,
    });
    const startedAt = Date.now();
    try {
      const result = await handleRouteWithRpcs(
        { pair: "ETH/USDC" },
        [a.url, b.url, c.url],
      );
      const elapsedMs = Date.now() - startedAt;
      console.log(`SLOW-QUOTE hung-leg wall: ${elapsedMs} ms`);
      expect(elapsedMs).toBeLessThan(8000);
      expect(result.amount_out).toBe(1739203982);
      // Only A serves a quote (B hangs on calls, C is excluded) -> 0.9.
      expect(result.confidence).toBe(0.9);
    } finally {
      await a.close();
      await b.close();
      await c.close();
    }
  }, { timeout: 30000 });
});

describe("round 9: latency re-baseline — all-hung wall ~9 s, phase-additive envelope (J2 round-8 FAIL, doc-only, no handler change)", () => {
  const HASH = "0x" + "ab".repeat(32);
  const nowSec = () => Math.floor(Date.now() / 1000);

  it(
    "W1 slow+slow (round 9 shape, A7 timeouts): slow quorum 3.5 s + slow quotes 3.5 s -> 200 at 1.0, wall < 10000 ms. Round 9 measured 8,040 / 8,011 ms at 4.0 s delays; A7 drops the per-RPC timeouts to 4000 ms, so the delays move to 3.5 s (a 4.0 s delay vs a 4.0 s timeout is racy). The wall is the SUM of the two phases, not one phase — the ~6.0–6.5 s envelope holds only with a fast quorum.",
    async () => {
      const ts = nowSec();
      const mk = () =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1739203982n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: ts,
          blockDelayMs: 3500,
          callDelayMs: 3500,
        });
      const a = await mk();
      const b = await mk();
      const c = await mk();
      const startedAt = Date.now();
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [a.url, b.url, c.url],
        );
        const elapsedMs = Date.now() - startedAt;
        console.log(`W1 slow-quorum-4s + slow-quotes-4s wall: ${elapsedMs} ms`);
        expect(elapsedMs).toBeLessThan(10000);
        expect(result.amount_out).toBe(1739203982);
        expect(result.confidence).toBe(1.0);
      } finally {
        await a.close();
        await b.close();
        await c.close();
      }
    },
    { timeout: 30000 },
  );

  it(
    "W2 slow-quorum + hung venue (round 9 shape, A7): quorum 1.5 s + hung leg first in rpcOrder + fast quotes -> 200 at 0.9, wall < 7000 ms. Round 9 measured 6,038 / 6,014 ms with a 4.5 s sequential failover; A7 hedged the failover (one 4.0 s parallel timeout round), so the wall was ~1.5 s quorum + ~4.0 s venue ≈ 5.5 s. A7-fix (J2 F3) aborts the hung loser on the fast win, so the venue phase is now ~fast-quote time and the wall is ~1.5 s quorum + 1.0 s straggler grace (J2 F2, hung 3rd leg) ≈ 2.5 s. This fast-quote shape legitimately exceeds 6,000 ms, so the 6,000 ms bound is SCOPED to fast-quorum shapes — the bound is not relaxed: no existing <6000 ms test is a slow-quorum shape, and this test pins the slow-quorum shape separately.",
    async () => {
      const ts = nowSec();
      const a = await startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        failCalls: false,
        hangCalls: true,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
        blockDelayMs: 1500,
      });
      const b = await startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
        blockDelayMs: 1500,
      });
      const c = await startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        hangBlockNumber: true,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
      });
      const startedAt = Date.now();
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [a.url, b.url, c.url],
        );
        const elapsedMs = Date.now() - startedAt;
        console.log(`W2 quorum-1.5s + hung-venue wall: ${elapsedMs} ms`);
        expect(elapsedMs).toBeLessThan(7000);
        expect(result.amount_out).toBe(1739203982);
        // Only B serves a quote (A hangs on calls, C is excluded) -> 0.9.
        expect(result.confidence).toBe(0.9);
      } finally {
        await a.close();
        await b.close();
        await c.close();
      }
    },
    { timeout: 30000 },
  );

  it(
    "W3 slow quorum + hang-failover + slow quotes (round 9 shape, A7): quorum 3.5 s + hung leg first in rpcOrder + 3.5 s quotes -> 200 at 0.9, wall < 14000 ms. Round 9 measured 12,550 / 12,512 ms at 4.0 s delays with a 4.5 s sequential failover (4.0 s quorum + 4.5 s failover + 4.0 s quotes); A7 moves the delays to 3.5 s (4000 ms timeouts) and hedges the failover (one 4.0 s parallel round), so the wall was ~3.5 s quorum + ~4.0 s venue ≈ 7.5 s. A7-fix (J2 F2/F3): the straggler grace after the 3.5 s quorum is deadline-aware — it shrinks to ~450 ms so the venue phase keeps its full 4.0 s budget inside the 8 s deadline — and the hung loser is aborted on the slow win, so the wall is now ~3.5 s quorum + ~0.45 s grace + ~3.5 s quotes ≈ 7.45 s, inside the 8 s deadline.",
    async () => {
      const ts = nowSec();
      const a = await startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        failCalls: false,
        hangCalls: true,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
        blockDelayMs: 3500,
      });
      const b = await startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
        blockDelayMs: 3500,
        callDelayMs: 3500,
      });
      const c = await startStubRpc({
        blockNumber: FRESH_BLOCK,
        blockHash: HASH,
        hangBlockNumber: true,
        failCalls: false,
        v3AmountOut: 1739203982n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
      });
      const startedAt = Date.now();
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [a.url, b.url, c.url],
        );
        const elapsedMs = Date.now() - startedAt;
        console.log(`W3 quorum-4s + hang-failover + slow-4s-quotes wall: ${elapsedMs} ms`);
        expect(elapsedMs).toBeLessThan(14000);
        expect(result.amount_out).toBe(1739203982);
        // Only B serves a quote (A hangs on calls, C is excluded) -> 0.9.
        expect(result.confidence).toBe(0.9);
      } finally {
        await a.close();
        await b.close();
        await c.close();
      }
    },
    { timeout: 30000 },
  );

  it(
    "all-hung eth_call wall PINNED at ~4 s (A7, round 11): 502 ALL_QUOTERS_FAILED with wall >= 3000 ms and < 8000 ms. The round-9 ~9.0 s pin (2 sequential 4.5 s venue failovers) is SUPERSEDED: tryVenue now fires both RPCs hedged in parallel with a 4000 ms per-RPC timeout, so the wall is one parallel timeout round (~4.0 s), and the 8 s total deadline caps it even if the phases stack.",
    async () => {
      const ts = nowSec();
      const mk = () =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          hangCalls: true,
          v3AmountOut: 1739203982n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: ts,
        });
      const a = await mk();
      const b = await mk();
      const c = await mk();
      const startedAt = Date.now();
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url, c.url]),
        ).rejects.toMatchObject({ status: 502, code: "ALL_QUOTERS_FAILED" });
        const elapsedMs = Date.now() - startedAt;
        console.log(`ALL-HUNG eth_call wall (A7 pin): ${elapsedMs} ms`);
        expect(elapsedMs).toBeGreaterThanOrEqual(3000);
        expect(elapsedMs).toBeLessThan(8000);
      } finally {
        await a.close();
        await b.close();
        await c.close();
      }
    },
    { timeout: 30000 },
  );

  it("future-skew +119 served (round 9, pure-function boundary): a timestamp 119 s ahead of now is served — the boundary-adjacent value the suite had not pinned (the existing pure-function test pins +60 / +120 served and +121 refused; the exact 120/121 boundary stays there)", () => {
    const now = nowSec();
    expect(MAX_FUTURE_TIMESTAMP_SKEW_SEC).toBe(120);
    expect(isQuorumBlockTimestampFuture(now + 119, now)).toBe(false);
  });

  it("forgery bound is elapsed-dependent (round 10, pure-function pin at fixed elapsed 13,958 s): the round-9 'fresh-timestamp forgery ≤81 blocks' was the −81 test shape's own nominal discrepancy, not the bound — at this fixed moment the tolerance is 1,018 s and the max passing forgery is 84 blocks (−84 served, discrepancy 1,010 s; −85 refused, 1,022 s). The −81 shape's true discrepancy is (elapsed mod 12) + 972 s = 974 s here, not the nominal 972 s. Fixed now, so this pin passes deterministically regardless of wall-clock time.", () => {
    // Fixed now: 13,958 s after the checkpoint — the exact moment round 9
    // re-verified the composed −81 shape. elapsed mod 12 = 2, so the true
    // discrepancy of a fresh-timestamp forgery d blocks behind is 2 + 12d.
    const now = CHECKPOINT_TIMESTAMP_SEC + 13_958;
    expect(now - CHECKPOINT_TIMESTAMP_SEC).toBe(13_958);
    expect(timestampConsistencyToleranceSec(now)).toBe(1_018); // floor(3% of 13,958) + 600
    const expected = expectedBlockHeight(now);
    expect(expected).toBe(26_456_325); // 26,455,162 + floor(13,958 / 12)
    // True discrepancies: −81 -> 974 s, −84 -> 1,010 s, −85 -> 1,022 s.
    expect(now - impliedBlockTimestamp(expected - 81)).toBe(974);
    expect(now - impliedBlockTimestamp(expected - 84)).toBe(1_010);
    expect(now - impliedBlockTimestamp(expected - 85)).toBe(1_022);
    // The bound at this moment is 84, not 81: −84 is served (boundary-adjacent
    // pass), −85 is refused. The −81 composed shape is served, as round 9 found.
    expect(isQuorumBlockTimestampConsistent(expected - 84, now, now)).toBe(true);
    expect(isQuorumBlockTimestampConsistent(expected - 85, now, now)).toBe(false);
    expect(isQuorumBlockTimestampConsistent(expected - 81, now, now)).toBe(true);
  });
});

describe("round 11 (A7 ROUTE gate): ±1 block tolerance + min pin, 8 s deadline, 4000 ms timeouts, hedged failover, lowercase pair, receipt persistence", () => {
  const HASH = "0x" + "ab".repeat(32);
  const HASH2 = "0x" + "cd".repeat(32);
  const nowSec = () => Math.floor(Date.now() / 1000);

  function qb(blockNumber: number, blockHash: string, blockTimestamp: number, parentHash = ""): QuorumBlock {
    return { blockNumber, blockHash, blockTimestamp, parentHash };
  }

  it("constants: 4000 ms per-RPC timeouts, 8000 ms total deadline, max 2 RPCs per venue, ±1 tolerance", () => {
    expect(QUORUM_TIMEOUT_MS).toBe(4000);
    expect(CALL_TIMEOUT_MS).toBe(4000);
    expect(ROUTE_TOTAL_DEADLINE_MS).toBe(8000);
    expect(MAX_VENUE_RPCS).toBe(2);
    expect(QUORUM_BLOCK_TOLERANCE).toBe(1);
    // A7-fix (J2 F1–F6): Δ=1 timestamp gap bound, straggler grace before
    // pinning, persist reserve inside the deadline, first-success grace.
    expect(DELTA1_MAX_TIMESTAMP_GAP_SEC).toBe(300);
    expect(QUORUM_STRAGGLER_GRACE_MS).toBe(1000);
    expect(ROUTE_PERSIST_RESERVE_MS).toBe(50);
    expect(FIRST_SUCCESS_GRACE_MS).toBe(50);
  });

  it("venueCallTimeoutMsForDeadline (pure, A7-fix J2 F5): venue timeout is the remaining budget minus the persist reserve, capped at the per-RPC 4000 ms", () => {
    // Fast quorum: the cap binds, not the budget.
    expect(venueCallTimeoutMsForDeadline(8000, 0)).toBe(4000);
    expect(venueCallTimeoutMsForDeadline(8000, 3000)).toBe(4000);
    // Boundary: exactly at the cap (8000 − 3950 − 50 = 4000).
    expect(venueCallTimeoutMsForDeadline(8000, 3950)).toBe(4000);
    // Slow quorum: the remaining budget binds.
    expect(venueCallTimeoutMsForDeadline(8000, 3951)).toBe(3999);
    expect(venueCallTimeoutMsForDeadline(8000, 4000)).toBe(3950);
    expect(venueCallTimeoutMsForDeadline(8000, 5000)).toBe(2950);
    // Injected 4 s deadline, 1 s quorum (the over-budget test's shape).
    expect(venueCallTimeoutMsForDeadline(4000, 1000)).toBe(2950);
  });

  it("quorumBlocksAgree (pure): Δ=0 needs hash+timestamp equality; Δ=±1 needs the parentHash binding AND a plausibly ordered timestamp (A7-fix, J2 F6); Δ≥2 never agrees", () => {
    const ts = nowSec();
    const n = expectedBlockHeight(ts);
    // Δ=0, identical triple -> agree.
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n, HASH, ts))).toBe(true);
    // Δ=0, different hash -> disagree (fork at the same height).
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n, HASH2, ts))).toBe(false);
    // Δ=0, different timestamp -> disagree (timestamp liar).
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n, HASH, ts + 1))).toBe(false);
    // Δ=+1 with the binding (higher.parentHash == lower.hash) -> agree;
    // timestamps legitimately differ by ~12 s and are compared only for
    // plausible ordering (A7-fix, J2 F6 — the A7 version did not compare
    // them at all across Δ=1).
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n + 1, HASH2, ts + 12, HASH))).toBe(true);
    // Δ=-1 is symmetric -> agree.
    expect(quorumBlocksAgree(qb(n + 1, HASH2, ts + 12, HASH), qb(n, HASH, ts))).toBe(true);
    // Δ=+1 WITHOUT a parentHash -> disagree (the old block-number
    // disagreement shape: same hash, no binding, must still 502).
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n + 1, HASH, ts))).toBe(false);
    // Δ=+1 with the WRONG parentHash -> disagree.
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n + 1, HASH2, ts + 12, HASH2))).toBe(false);
    // Δ=+1, binding present, but the higher block's timestamp is EARLIER
    // than the lower's -> disagree (a later block cannot carry an
    // earlier timestamp; J2's P10 shape, timestamp now+10y, is the same
    // rule at the other end of the range).
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n + 1, HASH2, ts - 12, HASH))).toBe(false);
    // Δ=+1, binding present, higher timestamp exactly at the gap bound
    // (300 s) -> agree (boundary-inclusive); 1 s beyond it -> disagree.
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n + 1, HASH2, ts + 300, HASH))).toBe(true);
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n + 1, HASH2, ts + 301, HASH))).toBe(false);
    // Δ=+1, binding present, equal timestamps -> agree (greater-or-equal).
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n + 1, HASH2, ts, HASH))).toBe(true);
    // Δ=2, even with a parentHash binding, never agrees.
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n + 2, HASH2, ts + 24, HASH))).toBe(false);
    expect(quorumBlocksAgree(qb(n, HASH, ts), qb(n - 2, HASH2, ts - 24, HASH))).toBe(false);
  });

  it("pinQuorumBlock (pure): pins the MINIMUM agreeing block, never the max; ignores non-agreeing legs", () => {
    const ts = nowSec();
    const n = expectedBlockHeight(ts);
    const lower = qb(n, HASH, ts);
    const higher = qb(n + 1, HASH2, ts + 12, HASH);
    // Quorum value is the higher block (arrived first) -> pin is the lower.
    expect(pinQuorumBlock(higher, [lower, higher]).blockNumber).toBe(n);
    // Quorum value is the lower block -> pin stays the lower.
    expect(pinQuorumBlock(lower, [lower, higher]).blockNumber).toBe(n);
    // A non-agreeing leg (Δ=2, or Δ=1 without binding) never moves the pin.
    const far = qb(n + 2, HASH2, ts + 24, HASH);
    expect(pinQuorumBlock(lower, [lower, higher, far]).blockNumber).toBe(n);
    expect(pinQuorumBlock(higher, [higher, far]).blockNumber).toBe(n + 1);
    // No other legs seen: the quorum value is its own pin.
    expect(pinQuorumBlock(lower, []).blockNumber).toBe(n);
  });

  it(
    "±1 integration: legs at N and N+1 (parentHash-bound) -> 200, block_number is the MIN (N), confidence 1.0 (A7-fix, J2 F1: the higher leg agrees with the pin under quorumBlocksAgree, so BOTH legs serve quotes — the A7 version's 0.9 pinned the exact-match gate that disenfranchised the higher leg; that gate was the defect), upstream is the min leg (lowest-index win in the healthy case)",
    async () => {
      const n = FRESH_BLOCK;
      const ts = nowSec();
      const low = await startStubRpc({
        blockNumber: n,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
      });
      const high = await startStubRpc({
        blockNumber: n + 1,
        blockHash: HASH2,
        blockParentHash: HASH,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts + 12,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [low.url, high.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.block_number).toBe(n);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        // Both agreeing legs serve quotes at the pinned block (an eth_call
        // at N is a historical call for the N+1 leg), so the full
        // three-venue cross-check runs on two RPCs: confidence 1.0.
        expect(result.confidence).toBe(1.0);
        const receipt = result.receipt as Record<string, unknown>;
        expect(receipt.upstream_url).toBe(low.url);
      } finally {
        await low.close();
        await high.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "±1 integration, higher leg FIRST in rpcOrder: pin is still the MIN (N), never the max — order must not move the pin. Upstream is the HIGH leg here: tryVenue takes the first success and the first RPC in rpcOrder serves first (A7-fix, J2 F3) — the PIN is order-independent, the serving RPC is not.",
    async () => {
      const n = FRESH_BLOCK;
      const ts = nowSec();
      const low = await startStubRpc({
        blockNumber: n,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
      });
      const high = await startStubRpc({
        blockNumber: n + 1,
        blockHash: HASH2,
        blockParentHash: HASH,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts + 12,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [high.url, low.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.block_number).toBe(n);
        const receipt = result.receipt as Record<string, unknown>;
        expect(receipt.upstream_url).toBe(high.url);
      } finally {
        await low.close();
        await high.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "±1 integration, third leg at N: two legs agree exactly at N, one trails at N+1 -> 200 at 1.0 (the ±1 case degrades only when the pin has a single attesting leg)",
    async () => {
      const n = FRESH_BLOCK;
      const ts = nowSec();
      const mk = (blockNumber: number, blockHash: string, parentHash?: string) =>
        startStubRpc({
          blockNumber,
          blockHash,
          blockParentHash: parentHash,
          failCalls: false,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: blockNumber === n ? ts : ts + 12,
        });
      const a = await mk(n, HASH);
      const b = await mk(n, HASH);
      const c = await mk(n + 1, HASH2, HASH);
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [a.url, b.url, c.url],
        );
        expect(result.amount_out).toBe(1740000000);
        expect(result.block_number).toBe(n);
        expect(result.confidence).toBe(1.0);
      } finally {
        await a.close();
        await b.close();
        await c.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "deadline (mechanism, injectable): a 100 ms deadline with 500 ms-slow legs -> 502 ROUTE_DEADLINE in well under 1 s (never a slow 200, never a hang)",
    async () => {
      // One shared timestamp for both stubs: two fresh nowSec() calls
      // could straddle a wall second and flake the quorum (same
      // mechanism as the future-skew flake — see that test's comment).
      const ts = nowSec();
      const mk = () =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: ts,
          blockDelayMs: 500,
          callDelayMs: 500,
        });
      const a = await mk();
      const b = await mk();
      const startedAt = Date.now();
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url], 100),
        ).rejects.toMatchObject({ status: 502, code: "ROUTE_DEADLINE" });
        expect(Date.now() - startedAt).toBeLessThan(1000);
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "hedged failover (A7, A7-fix J2 F3): first RPC hangs on eth_call, second serves fast -> 200 with wall < 5000 ms. A7-fix: the hung loser is ABORTED on the fast win, so the wall is now ~winner time + 50 ms (well under 5000 ms), not the A7 max(one 4.0 s timeout, fast success) ≈ 4.0 s — the 5000 ms bound is kept as the regression ceiling, and the A7-fix describe below pins the tight wall.",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = HASH;
      // One shared timestamp for both stubs (see the deadline test's
      // comment — two fresh nowSec() calls can straddle a wall second
      // and flake the quorum).
      const ts = nowSec();
      const hung = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        hangCalls: true,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
      });
      const fast = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
      });
      const startedAt = Date.now();
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [hung.url, fast.url],
        );
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeLessThan(5000);
        expect(result.amount_out).toBe(1740000000);
        expect(result.confidence).toBe(0.9);
        const receipt = result.receipt as Record<string, unknown>;
        expect(receipt.upstream_url).toBe(fast.url);
      } finally {
        await hung.close();
        await fast.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "receipt persistence (A7): a stubbed success writes its receipt to the DB with the ACTUAL winning rpcUrl as upstream_url, and the stored evidence re-hashes to raw_response_sha256",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = HASH;
      // One shared timestamp for both stubs (see the deadline test's
      // comment — two fresh nowSec() calls can straddle a wall second
      // and flake the quorum; this test failed exactly that way in the
      // A7-fix verification run).
      const ts = nowSec();
      const a = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
      });
      const b = await startStubRpc({
        blockNumber,
        blockHash,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url]);
        const receipt = result.receipt as Record<string, unknown>;
        expect(typeof receipt.receipt_id).toBe("string");
        // The winning quote came from the first RPC (deterministic
        // lowest-index hedged win) — the stored upstream must be that
        // same URL, not the quorum-first or a failover RPC.
        expect(receipt.upstream_url).toBe(a.url);
        // PG-MIGRATE: backend-agnostic read-back (tests/helpers/storeView.ts).
        const row = await storedReceiptRow(receipt.receipt_id as string);
        expect(row).toBeDefined();
        expect(row?.intent).toBe("OPTIMAL_EXECUTION_ROUTE_GENERAL");
        expect(row?.upstream_url).toBe(a.url);
        expect(row?.raw_response_sha256).toBe(receipt.raw_response_sha256);
        expect(row?.evidence_bytes).toBeGreaterThan(0);
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );
});

describe("round 11 fix (A7-fix, J2 F1–F6): agreeing higher leg serves, deterministic pin, cancelled losers, no phantom receipt, remaining-budget venue timeout, Δ=1 timestamp ordering", () => {
  const HASH = "0x" + "ab".repeat(32);
  const HASH2 = "0x" + "cd".repeat(32);
  const HASH3 = "0x" + "ef".repeat(32);
  const nowSec = () => Math.floor(Date.now() / 1000);

  // PG-MIGRATE: backend-agnostic (tests/helpers/storeView.ts).
  const countRouteReceipts = (): Promise<number> => countReceipts("OPTIMAL_EXECUTION_ROUTE_GENERAL");


  it(
    "F1 (J2 P1): min leg FAILS on eth_call, healthy higher leg at N+1 (parentHash-bound) serves -> 200 at the MIN pin N, upstream is the higher leg, confidence 0.9 (only 1 RPC served quotes)",
    async () => {
      const n = FRESH_BLOCK;
      const ts = nowSec();
      const low = await startStubRpc({
        blockNumber: n,
        blockHash: HASH,
        failCalls: true,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
      });
      const high = await startStubRpc({
        blockNumber: n + 1,
        blockHash: HASH2,
        blockParentHash: HASH,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts + 12,
      });
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [low.url, high.url]);
        expect(result.amount_out).toBe(1740000000);
        expect(result.block_number).toBe(n);
        expect(result.winning_venue).toBe("Uniswap V3 (fee 500)");
        expect(result.confidence).toBe(0.9);
        const receipt = result.receipt as Record<string, unknown>;
        expect(receipt.upstream_url).toBe(high.url);
      } finally {
        await low.close();
        await high.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "F1 (J2 P1b): min leg HANGS on eth_call, healthy higher leg serves -> 200 at the MIN pin N, fast (no ~4 s hung-loser tax: the loser is aborted on the win), upstream is the higher leg",
    async () => {
      const n = FRESH_BLOCK;
      const ts = nowSec();
      const low = await startStubRpc({
        blockNumber: n,
        blockHash: HASH,
        hangCalls: true,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
      });
      const high = await startStubRpc({
        blockNumber: n + 1,
        blockHash: HASH2,
        blockParentHash: HASH,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts + 12,
      });
      const startedAt = Date.now();
      try {
        const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, [low.url, high.url]);
        const elapsedMs = Date.now() - startedAt;
        // Bound is < 4000 ms, not < 2000 ms: the buggy behaviour pays
        // the hung loser's FULL 4000 ms per-RPC timeout (J2 measured
        // 4236 ms for this exact shape), so < 4000 ms excludes it by
        // construction, while the fix pays ~winner time + 50 ms
        // (~100–500 ms nominal) and the bound leaves ~3.5 s of headroom
        // for loaded-VM timer lag (a bare localhost stub call measured
        // 104–1048 ms during the verification runs; one suite run saw
        // 30 s of event-loop starvation). The logged wall below is the
        // actual evidence of "near the winner's time".
        expect(elapsedMs).toBeLessThan(4000);
        console.log(`F1 P1b wall: ${elapsedMs} ms`);
        expect(result.amount_out).toBe(1740000000);
        expect(result.block_number).toBe(n);
        expect(result.confidence).toBe(0.9);
        const receipt = result.receipt as Record<string, unknown>;
        expect(receipt.upstream_url).toBe(high.url);
      } finally {
        await low.close();
        await high.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "F1 mirror: two legs at N+1 FAIL on eth_call, healthy leg at N+2 (parentHash-bound) serves -> 200 at the MIN pin N+1, upstream is the higher leg. The winner is Uniswap V2 (1.73e9), not V3: each venue tries at most 2 RPCs (MAX_VENUE_RPCS) and V3's rotated pair is the two failing legs, so the healthy leg serves V2 — a pre-existing rotation property, not an F1 gap: the run still succeeds off a real quote from the agreeing higher leg.",
    async () => {
      const n = FRESH_BLOCK;
      const ts = nowSec();
      const mkLow = () =>
        startStubRpc({
          blockNumber: n + 1,
          blockHash: HASH2,
          blockParentHash: HASH,
          failCalls: true,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: ts + 12,
        });
      const a = await mkLow();
      const b = await mkLow();
      const high = await startStubRpc({
        blockNumber: n + 2,
        blockHash: HASH3,
        blockParentHash: HASH2,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts + 24,
      });
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [a.url, b.url, high.url],
        );
        expect(result.amount_out).toBe(1730000000);
        expect(result.winning_venue).toBe("Uniswap V2");
        expect(result.block_number).toBe(n + 1);
        expect(result.confidence).toBe(0.9);
        const receipt = result.receipt as Record<string, unknown>;
        expect(receipt.upstream_url).toBe(high.url);
      } finally {
        await a.close();
        await b.close();
        await high.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "F2 (J2 P3): pin is arrival-order independent — the same three legs (N slow-or-fast, two at N+1) pin the MIN (N) in BOTH arrival orders, at confidence 1.0. Without the straggler grace the slow-min-leg order pinned N+1.",
    async () => {
      const n = FRESH_BLOCK;
      const ts = nowSec();
      const mkLow = (blockDelayMs?: number) =>
        startStubRpc({
          blockNumber: n,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: ts,
          blockDelayMs,
        });
      const mkHigh = (blockDelayMs?: number) =>
        startStubRpc({
          blockNumber: n + 1,
          blockHash: HASH2,
          blockParentHash: HASH,
          failCalls: false,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: ts + 12,
          blockDelayMs,
        });
      // Order 1 (J2's P3 repro): the LOW leg is 600 ms slow, the two HIGH
      // legs are fast — the quorum short-circuits on the high pair.
      const low1 = await mkLow(600);
      const high1a = await mkHigh();
      const high1b = await mkHigh();
      let pinOrder1: unknown;
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [low1.url, high1a.url, high1b.url],
        );
        pinOrder1 = result.block_number;
        expect(result.block_number).toBe(n);
        expect(result.confidence).toBe(1.0);
      } finally {
        await low1.close();
        await high1a.close();
        await high1b.close();
      }
      // Order 2: the LOW leg is fast, one HIGH leg is 600 ms slow — the
      // quorum short-circuits on the low + fast-high pair instead.
      const low2 = await mkLow();
      const high2a = await mkHigh(600);
      const high2b = await mkHigh();
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [low2.url, high2a.url, high2b.url],
        );
        expect(result.block_number).toBe(n);
        expect(result.confidence).toBe(1.0);
        expect(result.block_number).toBe(pinOrder1);
      } finally {
        await low2.close();
        await high2a.close();
        await high2b.close();
      }
    },
    { timeout: 30000 },
  );

  it(
    "F3 (J2 P5b/P5c): one fast winner + one hung loser -> wall near the winner's time in BOTH orders (hung first AND hung second), upstream is the fast RPC. The hung loser's socket is aborted on the win — the wall is ~winner time + 50 ms, not winner + 4 s. The bound is < 4000 ms (see the F1 P1b comment): the buggy behaviour pays the hung loser's full 4000 ms timeout (J2 measured 4097/4188 ms), so < 4000 ms excludes it by construction while leaving headroom for loaded-VM timer lag; the logged walls are the actual evidence of 'near the winner's time'.",
    async () => {
      const blockNumber = FRESH_BLOCK;
      const blockHash = HASH;
      // One shared timestamp for both stubs (see the deadline test's
      // comment — two fresh nowSec() calls can straddle a wall second
      // and flake the quorum).
      const ts = nowSec();
      const mkHung = () =>
        startStubRpc({
          blockNumber,
          blockHash,
          failCalls: false,
          hangCalls: true,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: ts,
        });
      const mkFast = () =>
        startStubRpc({
          blockNumber,
          blockHash,
          failCalls: false,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: ts,
        });
      for (const order of ["hung-first", "fast-first"] as const) {
        const hung = await mkHung();
        const fast = await mkFast();
        const startedAt = Date.now();
        try {
          const urls = order === "hung-first" ? [hung.url, fast.url] : [fast.url, hung.url];
          const result = await handleRouteWithRpcs({ pair: "ETH/USDC" }, urls);
          const elapsedMs = Date.now() - startedAt;
          console.log(`F3 ${order} wall: ${elapsedMs} ms`);
          expect(elapsedMs).toBeLessThan(4000);
          expect(result.amount_out).toBe(1740000000);
          expect(result.confidence).toBe(0.9);
          const receipt = result.receipt as Record<string, unknown>;
          expect(receipt.upstream_url).toBe(fast.url);
        } finally {
          await hung.close();
          await fast.close();
        }
      }
    },
    { timeout: 30000 },
  );

  it(
    "F4 (J2 P4): deadline exceeded -> 502 ROUTE_DEADLINE AND no receipt row is persisted for that request, even after the in-flight work would have finished. The deadline aborts the inner handler; the receipt must never be saved after the request failed.",
    async () => {
      const mk = () =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: nowSec(),
          blockDelayMs: 500,
          callDelayMs: 500,
        });
      const a = await mk();
      const b = await mk();
      try {
        const before = (await countRouteReceipts());
        const startedAt = Date.now();
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url], 100),
        ).rejects.toMatchObject({ status: 502, code: "ROUTE_DEADLINE" });
        expect(Date.now() - startedAt).toBeLessThan(1000);
        // Wait out the full time the un-aborted inner handler would have
        // needed (500 ms quorum + 500 ms quotes + persist): any phantom
        // receipt would have landed by now. Then the count must be
        // unchanged — the aborted work persisted nothing.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        expect((await countRouteReceipts())).toBe(before);
      } finally {
        await a.close();
        await b.close();
      }
    },
    { timeout: 15000 },
  );

  it(
    "F5 slow-but-legal: 3 s quorum + 3 s quotes -> 200 with the receipt persisted, wall inside the 8 s deadline. The venue calls use the remaining budget (deadline − elapsed − 50 ms reserve), so the slow path still fits with room to persist.",
    async () => {
      const ts = nowSec();
      const mk = () =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: ts,
          blockDelayMs: 3000,
          callDelayMs: 3000,
        });
      const a = await mk();
      const b = await mk();
      const c = await mk();
      const startedAt = Date.now();
      try {
        const result = await handleRouteWithRpcs(
          { pair: "ETH/USDC" },
          [a.url, b.url, c.url],
        );
        const elapsedMs = Date.now() - startedAt;
        console.log(`F5 slow-legal wall: ${elapsedMs} ms`);
        expect(elapsedMs).toBeLessThan(8000);
        expect(result.amount_out).toBe(1740000000);
        expect(result.confidence).toBe(1.0);
        const receipt = result.receipt as Record<string, unknown>;
        expect(typeof receipt.receipt_id).toBe("string");
        const row = await storedReceiptRow(receipt.receipt_id as string);
        expect(row?.receipt_id).toBe(receipt.receipt_id);
      } finally {
        await a.close();
        await b.close();
        await c.close();
      }
    },
    { timeout: 30000 },
  );

  it(
    "F5 over-budget: 1 s quorum + 3.5 s quotes cannot fit quorum + quotes + persist inside an injected 4 s deadline -> fails closed with a 502 and NO receipt row. The venue timeout is the remaining budget (4000 − 1000 − 50 = 2950 ms < 3500 ms — pinned purely by the venueCallTimeoutMsForDeadline test above), so the calls time out cleanly instead of racing the deadline and persisting a phantom receipt. WHICH 502 fires is load-dependent and deliberately NOT pinned here: the venue timeout fires exactly ROUTE_PERSIST_RESERVE_MS (50 ms) before the deadline by construction, and loaded-VM timer lag (observed ~800 ms) swamps that gap — under moderate load it is ALL_QUOTERS_FAILED (observed at 4013 ms in run 3), under heavy load the quorum itself slips past the deadline and it is ROUTE_DEADLINE (observed at 4783 ms in run 4). The load-independent invariants are: a 502 (never a slow 200), no receipt row, wall bounded. (The 8 s production shape is the same arithmetic with a 3.9 s quorum; the injected 4 s deadline makes it deterministic — a 3.9 s stub delay races the 4.0 s quorum timeout under load.) The wall bound is deadline + 1000 ms, not the deadline itself: on a loaded VM the timers that enforce the budget can fire ~500 ms late in wall time (observed 4211 ms for a 3750 ms nominal wall), so the wall pin allows load lag.",
    async () => {
      const ts = nowSec();
      const mk = () =>
        startStubRpc({
          blockNumber: FRESH_BLOCK,
          blockHash: HASH,
          failCalls: false,
          v3AmountOut: 1740000000n,
          v2AmountOut: 1730000000n,
          blockTimestampSec: ts,
          blockDelayMs: 1000,
          callDelayMs: 3500,
        });
      const a = await mk();
      const b = await mk();
      const c = await mk();
      try {
        const before = (await countRouteReceipts());
        const startedAt = Date.now();
        let code: string | undefined;
        try {
          await handleRouteWithRpcs({ pair: "ETH/USDC" }, [a.url, b.url, c.url], 4000);
          expect.unreachable("over-budget run must fail closed, never 200");
        } catch (err) {
          expect(err).toBeInstanceOf(ApiError);
          expect((err as ApiError).status).toBe(502);
          code = (err as ApiError).code;
        }
        // Either fail-closed code: the venue timeout (ALL_QUOTERS_FAILED)
        // when the timers fire on time, the deadline (ROUTE_DEADLINE)
        // when load slips the quorum past it. Both are 502, neither
        // persists a receipt.
        expect(["ALL_QUOTERS_FAILED", "ROUTE_DEADLINE"]).toContain(code);
        const elapsedMs = Date.now() - startedAt;
        console.log(`F5 over-budget wall: ${elapsedMs} ms (code ${code})`);
        expect(elapsedMs).toBeLessThan(5000);
        expect((await countRouteReceipts())).toBe(before);
      } finally {
        await a.close();
        await b.close();
        await c.close();
      }
    },
    { timeout: 30000 },
  );

  it(
    "F6 integration (J2 P10 shape): Δ=1 with an implausible timestamp — higher block at N+1, parentHash-bound, but timestamp EARLIER than the lower block's -> the legs do NOT agree, no quorum forms, 502 QUORUM_UNREACHABLE (never a 200 at conf 0.9 off the absurd leg)",
    async () => {
      const n = FRESH_BLOCK;
      const ts = nowSec();
      const low = await startStubRpc({
        blockNumber: n,
        blockHash: HASH,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts,
      });
      const high = await startStubRpc({
        blockNumber: n + 1,
        blockHash: HASH2,
        blockParentHash: HASH,
        failCalls: false,
        v3AmountOut: 1740000000n,
        v2AmountOut: 1730000000n,
        blockTimestampSec: ts - 12,
      });
      try {
        await expect(
          handleRouteWithRpcs({ pair: "ETH/USDC" }, [low.url, high.url]),
        ).rejects.toMatchObject({ status: 502, code: "QUORUM_UNREACHABLE" });
      } finally {
        await low.close();
        await high.close();
      }
    },
    { timeout: 15000 },
  );
});
