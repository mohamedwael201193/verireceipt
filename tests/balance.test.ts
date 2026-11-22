// Tests for src/handlers/walletBalance.ts (WALLET_BALANCE_CHECK_GENERAL).
//
// Stubbed tests drive global fetch (RPC + ENS resolvers); the LIVE tests
// at the bottom hit the real keyless RPCs and ENS APIs — no mocks in
// handler code. Hermetic DB via a unique scratch SQLITE_PATH per run.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "balance-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import { sha256Hex } from "../src/core/receipt";
import { getReceiptEvidence } from "../src/core/storage";
import { CHAIN_RPCS } from "../src/config/chains";
import { handleBalance, INTENT } from "../src/handlers/walletBalance";
import { TOKEN_CONTRACTS } from "../src/handlers/tokenContracts";

const SHA256_RE = /^[0-9a-f]{64}$/;
const VITALIK = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
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

/** ABI-encode a string return (offset, length, data). */
function abiString(s: string): string {
  const data = Buffer.from(s, "utf8").toString("hex");
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
  return (
    "0x" +
    "20".padStart(64, "0") +
    s.length.toString(16).padStart(64, "0") +
    padded
  );
}

function uint256Hex(v: bigint): string {
  return "0x" + v.toString(16).padStart(64, "0");
}

/** JSON-RPC response text for an eth_call / eth_getBalance result. */
function rpcResult(result: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result });
}

interface RpcBehavior {
  /** Per-method result values; "ERR" fails the call. */
  results: Record<string, string>;
}

/**
 * Stub fetch for the balance handler. rpcTable maps a CHAIN_RPCS url to
 * per-method results (method key is "eth_getBalance" or the eth_call
 * selector prefix). ensTable maps resolver url substrings to an address
 * or "ERR". Arrays give per-call sequences (re-poll rounds).
 */
function stubBalanceFetch(
  rpcTable: Record<string, RpcBehavior | RpcBehavior[]>,
  ensTable: Record<string, string | string[]> = {},
): void {
  const rpcQueues = new Map<string, RpcBehavior[]>();
  for (const [url, entry] of Object.entries(rpcTable)) {
    rpcQueues.set(url, Array.isArray(entry) ? [...entry] : [entry]);
  }
  const ensQueues = new Map<string, string[]>();
  for (const [url, entry] of Object.entries(ensTable)) {
    ensQueues.set(url, Array.isArray(entry) ? [...entry] : [entry]);
  }
  const fetchStub = async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    for (const [needle, queue] of ensQueues) {
      if (u.startsWith(needle)) {
        const outcome = queue.length > 1 ? queue.shift()! : queue[0];
        if (outcome === "ERR") throw new Error("resolver down");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ address: outcome }),
        } as Response;
      }
    }
    const queue = rpcQueues.get(u);
    if (!queue) throw new Error(`unexpected fetch to ${u}`);
    const behavior = queue.length > 1 ? queue.shift()! : queue[0];
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
    let key = body.method;
    if (body.method === "eth_call") {
      const data = (body.params[0] as { data: string }).data;
      key = data.slice(0, 10);
    }
    const result = behavior.results[key];
    if (result === undefined || result === "ERR") throw new Error("leg failure");
    return { ok: true, status: 200, text: async () => rpcResult(result) } as Response;
  };
  vi.stubGlobal("fetch", fetchStub);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ETH = CHAIN_RPCS.ethereum;
const ONE_ETH_WEI = 1000000000000000000n;

function nativeBehavior(wei: bigint): RpcBehavior {
  return { results: { eth_getBalance: "0x" + wei.toString(16) } };
}

function tokenBehavior(balance: bigint, decimals: number, symbol: string): RpcBehavior {
  return {
    results: {
      "0x70a08231": uint256Hex(balance),
      "0x313ce567": uint256Hex(BigInt(decimals)),
      "0x95d89b41": abiString(symbol),
    },
  };
}

describe("handleBalance validation (stubbed, no network use)", () => {
  it("rejects missing params with 400 MISSING_PARAM", async () => {
    await expectApiError(handleBalance({}), 400, "MISSING_PARAM");
  });

  it("rejects an unsupported chain with 400 UNSUPPORTED_CHAIN", async () => {
    await expectApiError(
      handleBalance({ address: VITALIK, chain: "solana" }),
      400,
      "UNSUPPORTED_CHAIN",
    );
  });

  it("rejects a malformed address with 400 INVALID_ADDRESS", async () => {
    await expectApiError(
      handleBalance({ address: "0x1234", chain: "ethereum" }),
      400,
      "INVALID_ADDRESS",
    );
  });

  it("rejects an unknown token symbol with 422 UNSUPPORTED_TOKEN", async () => {
    await expectApiError(
      handleBalance({ address: VITALIK, chain: "ethereum", token: "NOPECOIN" }),
      422,
      "UNSUPPORTED_TOKEN",
    );
  });
});

describe("handleBalance native coin (stubbed quorum)", () => {
  it("answers 1 ETH from an agreeing 2-of-3 with whole-unit conversion", async () => {
    stubBalanceFetch({
      [ETH[0]]: nativeBehavior(ONE_ETH_WEI),
      [ETH[1]]: nativeBehavior(ONE_ETH_WEI),
      [ETH[2]]: nativeBehavior(2n * ONE_ETH_WEI),
    });
    const res = await handleBalance({ address: VITALIK, chain: "ethereum" });
    expect(res.address).toBe(VITALIK);
    expect(res.chain).toBe("ethereum");
    expect(res.balance).toBe(1);
    expect(res.token_symbol).toBe("ETH");
    expect(res.verdict).toBe("verified");
    expect(res.confidence).toBe(0.9);
    const rc = res.receipt as { raw_response_sha256: string; quorum_votes: string; receipt_id: string };
    expect(rc.quorum_votes).toBe("2/3 sources agreed");
    const ev = await getReceiptEvidence(rc.receipt_id);
    expect(ev.found).toBe(true);
    expect(sha256Hex(ev.evidence!)).toBe(rc.raw_response_sha256);
  });

  it("treats token=ETH as the native coin", async () => {
    stubBalanceFetch({
      [ETH[0]]: nativeBehavior(ONE_ETH_WEI),
      [ETH[1]]: nativeBehavior(ONE_ETH_WEI),
      [ETH[2]]: nativeBehavior(ONE_ETH_WEI),
    });
    const res = await handleBalance({ address: VITALIK, chain: "ethereum", token: "ETH" });
    expect(res.balance).toBe(1);
    expect(res.confidence).toBe(1.0);
  });

  it("treats token=MATIC as native on polygon (symbol POL)", async () => {
    const POLYGON = CHAIN_RPCS.polygon;
    stubBalanceFetch({
      [POLYGON[0]]: nativeBehavior(ONE_ETH_WEI),
      [POLYGON[1]]: nativeBehavior(ONE_ETH_WEI),
    });
    const res = await handleBalance({ address: VITALIK, chain: "polygon", token: "MATIC" });
    expect(res.token_symbol).toBe("POL");
  });

  it("502 QUORUM_UNREACHABLE when every leg fails", async () => {
    stubBalanceFetch({
      [ETH[0]]: { results: {} },
      [ETH[1]]: { results: {} },
      [ETH[2]]: { results: {} },
    });
    await expectApiError(handleBalance({ address: VITALIK, chain: "ethereum" }), 502, "QUORUM_UNREACHABLE");
  });

  it("502 QUORUM_DISAGREEMENT on a persistent split", async () => {
    stubBalanceFetch({
      [ETH[0]]: nativeBehavior(ONE_ETH_WEI),
      [ETH[1]]: nativeBehavior(2n * ONE_ETH_WEI),
      [ETH[2]]: { results: {} },
    });
    await expectApiError(handleBalance({ address: VITALIK, chain: "ethereum" }), 502, "QUORUM_DISAGREEMENT");
  }, 15000);
});

describe("handleBalance ERC-20 (stubbed quorum)", () => {
  it("answers a USDC balance via the symbol map with 6-decimal conversion", async () => {
    stubBalanceFetch({
      [ETH[0]]: tokenBehavior(123456789n, 6, "USDC"),
      [ETH[1]]: tokenBehavior(123456789n, 6, "USDC"),
      [ETH[2]]: tokenBehavior(123456789n, 6, "USDC"),
    });
    const res = await handleBalance({ address: VITALIK, chain: "ethereum", token: "usdc" });
    expect(res.balance).toBe(123.456789);
    expect(res.token_symbol).toBe("USDC");
  });

  it("accepts a raw 0x contract address and uses the on-chain symbol", async () => {
    stubBalanceFetch({
      [ETH[0]]: tokenBehavior(100000000n, 8, "WBTC"),
      [ETH[1]]: tokenBehavior(100000000n, 8, "WBTC"),
      [ETH[2]]: { results: {} },
    });
    const res = await handleBalance({
      address: VITALIK,
      chain: "ethereum",
      token: TOKEN_CONTRACTS.ethereum.WBTC,
    });
    expect(res.balance).toBe(1); // 1 WBTC at 8 decimals
    expect(res.token_symbol).toBe("WBTC");
  });

  it("a leg with a different decimals value cannot join the quorum", async () => {
    stubBalanceFetch({
      [ETH[0]]: tokenBehavior(123456789n, 6, "USDC"),
      [ETH[1]]: tokenBehavior(123456789n, 18, "USDC"),
      [ETH[2]]: tokenBehavior(123456789n, 6, "USDC"),
    });
    const res = await handleBalance({ address: VITALIK, chain: "ethereum", token: "USDC" });
    expect(res.balance).toBe(123.456789);
    expect((res.receipt as { quorum_votes: string }).quorum_votes).toBe("2/3 sources agreed");
  });

  it("huge balances keep 6-decimal precision (SHIB-scale, BigInt path)", async () => {
    const huge = 123456789012345678901234567890n; // 18 decimals
    stubBalanceFetch({
      [ETH[0]]: tokenBehavior(huge, 18, "SHIB"),
      [ETH[1]]: tokenBehavior(huge, 18, "SHIB"),
      [ETH[2]]: tokenBehavior(huge, 18, "SHIB"),
    });
    const res = await handleBalance({ address: VITALIK, chain: "ethereum", token: "SHIB" });
    expect(res.balance).toBe(123456789012.345678);
  });
});

describe("handleBalance ENS (stubbed resolvers + quorum)", () => {
  it("resolves an ENS name through both resolvers and answers the balance", async () => {
    stubBalanceFetch(
      {
        [ETH[0]]: nativeBehavior(ONE_ETH_WEI),
        [ETH[1]]: nativeBehavior(ONE_ETH_WEI),
        [ETH[2]]: { results: {} },
      },
      {
        "https://api.ensideas.com/": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "https://api.ensdata.net/": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      },
    );
    const res = await handleBalance({ address: "vitalik.eth", chain: "ethereum" });
    expect(res.address).toBe(VITALIK);
    expect(res.balance).toBe(1);
  });

  it("502 ENS_CONFLICT when the resolvers disagree", async () => {
    stubBalanceFetch(
      {
        [ETH[0]]: nativeBehavior(ONE_ETH_WEI),
        [ETH[1]]: nativeBehavior(ONE_ETH_WEI),
        [ETH[2]]: { results: {} },
      },
      {
        "https://api.ensideas.com/": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "https://api.ensdata.net/": "0x0000000000000000000000000000000000000001",
      },
    );
    await expectApiError(handleBalance({ address: "vitalik.eth", chain: "ethereum" }), 502, "ENS_CONFLICT");
  });

  it("502 ENS_UNREACHABLE when both resolvers are down", async () => {
    stubBalanceFetch(
      {
        [ETH[0]]: nativeBehavior(ONE_ETH_WEI),
        [ETH[1]]: nativeBehavior(ONE_ETH_WEI),
        [ETH[2]]: { results: {} },
      },
      {
        "https://api.ensideas.com/": "ERR",
        "https://api.ensdata.net/": "ERR",
      },
    );
    await expectApiError(handleBalance({ address: "vitalik.eth", chain: "ethereum" }), 502, "ENS_UNREACHABLE");
  });
});

describe("handleBalance LIVE (real RPCs + ENS, no stub)", () => {
  const LIVE_TIMEOUT_MS = 90000;

  it(
    "answers vitalik's live ETH balance on ethereum with a verifiable receipt",
    async () => {
      const res = await handleBalance({ address: VITALIK, chain: "ethereum" });
      expect(res.chain).toBe("ethereum");
      expect(res.token_symbol).toBe("ETH");
      expect(res.balance as number).toBeGreaterThan(0);
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
    "answers vitalik's live USDC balance on ethereum (symbol map path)",
    async () => {
      const res = await handleBalance({ address: VITALIK, chain: "ethereum", token: "USDC" });
      expect(res.token_symbol).toBe("USDC");
      expect(res.balance as number).toBeGreaterThanOrEqual(0);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "resolves vitalik.eth live through both resolvers and answers",
    async () => {
      const res = await handleBalance({ address: "vitalik.eth", chain: "ethereum" });
      expect(res.address).toBe(VITALIK);
      expect(res.balance as number).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );
});
