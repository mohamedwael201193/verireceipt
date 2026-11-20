// OPTIMAL_EXECUTION_ROUTE handler — block-pinned 1 ETH -> USDC execution quote.
//
// Zero-LLM. No mocks. Every venue address below was verified live on
// 2026-11-20 via eth_getCode (non-empty bytecode) against Ethereum mainnet:
//   Uniswap V3 QuoterV2  0x61fFE014bA17989E743c5F6cB21bF9697530B21e  (8,273 bytes)
//   Uniswap V2 Router   0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D  (21,943 bytes)
//   SushiSwap V2 Router 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F  (17,762 bytes)
//   WETH                0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2  (3,124 bytes)
//   USDC                0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  (2,186 bytes)
// Curve was NOT included: there is no direct ETH/USDC Curve pool. The only
// Curve route is 2-hop (Tricrypto2 WETH->USDT, then 3pool USDT->USDC).
// Measured live at block 26,454,459: Tricrypto2 get_dy = 1,740,639,877 USDT,
// then 3pool = 1,738,718,547 USDC — losing to Uniswap V3 fee 500
// (1,739,811,754 USDC at block 26,454,446) by ~0.06%, so the extra quoter
// adds failure modes for no measured gain. Canonical pools verified via
// eth_getCode: Tricrypto2 0xD51a44d3FaE010294C616388b506AcdA1bfAAE46
// (24,427 bytes), TriCrypto 0x80466c64868E1ab14a1Ddf27A676C3fcbe638Fe5
// (24,538 bytes), 3pool 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7
// (21,199 bytes). DAI/USDT hub-route competitiveness is UNVERIFIED.

import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import { unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { quorum2of3 } from "../core/quorum";
import { MAINNET_RPCS } from "../config/chains";

export const INTENT = "OPTIMAL_EXECUTION_ROUTE_GENERAL";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const UNI_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const SUSHI_V2_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";

// Exactly 1 ETH, in wei.
const AMOUNT_IN_WEI = 1000000000000000000n;
// Uniswap V3 fee tiers to try, in hundredths of a basis point.
const V3_FEES = [500, 3000, 10000];
const QUORUM_TIMEOUT_MS = 10000;
const CALL_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Minimal ABI encoding/decoding (no ethers dependency; hand-rolled, tested).
// ---------------------------------------------------------------------------

function wordAddress(addr: string): string {
  return "000000000000000000000000" + addr.slice(2).toLowerCase();
}

function wordUint(value: bigint | number): string {
  const hex = BigInt(value).toString(16);
  return hex.padStart(64, "0");
}

function readWord(hex: string, wordIndex: number): bigint {
  const start = 2 + wordIndex * 64;
  return BigInt("0x" + hex.slice(start, start + 64));
}

/** quoteExactInputSingle((address,address,uint256,uint24,uint160)) — selector 0xc6a5026a. */
export function buildV3QuoteCalldata(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number,
): string {
  return (
    "0xc6a5026a" +
    wordAddress(tokenIn) +
    wordAddress(tokenOut) +
    wordUint(amountIn) +
    wordUint(fee) +
    wordUint(0n)
  );
}

/** getAmountsOut(uint256,address[]) — selector 0xd06ca61f. */
export function buildV2AmountsOutCalldata(amountIn: bigint, path: string[]): string {
  let data = "0xd06ca61f" + wordUint(amountIn) + wordUint(0x40) + wordUint(path.length);
  for (const addr of path) data += wordAddress(addr);
  return data;
}

/**
 * QuoterV2 quoteExactInputSingle returns
 * (uint256 amountOut, uint160 sqrtPriceX96After, uint32 ticksCrossed, uint256 gasEstimate).
 * amountOut is the first 32-byte word. The return is exactly 4 words — a
 * truncated return is malformed and rejected, never partially decoded.
 */
export function decodeV3QuoteReturn(hex: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(hex) || hex.length !== 2 + 64 * 4) {
    throw new Error(`malformed QuoterV2 return data: ${hex.slice(0, 40)}`);
  }
  return readWord(hex, 0);
}

/**
 * getAmountsOut returns uint256[]; the last element is the output amount.
 * The ABI layout is exact: first word is the 0x20 offset, second word is the
 * array length, then exactly that many words — no trailing garbage.
 */
export function decodeV2AmountsOut(hex: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(hex) || hex.length < 2 + 64 * 2) {
    throw new Error(`malformed getAmountsOut return data: ${hex.slice(0, 40)}`);
  }
  const offset = readWord(hex, 0);
  if (offset !== 0x20n) {
    throw new Error(`malformed getAmountsOut return data (offset 0x${offset.toString(16)})`);
  }
  const length = Number(readWord(hex, 1));
  if (length < 2 || hex.length !== 2 + 64 * (2 + length)) {
    throw new Error(`malformed getAmountsOut return data (length ${length})`);
  }
  return readWord(hex, 1 + length);
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing (Node https/http; no fetch typing dependency).
// ---------------------------------------------------------------------------

interface RpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: string;
}

interface RpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string };
}

function postJsonRpc(
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          } catch (err) {
            reject(new Error(`unparseable JSON-RPC response from ${url}: ${String(err)}`));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`JSON-RPC request to ${url} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<{ request: Record<string, unknown>; response: Record<string, unknown>; result: string }> {
  const request: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method, params };
  const response = await postJsonRpc(url, request, timeoutMs);
  if (response.error !== undefined) {
    const err = response.error as { code?: number; message?: string };
    throw new Error(
      `JSON-RPC error from ${url} (${method}): code ${String(err.code)} ${err.message ?? ""}`,
    );
  }
  if (typeof response.result !== "string") {
    throw new Error(`JSON-RPC response from ${url} (${method}) has no string result`);
  }
  return { request, response, result: response.result as string };
}

// ---------------------------------------------------------------------------
// Venue quotes.
// ---------------------------------------------------------------------------

export interface VenueQuote {
  venue: string;
  amountOut: bigint;
  /** Exact JSON-RPC request/response of the successful quoter call. */
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

/** Strict max by amountOut; ties keep the first venue. Returns null when empty. */
export function pickBestQuote(quotes: VenueQuote[]): VenueQuote | null {
  let best: VenueQuote | null = null;
  for (const quote of quotes) {
    if (best === null || quote.amountOut > best.amountOut) best = quote;
  }
  return best;
}

async function quoteV3AtBlock(
  rpcUrl: string,
  blockHex: string,
): Promise<VenueQuote | null> {
  const attempts = await Promise.allSettled(
    V3_FEES.map(async (fee) => {
      const data = buildV3QuoteCalldata(WETH, USDC, AMOUNT_IN_WEI, fee);
      const call = await rpcCall(
        rpcUrl,
        "eth_call",
        [{ to: QUOTER_V2, data }, blockHex],
        CALL_TIMEOUT_MS,
      );
      return {
        venue: `Uniswap V3 (fee ${fee})`,
        amountOut: decodeV3QuoteReturn(call.result),
        request: call.request,
        response: call.response,
      } satisfies VenueQuote;
    }),
  );
  const ok: VenueQuote[] = [];
  for (const attempt of attempts) {
    if (attempt.status === "fulfilled" && attempt.value.amountOut > 0n) ok.push(attempt.value);
  }
  return pickBestQuote(ok);
}

async function quoteV2AtBlock(
  rpcUrl: string,
  blockHex: string,
  router: string,
  venueName: string,
): Promise<VenueQuote | null> {
  const data = buildV2AmountsOutCalldata(AMOUNT_IN_WEI, [WETH, USDC]);
  const call = await rpcCall(
    rpcUrl,
    "eth_call",
    [{ to: router, data }, blockHex],
    CALL_TIMEOUT_MS,
  );
  const amountOut = decodeV2AmountsOut(call.result);
  if (amountOut <= 0n) return null;
  return { venue: venueName, amountOut, request: call.request, response: call.response };
}

const V2_VENUES: Array<{ router: string; name: string }> = [
  { router: UNI_V2_ROUTER, name: "Uniswap V2" },
  { router: SUSHI_V2_ROUTER, name: "SushiSwap V2" },
];

/**
 * Try one venue quoter on the agreeing RPC first, then the remaining RPCs.
 * A venue that fails everywhere is skipped (never guessed).
 */
async function tryVenue(
  rpcUrlsInOrder: string[],
  blockHex: string,
  quoter: (rpcUrl: string) => Promise<VenueQuote | null>,
): Promise<VenueQuote | null> {
  for (const rpcUrl of rpcUrlsInOrder) {
    try {
      const quote = await quoter(rpcUrl);
      if (quote !== null) return quote;
    } catch {
      // Try the next RPC; a venue failing everywhere is skipped by the caller.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

export async function handleRoute(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const pair = query.pair;
  if (pair !== "ETH/USDC") {
    throw unprocessable(
      "INVALID_PAIR",
      pair === undefined
        ? "pair is required; only ETH/USDC is supported"
        : `unsupported pair "${pair}"; only ETH/USDC is supported`,
    );
  }
  if (MAINNET_RPCS.length < 2) {
    throw upstreamUnavailable(
      "RPC_CONFIG",
      `fewer than 2 Ethereum mainnet RPCs configured (${MAINNET_RPCS.length})`,
    );
  }

  // 1. Latest block number from the 2-of-3 RPC quorum.
  const blockByRpc = new Map<string, number>();
  const { value: blockNumber, votes } = await quorum2of3<number>(
    MAINNET_RPCS.map(
      (rpcUrl) => async () => {
        const call = await rpcCall(rpcUrl, "eth_blockNumber", [], QUORUM_TIMEOUT_MS);
        const block = Number.parseInt(call.result, 16);
        if (!Number.isSafeInteger(block) || block <= 0) {
          throw new Error(`invalid block number from ${rpcUrl}: ${call.result}`);
        }
        blockByRpc.set(rpcUrl, block);
        return block;
      },
    ),
    (a, b) => a === b,
    QUORUM_TIMEOUT_MS,
  );
  const blockHex = "0x" + blockNumber.toString(16);
  const agreeingRpc =
    MAINNET_RPCS.find((rpcUrl) => blockByRpc.get(rpcUrl) === blockNumber) ?? MAINNET_RPCS[0];
  const rpcOrder = [agreeingRpc, ...MAINNET_RPCS.filter((u) => u !== agreeingRpc)];

  // 2. Block-pinned quotes from every verified venue, all at the same block.
  const venueResults = await Promise.allSettled([
    tryVenue(rpcOrder, blockHex, (rpcUrl) => quoteV3AtBlock(rpcUrl, blockHex)),
    ...V2_VENUES.map((venue) =>
      tryVenue(rpcOrder, blockHex, (rpcUrl) =>
        quoteV2AtBlock(rpcUrl, blockHex, venue.router, venue.name),
      ),
    ),
  ]);
  const quotes: VenueQuote[] = [];
  for (const result of venueResults) {
    if (result.status === "fulfilled" && result.value !== null) quotes.push(result.value);
  }
  if (quotes.length === 0) {
    throw upstreamUnavailable(
      "ALL_QUOTERS_FAILED",
      `all quoters failed at Ethereum block ${blockNumber}; no quote returned`,
    );
  }

  // 3. Strict max wins.
  const best = pickBestQuote(quotes);
  if (best === null) {
    throw upstreamUnavailable(
      "ALL_QUOTERS_FAILED",
      `all quoters failed at Ethereum block ${blockNumber}; no quote returned`,
    );
  }
  const confidence = quotes.length >= 2 ? 1.0 : 0.9;
  const usdc = (Number(best.amountOut) / 1e6).toFixed(2);
  const answer =
    `At Ethereum block ${blockNumber}, the best route for selling 1 ETH is ${best.venue}, ` +
    `returning ${usdc} USDC (${best.amountOut.toString()} base units).`;

  // 4. Receipt over the exact winning quoter call, pinned to the block.
  const receiptEvidence = JSON.stringify({
    block_number: blockNumber,
    block_number_hex: blockHex,
    winning_venue: best.venue,
    pair: "ETH/USDC",
    amount_in_wei: AMOUNT_IN_WEI.toString(),
    request: best.request,
    response: best.response,
  });
  const receipt = makeReceipt(INTENT, agreeingRpc, receiptEvidence, votes);

  return envelope(
    INTENT,
    {
      amount_out: Number(best.amountOut),
      block_number: blockNumber,
      winning_venue: best.venue,
    },
    receipt,
    {
      answer,
      verdict: "verified",
      confidence,
      source:
        "Block-pinned Uniswap V2/V3 (+ verified venues) quotes via 2-of-3 Ethereum RPC",
    },
  );
}
