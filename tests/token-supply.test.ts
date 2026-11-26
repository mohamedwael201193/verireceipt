// Tests for src/handlers/tokenSupply.ts (TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL).
//
// Stubbed tests drive global fetch; LIVE tests hit the real keyless
// RPCs. Hermetic DB via a unique scratch SQLITE_PATH per run.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
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

function stubSupplyFetch(table: Record<string, Behavior>, seenContracts?: string[]): void {
  const fetchStub = async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if(u.includes("api.coingecko.com")) return new Response(readFileSync(join(__dirname,"fixtures/token-aggregate/usdc.json"),"utf8"));
    const behavior = table[u];
    if (!behavior) throw new Error(`unexpected fetch to ${u}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
    const call = body.params[0] as { data: string; to: string };
    seenContracts?.push(call.to);
    const data = call.data;
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

it.each([[123456789012345678901234567890123456789n,18],[1n,6],[0n,0]])('preserves the exact chain base integer and decimals %s',async(supply,decimals)=>{
 stubSupplyFetch(Object.fromEntries(ETH.map(url=>[url,supplyBehavior(supply,decimals,'USDC')])));
 const out=await handleTokenSupply({token:'USDC',chain:'ethereum'});
 expect(out.supply_base_units).toBe(supply.toString());expect(out.decimals).toBe(decimals);
 const evidence=await getReceiptEvidence((out.receipt as any).receipt_id);expect(JSON.parse(evidence.evidence!)).toMatchObject({supply_base_units:supply.toString(),decimals});
});

describe("display-label input validation", () => {
  it.each([{token:'USDC'}, {token:'USDC on ethereum'}, {token:USDC_ETH,chain:'ethereum'}])('chain total has no aggregate-provider dependency: %j', async query=>{
    const capture=JSON.parse(readFileSync(join(__dirname,'fixtures/token-chain-supply/usdc-finalized.json'),'utf8'));
    const seen:string[]=[];
    vi.stubGlobal('fetch',async(url:unknown,init?:{body?:unknown})=>{
      const u=String(url);seen.push(u);
      const leg=capture.legs.find((l:any)=>l.url===u)??(ETH.includes(u)?capture.legs[0]:null);
      if(!leg)throw new Error('aggregate provider unavailable');
      const request=JSON.parse(String(init?.body));
      const response=leg.responses.find((r:any)=>r.request.params[0].data===request.params[0].data);
      return new Response(response.raw);
    });
    const out=await handleTokenSupply(query);
    const raw=BigInt(JSON.parse(capture.legs[0].responses[0].raw).result);
    const decimals=Number(BigInt(JSON.parse(capture.legs[0].responses[1].raw).result));
    const digits=raw.toString().padStart(decimals+1,'0');
    expect(out.supply_base_units).toBe(digits);expect(out.decimals).toBe(decimals);
    expect(out.total_supply).toBe(Number(digits.slice(0,-decimals)+'.'+digits.slice(-decimals)));
    expect(out.chain).toBe('ethereum');
    expect(String(out.total_supply_scope)).toContain('chain-specific');
    expect(seen.every(url=>ETH.includes(url))).toBe(true);
    expect(String(out.answer)).toContain('total supply on ethereum');
    const evidence=await getReceiptEvidence((out.receipt as any).receipt_id);
    const full=JSON.parse(evidence.evidence!);
    expect(full.supply_base_units_hex).toBe('0x'+raw.toString(16));
    expect(full.asset_total).toBeUndefined();
    if(query.token==='USDC'){
      expect(String(out.answer)).toContain('canonical home chain ethereum');
      expect(full.chain_resolution.resolved_chain).toBe('ethereum');
    }else expect(full.chain_resolution).toBe('not used (chain given)');
    expect(sha256Hex(evidence.evidence!)).toBe((out.receipt as any).raw_response_sha256);
  });

  it("a single-chain listed symbol resolves to its only chain (ARB on arbitrum)", async () => {
    const ARB_RPCS = CHAIN_RPCS.arbitrum;
    stubSupplyFetch(Object.fromEntries(ARB_RPCS.map((url) => [url, supplyBehavior(10000000000n * 10n ** 18n, 18, "ARB")])));
    const out = await handleTokenSupply({ token: "ARB" });
    expect(out.chain).toBe("arbitrum");
    expect(String(out.answer)).toContain("canonical home chain arbitrum");
  });

  it("a chainless UNLISTED symbol refuses; raw address discloses incomplete discovery", async () => {
    await expectApiError(handleTokenSupply({ token: "NOSUCHTOKEN" }), 400, "MISSING_PARAM");
    vi.stubGlobal('fetch',async()=>new Response('',{status:503}));
    const out=await handleTokenSupply({token:USDC_ETH});
    expect(out).toMatchObject({total_supply:null,chain:null,matched_chains:[],verdict:'no_data'});
  });

  it("an explicit chain is unchanged and carries no home-chain disclosure", async () => {
    stubSupplyFetch(Object.fromEntries(ETH.map((url) => [url, supplyBehavior(1000n, 6, "USDC")])));
    const out = await handleTokenSupply({ token: "USDC on ethereum" });
    expect(String(out.answer)).not.toContain("canonical home chain");
    const receipt = out.receipt as { receipt_id: string };
    const evidence = await getReceiptEvidence(receipt.receipt_id);
    const parsed = JSON.parse(evidence.evidence!) as { chain_resolution: string };
    expect(parsed.chain_resolution).toBe("not used (chain given)");
  });

  it.each([
    `USDC (${TOKEN_CONTRACTS.ethereum.DAI}) on ethereum`,
    `ETH (${TOKEN_CONTRACTS.ethereum.WETH}) on ethereum`,
  ])("rejects contradictory label and address: %s", async (token) => {
    await expectApiError(handleTokenSupply({ token }), 400, "TOKEN_CONTRACT_MISMATCH");
  });

  it.each([
    `USDC (${USDC_ETH.slice(0, -1)})`,
    `USDC (${USDC_ETH}) (${USDC_ETH})`,
    `USDC (${USDC_ETH}) trailing`,
  ])("rejects malformed or multiple display addresses: %s", async (token) => {
    await expectApiError(handleTokenSupply({ token, chain: "ethereum" }), 422, "UNSUPPORTED_TOKEN");
  });

  it("still rejects a contradictory chain before reading the explicit address", async () => {
    await expectApiError(handleTokenSupply({ token: `USDC (${USDC_ETH}) on base`, chain: "ethereum" }), 400, "CHAIN_MISMATCH");
  });
});

describe("T2 expanded registry", () => {
  it("lists the 21 newly verified ethereum symbols", () => {
    const added = ["STETH","WSTETH","RETH","AAVE","CRV","LDO","COMP","SNX","GRT","ENS","APE","SAND","MANA","FRAX","BAT","ZRX","BNB","CRO","USDP","PYUSD","ONDO"];
    for (const sym of added) expect(TOKEN_CONTRACTS.ethereum[sym], sym).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(TOKEN_CONTRACTS.ethereum.MKR).toBeUndefined(); // bytes32 symbol: honestly excluded
  });

  it("answers a newly listed 6-decimal symbol (PYUSD) through the quorum", async () => {
    stubSupplyFetch(Object.fromEntries(ETH.map((url) => [url, supplyBehavior(500000123456n, 6, "PYUSD")])));
    const out = await handleTokenSupply({ token: "PYUSD on ethereum" });
    expect(out.total_supply).toBe(500000.123456);
    expect(out.token_symbol).toBe("PYUSD");
  });

  it("a newly listed symbol keeps its on-chain symbol case in the evidence (stETH)", async () => {
    stubSupplyFetch(Object.fromEntries(ETH.map((url) => [url, supplyBehavior(9000000n * 10n ** 18n, 18, "stETH")])));
    const out = await handleTokenSupply({ token: "STETH on ethereum" });
    expect(out.total_supply).toBe(9000000);
    const receipt = out.receipt as { receipt_id: string };
    const evidence = await getReceiptEvidence(receipt.receipt_id);
    const parsed = JSON.parse(evidence.evidence!) as { token_symbol_onchain: string };
    expect(parsed.token_symbol_onchain).toBe("stETH");
  });
});

describe("handleTokenSupply quorum (stubbed fetch)", () => {
  it.each([
    { token: `USDC (${USDC_ETH}) on Ethereum` },
    { token: `USDC (${USDC_ETH})`, chain: "ethereum" },
    { token: `USD Coin ( ${USDC_ETH} ) on ethereum` },
  ])("accepts the complete display token shape: %j", async (query) => {
    const seen: string[] = [];
    stubSupplyFetch(Object.fromEntries(ETH.map((url) => [url, supplyBehavior(41000000123456n, 6, "USDC")])), seen);
    const out = await handleTokenSupply(query);
    expect(out.total_supply).toBe(41000000.123456);
    expect(out.token_symbol).toBe("USDC");
    expect(out.chain).toBe("ethereum");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((address) => address === USDC_ETH)).toBe(true);
    const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string };
    const evidence = await getReceiptEvidence(receipt.receipt_id);
    expect(sha256Hex(evidence.evidence!)).toBe(receipt.raw_response_sha256);
  });

  it("uses an explicit address rather than guessing from an unrecognized label", async () => {
    const address = TOKEN_CONTRACTS.ethereum.DAI;
    const seen: string[] = [];
    stubSupplyFetch(Object.fromEntries(ETH.map((url) => [url, supplyBehavior(123000000n, 6, "DAI")])), seen);
    const out = await handleTokenSupply({ token: `Dai Stablecoin (${address}) on ethereum` });
    expect(out.token_symbol).toBe("DAI");
    expect(seen.every((to) => to === address)).toBe(true);
  });

  it("answers USDC supply from an agreeing 3-of-3 with decimals applied", async () => {
    const supply = 41000000123456n; // 41,000,000.123456 USDC at 6 decimals
    stubSupplyFetch({
      [ETH[0]]: supplyBehavior(supply, 6, "USDC"),
      [ETH[1]]: supplyBehavior(supply, 6, "USDC"),
      [ETH[2]]: supplyBehavior(supply, 6, "USDC"),
    });
    const res = await handleTokenSupply({ token: "USDC on ethereum" });
    expect(res.total_supply).toBe(41000000.123456);
    expect(res.supply_base_units).toBe("41000000123456");expect(res.decimals).toBe(6);
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
      const res = await handleTokenSupply({ token: `USDC (${USDC_ETH}) on ethereum` });
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
