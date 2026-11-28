// T3 registry additions (ethereum) + fixed-label symbol_bucket.
// The registry test re-verifies every address with REAL decimals()/symbol()
// eth_calls at finalized over the project's evmRpc client (2-of-N agreement).
// No mocks. Skips with a clear message only when fewer than 2 RPC legs answer.

import { describe, expect, it } from "vitest";
import { CHAIN_RPCS } from "../src/config/chains";
import { rpcCall } from "../src/core/evmRpc";
import { sanitizeAnswerClass } from "../src/core/answerClass";
import { SYMBOL_VOCAB, symbolBucket } from "../src/core/symbolVocab";
import { TOKEN_CONTRACTS, tokenContractFor, canonicalHomeChain, SELECTOR_DECIMALS, SELECTOR_SYMBOL } from "../src/handlers/tokenContracts";
import { handleTokenSupply, supplyInputClass } from "../src/handlers/tokenSupply";
import { ApiError } from "../src/core/errors";

const INTENT = "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL";
const NEW: Record<string, { addr: string; sym: string }> = {
  SUSHI: { addr: "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2", sym: "SUSHI" },
  "1INCH": { addr: "0x111111111117dC0aa78b770fA6A738034120C302", sym: "1INCH" },
  YFI: { addr: "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e", sym: "YFI" },
  BAL: { addr: "0xba100000625a3754423978a60c9317c58a424e3D", sym: "BAL" },
  CVX: { addr: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", sym: "CVX" },
  GNO: { addr: "0x6810e776880C02933D47DB1b9fc05908e5386b96", sym: "GNO" },
  DYDX: { addr: "0x92D6C1e31e14520e676a687F0a93788B716BEff5", sym: "DYDX" },
  TUSD: { addr: "0x0000000000085d4780B73119b644AE5ecd22b376", sym: "TUSD" },
  USDE: { addr: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", sym: "USDe" },
  POL: { addr: "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6", sym: "POL" },
  PAXG: { addr: "0x45804880De22913dAFE09f4980848ECE6EcbAf78", sym: "PAXG" },
  RENDER: { addr: "0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24", sym: "RNDR" },
  IMX: { addr: "0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF", sym: "IMX" },
  FET: { addr: "0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85", sym: "FET" },
  LRC: { addr: "0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD", sym: "LRC" },
  AXS: { addr: "0xBB0E17EF65F82Ab018d8EDd776e8DD940327B28b", sym: "AXS" },
  ENA: { addr: "0x57e114B691Db790C35207b2e685D4A43181e6061", sym: "ENA" },
  CHZ: { addr: "0x3506424F91fD33084466F402d5D97f05F8e3b4AF", sym: "CHZ" },
};

function abiString(result: unknown): string {
  const hex = String(result).slice(2);
  const len = parseInt(hex.slice(64, 128), 16);
  return Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8");
}

async function quorumCall(contract: string, data: string): Promise<unknown | null> {
  const seen: string[] = [];
  for (const url of CHAIN_RPCS.ethereum) {
    try {
      const { result } = await rpcCall(url, "eth_call", [{ to: contract, data }, "finalized"]);
      if (typeof result === "string") seen.push(result);
    } catch { /* leg unreachable */ }
  }
  for (const r of seen) if (seen.filter((x) => x === r).length >= 2) return r;
  return null;
}

describe("T3 registry (ethereum)", () => {
  it("resolves every new symbol case-insensitively, with and without a chain; existing entries unchanged", () => {
    for (const [sym, { addr }] of Object.entries(NEW)) {
      // USDE and ENA come from the issuer-published list (USDE stored lowercase); same address.
      const same = (x: string | undefined) => expect(x?.toLowerCase()).toBe(addr.toLowerCase());
      same(TOKEN_CONTRACTS.ethereum[sym]);
      same(tokenContractFor("ethereum", sym));
      same(tokenContractFor("ethereum", sym.toLowerCase()));
      same(canonicalHomeChain(sym.toLowerCase())?.contract);
      expect(canonicalHomeChain(sym.toLowerCase())?.chain).toBe("ethereum");
    }
    expect(tokenContractFor("ethereum", "RNDR")).toBe(NEW.RENDER.addr);
    expect(tokenContractFor("ethereum", "rndr")).toBe(NEW.RENDER.addr);
    expect(canonicalHomeChain("RNDR")).toEqual({ chain: "ethereum", contract: NEW.RENDER.addr });
    expect(tokenContractFor("ethereum", "WBTC")).toBe("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");
    expect(tokenContractFor("ethereum", "UNI")).toBe("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984");
    expect(tokenContractFor("ethereum", "MKR")).toBeUndefined();
    expect(tokenContractFor("ethereum", "ZZZQ")).toBeUndefined();
  });

  it("unknown ZZZQ still gives the same 400 MISSING_PARAM refusal", async () => {
    try { await handleTokenSupply({ token: "ZZZQ" }); throw new Error("expected refusal"); }
    catch (e) { expect(e).toBeInstanceOf(ApiError); expect((e as ApiError).status).toBe(400); expect((e as ApiError).code).toBe("MISSING_PARAM"); }
  });

  it("LIVE: each address has decimals 18 and the expected on-chain symbol at finalized", async () => {
    const probe = await quorumCall(NEW.SUSHI.addr, SELECTOR_DECIMALS);
    if (probe === null) { console.warn("SKIP: fewer than 2 ethereum RPC legs reachable; live registry check not run"); return; }
    for (const [sym, { addr, sym: onchain }] of Object.entries(NEW)) {
      const dec = await quorumCall(addr, SELECTOR_DECIMALS);
      const symRes = await quorumCall(addr, SELECTOR_SYMBOL);
      expect(dec, `${sym} decimals quorum`).not.toBeNull();
      expect(Number(BigInt(dec as string)), `${sym} decimals`).toBe(18);
      expect(symRes, `${sym} symbol quorum`).not.toBeNull();
      expect(abiString(symRes), `${sym} symbol`).toBe(onchain);
    }
  }, 180000);
});

describe("symbol_bucket", () => {
  it("vocab has 184 members and each maps to itself (case-insensitive)", () => {
    expect(SYMBOL_VOCAB.size).toBe(184);
    for (const s of SYMBOL_VOCAB) { expect(symbolBucket(s)).toBe(s); expect(symbolBucket(s.toLowerCase())).toBe(s); }
  });
  it("non-vocab values reduce to fixed classes and are never echoed", () => {
    expect(symbolBucket("ZZZQ")).toBe("other:4-6:alpha");
    expect(symbolBucket("ab")).toBe("other:1-3:alpha");
    expect(symbolBucket("ABCDEFGH")).toBe("other:7-12:alpha");
    expect(symbolBucket("A1B2C3")).toBe("other:4-6:alnum");
    expect(symbolBucket("9LIVES")).toBe("other:4-6:digit_lead");
    const addr = "0x" + "ab".repeat(20);
    expect(symbolBucket(addr)).toBe("other:>12:other");
    expect(symbolBucket("0x1")).toBe("other:1-3:other");
    const sentence = "what is the total supply of PRIVATEXYZ";
    expect(symbolBucket(sentence)).toBe("other:>12:other");
    for (const raw of [addr, sentence, "PRIVATE_X"]) expect(symbolBucket(raw).toLowerCase()).not.toContain("private");
  });
  it("supplyInputClass carries symbol_bucket; existing fields unchanged; empty omits it", () => {
    expect(supplyInputClass("ZZZQ", undefined)).toEqual({ token_shape: "symbol", has_chain: false, in_registry: false, symbol_bucket: "other:4-6:alpha" });
    expect(supplyInputClass("sushi", undefined)).toEqual({ token_shape: "symbol", has_chain: false, in_registry: true, symbol_bucket: "SUSHI" });
    expect(supplyInputClass("rndr", "ethereum")).toEqual({ token_shape: "symbol", has_chain: true, in_registry: true, symbol_bucket: "RNDR" });
    expect(supplyInputClass(undefined, undefined)).toEqual({ token_shape: "empty", has_chain: false, in_registry: false });
  });
  it("answerClass accepts only vocab members or the fixed pattern", () => {
    const base = { token_shape: "symbol", has_chain: false, in_registry: false };
    expect(sanitizeAnswerClass(INTENT, { ...base, symbol_bucket: "WBTC" })).toEqual({ ...base, symbol_bucket: "WBTC" });
    expect(sanitizeAnswerClass(INTENT, { ...base, symbol_bucket: "other:4-6:alpha" })).toEqual({ ...base, symbol_bucket: "other:4-6:alpha" });
    for (const bad of ["ZZZQ", "wbtc", "other:4-6:ALPHA", "other:9:alpha", "other:4-6:alpha ", "0x" + "ab".repeat(20), "PRIVATE", 5, null]) {
      expect(sanitizeAnswerClass(INTENT, { ...base, symbol_bucket: bad })).toEqual(base);
    }
    expect(sanitizeAnswerClass("ONCHAIN_TX_LOOKUP_GENERAL", { symbol_bucket: "WBTC" })).toBeUndefined();
  });
});
