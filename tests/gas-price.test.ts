// Tests for src/handlers/gasPrice.ts (GAS_PRICE_GENERAL).
//
// Stubbed tests drive global fetch (the handler's rpcCall uses it) so
// agreement, split-vote and outage paths are deterministic. The LIVE
// tests at the bottom call the real handler against the real keyless
// public RPCs from src/config/chains.ts — no mocks anywhere in handler
// code.
//
// Hermetic DB: SQLITE_PATH points at a unique scratch dir per run
// (mkdtemp under <repo>/../tmp, never /tmp and never ./data).

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "gas-price-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import { sha256Hex } from "../src/core/receipt";
import { getReceiptEvidence } from "../src/core/storage";
import { CHAIN_RPCS } from "../src/config/chains";
import { handleGasPrice, INTENT } from "../src/handlers/gasPrice";

const SHA256_RE = /^[0-9a-f]{64}$/;

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

/** Build the exact raw JSON-RPC response text rpcCall would receive. */
function gasResponse(weiHex: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: weiHex });
}

interface StubOutcome {
  kind: "ok" | "http" | "throw" | "badjson" | "rpcerror" | "spot";
  /** For kind "ok": the eth_gasPrice result hex. For "badjson"/"rpcerror": raw text. */
  value?: string;
}

/**
 * Install a fetch stub mapping each CHAIN_RPCS[chain] URL to an outcome,
 * or to an array of outcomes consumed one per call (re-poll rounds).
 * Returns the number of fetch calls made.
 */
// G4: what the Coinbase gas-token spot leg serves. "ok" serves a fixed
// 3000 USD; "http" a 503; "throw" a network error; "badjson" unparseable.
let spotOutcome: StubOutcome = { kind: "spot", value: "3000" };

function stubGasFetch(chain: string, table: Record<string, StubOutcome | StubOutcome[]>): () => number {
  const queues = new Map<string, StubOutcome[]>();
  for (const [url, entry] of Object.entries(table)) {
    queues.set(url, Array.isArray(entry) ? [...entry] : [entry]);
  }
  let calls = 0;
  const fetchStub = async (url: unknown) => {
    calls++;
    if (String(url).includes("api.coinbase.com")) {
      const o = spotOutcome;
      if (o.kind === "throw") throw new Error("socket hangup");
      if (o.kind === "http") return { ok: false, status: 503, text: async () => "unavailable" } as Response;
      if (o.kind === "badjson") return { ok: true, status: 200, text: async () => "not json" } as Response;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { base: "ETH", currency: "USD", amount: o.value ?? "3000" } }),
      } as Response;
    }
    const queue = queues.get(String(url));
    const outcome = queue && queue.length > 0 ? (queue.length > 1 ? queue.shift()! : queue[0]) : undefined;
    if (!outcome) throw new Error(`unexpected fetch to ${String(url)}`);
    switch (outcome.kind) {
      case "throw":
        throw new Error("socket hangup");
      case "http":
        return { ok: false, status: 503, text: async () => "unavailable" } as Response;
      case "badjson":
        return { ok: true, status: 200, text: async () => outcome.value ?? "not json" } as Response;
      case "rpcerror":
        return {
          ok: true,
          status: 200,
          text: async () =>
            outcome.value ??
            JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }),
        } as Response;
      case "ok":
        return { ok: true, status: 200, text: async () => gasResponse(outcome.value ?? "0x1") } as Response;
    }
  };
  vi.stubGlobal("fetch", fetchStub);
  return () => calls;
}

afterEach(() => {
  spotOutcome = { kind: "spot", value: "3000" };
  vi.unstubAllGlobals();
});

const ETH = CHAIN_RPCS.ethereum; // 3 legs

describe("handleGasPrice validation (stubbed fetch, no network)", () => {
  it("G1: a missing chain defaults to ethereum with disclosure", async () => {
    for (const query of [{}, { chain: "" }, { chain: "   " }]) {
      stubGasFetch("ethereum", {
        [ETH[0]]: { kind: "ok", value: "0x3b9aca00" },
        [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
        [ETH[2]]: { kind: "ok", value: "0x3b9aca00" },
      });
      const res = (await handleGasPrice(query)) as Record<string, unknown>;
      expect(res.chain).toBe("ethereum");
      expect(res.gas_price_gwei).toBe(1);
      expect(res.verdict).toBe("verified");
      expect(String(res.answer)).toContain("no chain given; defaulted to ethereum");
      vi.unstubAllGlobals();
    }
  });

  it("an explicit chain answers without the default disclosure", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[2]]: { kind: "ok", value: "0x3b9aca00" },
    });
    const res = (await handleGasPrice({ chain: "ethereum" })) as Record<string, unknown>;
    expect(res.chain).toBe("ethereum");
    expect(String(res.answer)).not.toContain("defaulted");
  });

  it("rejects an unsupported chain with 400 UNSUPPORTED_CHAIN", async () => {
    await expectApiError(handleGasPrice({ chain: "solana" }), 400, "UNSUPPORTED_CHAIN");
  });

  it("never calls an upstream for a validation failure", async () => {
    const calls = stubGasFetch("ethereum", {});
    await expectApiError(handleGasPrice({ chain: "solana" }), 400, "UNSUPPORTED_CHAIN");
    expect(calls()).toBe(0);
  });
});

describe("handleGasPrice quorum (stubbed fetch)", () => {
  it("answers with the value two legs agree on (2-of-3)", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x3b9aca00" }, // 1 gwei
      [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[2]]: { kind: "ok", value: "0x77359400" }, // 2 gwei — dissenting third leg
    });
    const res = await handleGasPrice({ chain: "ethereum" });
    expect(res.chain).toBe("ethereum");
    expect(res.gas_price_gwei).toBe(1);
    expect(typeof res.as_of).toBe("string");
    expect(res.verdict).toBe("verified");
    expect(res.confidence).toBe(0.9);
    const rc = res.receipt as { raw_response_sha256: string; quorum_votes: string; receipt_id: string };
    expect(rc.quorum_votes).toBe("2/3 sources agreed");
    expect(rc.raw_response_sha256).toBe(sha256Hex(gasResponse("0x3b9aca00")));
    const ev = await getReceiptEvidence(rc.receipt_id);
    expect(ev.found).toBe(true);
    expect(sha256Hex(ev.evidence!)).toBe(rc.raw_response_sha256);
  });

  it("reports full confidence when every leg agrees (3-of-3)", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x1dcd6500" }, // 0.5 gwei
      [ETH[1]]: { kind: "ok", value: "0x1dcd6500" },
      [ETH[2]]: { kind: "ok", value: "0x1dcd6500" },
    });
    const res = await handleGasPrice({ chain: "ethereum" });
    expect(res.gas_price_gwei).toBe(0.5);
    expect(res.confidence).toBe(1.0);
    expect((res.receipt as { quorum_votes: string }).quorum_votes).toBe("3/3 sources agreed");
  });

  it("treats 0x3B9ACA00 and 0x3b9aca00 from different legs as the same value", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x3B9ACA00" },
      [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[2]]: { kind: "throw" },
    });
    const res = await handleGasPrice({ chain: "ethereum" });
    expect(res.gas_price_gwei).toBe(1); // 1 gwei
  });

  it("G3: an agreeing zero pair fails closed (0 gwei is implausible)", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x0" },
      [ETH[1]]: { kind: "ok", value: "0x0" },
      [ETH[2]]: { kind: "throw" },
    });
    await expectApiError(handleGasPrice({ chain: "ethereum" }), 502, "IMPLAUSIBLE_ZERO");
  });

  it("502 QUORUM_UNREACHABLE when every leg fails", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "throw" },
      [ETH[1]]: { kind: "http" },
      [ETH[2]]: { kind: "rpcerror" },
    });
    await expectApiError(handleGasPrice({ chain: "ethereum" }), 502, "QUORUM_UNREACHABLE");
  });

  it("502 QUORUM_UNREACHABLE when only one leg answers", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[1]]: { kind: "throw" },
      [ETH[2]]: { kind: "throw" },
    });
    await expectApiError(handleGasPrice({ chain: "ethereum" }), 502, "QUORUM_UNREACHABLE");
  });

  it("re-polls a split round once and answers when the re-poll agrees", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: [{ kind: "ok", value: "0x3b9aca00" }, { kind: "ok", value: "0x77359400" }],
      [ETH[1]]: [{ kind: "ok", value: "0x77359400" }, { kind: "ok", value: "0x77359400" }],
      [ETH[2]]: { kind: "throw" },
    });
    const res = await handleGasPrice({ chain: "ethereum" });
    expect(res.gas_price_gwei).toBe(2); // 0x77359400 = 2 gwei
  }, 15000);

  it("502 QUORUM_DISAGREEMENT when the re-poll stays split", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[1]]: { kind: "ok", value: "0x77359400" },
      [ETH[2]]: { kind: "throw" },
    });
    await expectApiError(handleGasPrice({ chain: "ethereum" }), 502, "QUORUM_DISAGREEMENT");
  }, 15000);

  it("drops a decimal-string result as a malformed leg, never parses it as wei", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "1000000000" }, // decimal, not 0x-hex
      [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[2]]: { kind: "ok", value: "0x3b9aca00" },
    });
    const res = await handleGasPrice({ chain: "ethereum" });
    expect(res.gas_price_gwei).toBe(1);
    expect((res.receipt as { quorum_votes: string }).quorum_votes).toBe("2/3 sources agreed");
  });

  it("drops an absurd value above the contract range as a malformed leg", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x" + (200000n * 1000000000n).toString(16) }, // 200k gwei
      [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[2]]: { kind: "ok", value: "0x3b9aca00" },
    });
    const res = await handleGasPrice({ chain: "ethereum" });
    expect(res.gas_price_gwei).toBe(1);
  });

  it("502 QUORUM_DISAGREEMENT on a 2-of-2 chain whose two legs disagree", async () => {
    const POLYGON = CHAIN_RPCS.polygon; // 2 legs
    stubGasFetch("polygon", {
      [POLYGON[0]]: { kind: "ok", value: "0x3b9aca00" },
      [POLYGON[1]]: { kind: "ok", value: "0x77359400" },
    });
    await expectApiError(handleGasPrice({ chain: "polygon" }), 502, "QUORUM_DISAGREEMENT");
  }, 15000);

  it("resolves the chain alias 'eth' to ethereum", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[2]]: { kind: "ok", value: "0x3b9aca00" },
    });
    const res = await handleGasPrice({ chain: "ETH" });
    expect(res.chain).toBe("ethereum");
  });
});

describe("G3: implausible zero fails closed on every chain (stubbed fetch)", () => {
  it("an all-zero testnet quorum fails closed too (a zero fee level is degenerate even where 0x0 is the true state)", async () => {
    stubGasFetch("sepolia", Object.fromEntries(
      CHAIN_RPCS["sepolia"].map((url: string) => [url, { kind: "ok", value: "0x0" } as StubOutcome]),
    ));
    await expectApiError(handleGasPrice({ chain: "sepolia" }), 502, "IMPLAUSIBLE_ZERO");
  });

  it("a dust agreement that rounds to 0 gwei fails closed too (live sepolia shape: 19 wei)", async () => {
    stubGasFetch("sepolia", Object.fromEntries(
      CHAIN_RPCS["sepolia"].map((url: string) => [url, { kind: "ok", value: "0x13" } as StubOutcome]),
    ));
    await expectApiError(handleGasPrice({ chain: "sepolia" }), 502, "IMPLAUSIBLE_ZERO");
  });

  it("a non-zero agreement still serves", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[2]]: { kind: "throw" },
    });
    const res = (await handleGasPrice({ chain: "ethereum" })) as Record<string, unknown>;
    expect(res.gas_price_gwei).toBe(1);
    expect(res.verdict).toBe("verified");
  });
});

describe("G2: avalanche quorum (stubbed fetch)", () => {
  const AVAX = CHAIN_RPCS.avalanche; // 3 legs, verified live 2026-11-23
  it("serves avalanche from its own keyless quorum", async () => {
    stubGasFetch("avalanche", {
      [AVAX[0]]: { kind: "ok", value: "0x1bf08eb96" },
      [AVAX[1]]: { kind: "ok", value: "0x1bf08eb96" },
      [AVAX[2]]: { kind: "throw" },
    });
    const res = (await handleGasPrice({ chain: "avax" })) as Record<string, unknown>;
    expect(res.chain).toBe("avalanche");
    expect(res.gas_price_gwei).toBe(7.5);
    expect(res.verdict).toBe("verified");
  });
});

describe("BSC quorum (stubbed fetch)", () => {
  const BSC = CHAIN_RPCS.bsc; // 3 legs, verified live 2026-11-23 (0.05 gwei agreeing)
  it("serves bsc from its own keyless quorum, gas priced in BNB", async () => {
    stubGasFetch("bsc", {
      [BSC[0]]: { kind: "ok", value: "0x2faf080" },
      [BSC[1]]: { kind: "ok", value: "0x2faf080" },
      [BSC[2]]: { kind: "throw" },
    });
    const res = (await handleGasPrice({ chain: "BNB Smart Chain" })) as Record<string, unknown>;
    expect(res.chain).toBe("bsc");
    expect(res.gas_price_gwei).toBe(0.05);
    expect(res.verdict).toBe("verified");
    expect(String(res.answer)).toContain("BNB");
  });
});

describe("handleGasPrice LIVE (real public RPCs, no stub)", () => {
  it("answers the published Arbitrum One name from real RPC quorum", async () => {
    const out = await handleGasPrice({ chain: "Arbitrum One" });
    expect(out.chain).toBe("arbitrum");
    expect(out.gas_price_gwei as number).toBeGreaterThan(0);
    const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string };
    const evidence = await getReceiptEvidence(receipt.receipt_id);
    expect(sha256Hex(evidence.evidence!)).toBe(receipt.raw_response_sha256);
  }, 60000);

  const LIVE_TIMEOUT_MS = 60000;

  it(
    "answers ethereum gas price from the live 2-of-3 quorum with a verifiable receipt",
    async () => {
      const res = await handleGasPrice({ chain: "ethereum" });
      expect(res.chain).toBe("ethereum");
      const gwei = res.gas_price_gwei as number;
      expect(typeof gwei).toBe("number");
      expect(gwei).toBeGreaterThan(0);
      expect(gwei).toBeLessThanOrEqual(100000); // contract range
      expect(res.verdict).toBe("verified");
      expect(typeof res.as_of).toBe("string");
      const rc = res.receipt as {
        receipt_id: string;
        intent: string;
        upstream_url: string;
        raw_response_sha256: string;
        quorum_votes: string;
        audit_url: string;
      };
      expect(rc.intent).toBe(INTENT);
      expect(rc.raw_response_sha256).toMatch(SHA256_RE);
      expect(CHAIN_RPCS.ethereum).toContain(rc.upstream_url);
      const ev = await getReceiptEvidence(rc.receipt_id);
      expect(ev.found).toBe(true);
      expect(sha256Hex(ev.evidence!)).toBe(rc.raw_response_sha256);
      // The stored evidence is a real eth_gasPrice JSON-RPC response.
      const parsed = JSON.parse(ev.evidence!.toString("utf8")) as { result: string };
      expect(parsed.result).toMatch(/^0x[0-9a-fA-F]+$/);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "answers base gas price from the live 2-of-3 quorum",
    async () => {
      const res = await handleGasPrice({ chain: "base" });
      expect(res.chain).toBe("base");
      expect(res.gas_price_gwei as number).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("G4 transfer_fee_usd (stubbed fetch)", () => {
  it("serves transfer_fee_usd computed from the live spot, formula disclosed", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x3b9aca00" }, // 1 gwei
      [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[2]]: { kind: "ok", value: "0x3b9aca00" },
    });
    spotOutcome = { kind: "spot", value: "3000" };
    const res = await handleGasPrice({ chain: "ethereum" });
    // 1 gwei * 21000 gas * $3000 / 1e9 = $0.063
    expect(res.transfer_fee_usd).toBe(0.063);
    expect(String(res.answer)).toContain("$0.063");
    expect(String(res.answer)).toContain("1 gwei x 21000 gas x ETH $3000 (Coinbase spot) / 1e9");
    const rc = res.receipt as { gas_token_spot?: { source: string; token_usd: number; formula: string } };
    expect(rc.gas_token_spot?.token_usd).toBe(3000);
    expect(rc.gas_token_spot?.formula).toContain("transfer_fee_usd = 1 gwei x 21000 gas");
    expect(rc.gas_token_spot?.source).toContain("Coinbase");
  });

  it("refuses the whole answer when the spot is unreachable", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[2]]: { kind: "ok", value: "0x3b9aca00" },
    });
    spotOutcome = { kind: "throw" };
    await expectApiError(handleGasPrice({ chain: "ethereum" }), 502, "SPOT_UNAVAILABLE");
  });

  it("refuses when the spot body is not JSON", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[2]]: { kind: "ok", value: "0x3b9aca00" },
    });
    spotOutcome = { kind: "badjson" };
    await expectApiError(handleGasPrice({ chain: "ethereum" }), 502, "SPOT_UNAVAILABLE");
  });

  it("refuses an implausible computed transfer_fee_usd", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x174876e800" }, // 100 gwei
      [ETH[1]]: { kind: "ok", value: "0x174876e800" },
      [ETH[2]]: { kind: "ok", value: "0x174876e800" },
    });
    spotOutcome = { kind: "spot", value: "5000000" }; // $5M ETH => $10500 transfer
    await expectApiError(handleGasPrice({ chain: "ethereum" }), 502, "IMPLAUSIBLE_VALUE");
  });

  it("refuses when the spot serves an HTTP error", async () => {
    stubGasFetch("ethereum", {
      [ETH[0]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[1]]: { kind: "ok", value: "0x3b9aca00" },
      [ETH[2]]: { kind: "ok", value: "0x3b9aca00" },
    });
    spotOutcome = { kind: "http" };
    await expectApiError(handleGasPrice({ chain: "ethereum" }), 502, "SPOT_UNAVAILABLE");
  });

  it("uses the AVAX spot on avalanche", async () => {
    const AVAX = CHAIN_RPCS["avalanche"];
    stubGasFetch("avalanche", {
      [AVAX[0]]: { kind: "ok", value: "0x5d21dba00" }, // 25 gwei
      [AVAX[1]]: { kind: "ok", value: "0x5d21dba00" },
      [AVAX[2]]: { kind: "ok", value: "0x5d21dba00" },
    });
    spotOutcome = { kind: "spot", value: "40" };
    const res = await handleGasPrice({ chain: "avalanche" });
    // 25 gwei * 21000 * $40 / 1e9 = $0.021
    expect(res.transfer_fee_usd).toBe(0.021);
    expect(String(res.answer)).toContain("AVAX $40");
  });
});
