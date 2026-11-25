// Tests for src/handlers/tokenHolders.ts (TOKEN_HOLDER_COUNT_GENERAL).
//
// Stubbed tests drive the fetch seam; LIVE tests hit the real keyless
// Blockscout indexers. Hermetic DB via a unique scratch SQLITE_PATH.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
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
  holderUpstreamForQuery,
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
  return JSON.stringify({ holders_count: String(holders), symbol, decimals: "6", address_hash: USDC_ETH, type: "ERC-20" });
}

afterEach(() => {
  setTokenHoldersFetchForTests(null);
  vi.useRealTimers();
});

describe("validation", () => {
  it("400 when token or chain missing", async () => {
    await expectApiError(handleTokenHolders({}), 400, "MISSING_PARAM");
    await expectApiError(handleTokenHolders({ token: "USDC" }), 400, "MISSING_PARAM");
    await expectApiError(handleTokenHolders({ chain: "ethereum" }), 400, "MISSING_PARAM");
  });

  it("422 for a chain with no keyless indexer of record", async () => {
    await expectApiError(
      handleTokenHolders({ token: "USDC", chain: "avalanche" }),
      422,
      "UNSUPPORTED_CHAIN",
    );
    await expectApiError(
      handleTokenHolders({ token: USDC_ETH, chain: "sepolia" }),
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

describe("stubbed indexer", () => {
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
    setTokenHoldersFetchForTests(async () => JSON.stringify({ ...JSON.parse(indexerBody(671778, "USDC")), address_hash: USDC_OP }));
    const out = await handleTokenHolders({ token: `${USDC_OP} on optimism` });
    expect(out.chain).toBe("optimism");
    expect(out.holders_count).toBe(671778);
  });

  it("422 when the indexer symbol contradicts the requested symbol", async () => {
    setTokenHoldersFetchForTests(async () => indexerBody(100, "USDT"));
    await expectApiError(
      handleTokenHolders({ token: "USDC", chain: "ethereum" }),
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

describe.skip("LIVE keyless indexers, manual opt-in only", () => {
  it("ethereum USDC holder count is real and large", async () => {
    const out = await handleTokenHolders({ token: "USDC", chain: "ethereum" });
    expect(out.holders_count).toBeGreaterThan(1_000_000);
    expect(out.token_symbol).toBe("USDC");
    expect(out.verdict).toBe("verified");
  }, 30000);

  it("optimism USDC holder count is real", async () => {
    const out = await handleTokenHolders({ token: "USDC", chain: "optimism" });
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


describe("GeckoTerminal holder coverage", () => {
  const cases = [ ["bsc", "USDT", "bsc-usdt"], ["bsc", "USDC", "bsc-usdc"],
    ["polygon", "USDC", "polygon_pos-usdc"], ["base", "USDC", "base-usdc"], ["arbitrum", "USDC", "arbitrum-usdc"] ];
  for (const [chain, token, fixture] of cases) {
    it(`${token} on ${chain} uses recorded per-chain token-info evidence`, async () => {
      const raw = readFileSync(join(__dirname, "fixtures/holder-gecko", fixture + ".json"), "utf8");
      const a = JSON.parse(raw).data.attributes;
      vi.useFakeTimers(); vi.setSystemTime(new Date(Date.parse(a.holders.last_updated) + 1000));
      let called = "";
      setTokenHoldersFetchForTests(async (url) => { called = url; return raw; });
      const r = await handleTokenHolders({ chain, token });
      expect(r.holders_count).toBe(a.holders.count);
      expect(r.token_symbol).toBe(token);
      expect(r.as_of).toBe(a.holders.last_updated);
      expect(called).toContain("api.geckoterminal.com/api/v2/networks/");
      expect(String(r.answer)).toContain("GeckoTerminal");
      const evidence = await getReceiptEvidence((r.receipt as { receipt_id: string }).receipt_id);
      expect(evidence.evidence!.toString()).toBe(raw);
    });
  }
  it("rejects wrong-chain, wrong-address, null, fractional and out-of-range counts", async () => {
    const original = JSON.parse(readFileSync(join(__dirname, "fixtures/holder-gecko/base-usdc.json"), "utf8"));
    for (const mutation of [
      (d: any) => { d.data.id = d.data.id.replace("base_", "bsc_"); },
      (d: any) => { d.data.attributes.address = USDC_ETH; },
      (d: any) => { d.data.type = "pool"; },
      (d: any) => { d.data.attributes.holders.count = -1; },
      (d: any) => { d.data.attributes.holders.last_updated = "2099-01-01T00:00:00Z"; },
      (d: any) => { d.data.attributes.symbol = ""; },
      (d: any) => { d.data.attributes.holders.count = null; },
      (d: any) => { d.data.attributes.holders.count = 1.5; },
      (d: any) => { d.data.attributes.holders.count = 10000000001; },
      (d: any) => { d.data.attributes.holders.last_updated = "2000-01-01T00:00:00Z"; },
    ]) {
      vi.useFakeTimers(); vi.setSystemTime(new Date(Date.parse(original.data.attributes.holders.last_updated) + 1000));
      const body = structuredClone(original); mutation(body);
      setTokenHoldersFetchForTests(async () => JSON.stringify(body));
      await expectApiError(handleTokenHolders({ chain: "base", token: "USDC" }), 502, "INDEXER_UNREACHABLE");
    }
  });
});


it("deduplicated Gecko requests each persist the original body with provider as_of", async () => {
 const raw=readFileSync(join(__dirname,"fixtures/holder-gecko/base-usdc.json"),"utf8");
 const updated=JSON.parse(raw).data.attributes.holders.last_updated;
 vi.useFakeTimers();vi.setSystemTime(new Date(Date.parse(updated)+1000));
 let count=0;setTokenHoldersFetchForTests(async()=>{count++;return raw;});
 const results=await Promise.all(Array.from({length:4},()=>handleTokenHolders({token:"USDC",chain:"base"})));
 expect(count).toBe(1);
 const firstFetched=(results[0].receipt as {fetched_at:string}).fetched_at;
 await vi.advanceTimersByTimeAsync(1000);
 const cached=await handleTokenHolders({token:"USDC",chain:"base"});
 expect((cached.receipt as {fetched_at:string}).fetched_at).toBe(firstFetched);
 const ids=new Set<string>();
 for(const r of results){
  expect(r.as_of).toBe(updated);
  const id=(r.receipt as {receipt_id:string}).receipt_id;ids.add(id);
  expect((await getReceiptEvidence(id)).evidence!.toString()).toBe(raw);
 }
 expect(ids.size).toBe(4);
});


it("bounds a hung source by the reduced HTTP budget instead of waiting beyond 8s", async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-23T13:00:00Z"));
 let release!:(s:string)=>void;
 setTokenHoldersFetchForTests(async()=>new Promise<string>(r=>{release=r;}));
 const checked=expect(handleTokenHolders({token:"USDC",chain:"base"})).rejects.toMatchObject({status:502,code:"INDEXER_UNREACHABLE"});
 await vi.advanceTimersByTimeAsync(4001);await checked;
 release("{}");await vi.advanceTimersByTimeAsync(0);
});


it("stale 429 answer quotes source time and marks the receipt without changing raw evidence",async()=>{
 const raw=readFileSync(join(__dirname,"fixtures/holder-gecko/base-usdc.json"),"utf8");
 const updated=JSON.parse(raw).data.attributes.holders.last_updated;
 vi.useFakeTimers();vi.setSystemTime(new Date(Date.parse(updated)+1000));
 let limited=false;setTokenHoldersFetchForTests(async()=>{if(limited)throw Object.assign(new Error("429"),{status:429});return raw;});
 const first=await handleTokenHolders({chain:"base",token:"USDC"});
 await vi.advanceTimersByTimeAsync(900001);limited=true;
 const r=await handleTokenHolders({chain:"base",token:"USDC"});
 expect(r.verdict).toBe("stale");expect(r.stale).toBe(true);expect(String(r.answer)).toContain(updated);expect(String(r.answer)).toContain("upstream unavailable");
 const receipt=r.receipt as {receipt_id:string;fetched_at:string;quorum_votes:string};
 expect(receipt.fetched_at).toBe((first.receipt as {fetched_at:string}).fetched_at);
 expect(receipt.quorum_votes).toContain("STALE DISCLOSED");
 expect((await getReceiptEvidence(receipt.receipt_id)).evidence!.toString()).toBe(raw);
});
it("attributes named and packed Gecko chains separately from Blockscout",()=>{
 expect(holderUpstreamForQuery({chain:"polygon"})).toBe("geckoterminal");
 expect(holderUpstreamForQuery({token:"USDC on bsc"})).toBe("geckoterminal");
 expect(holderUpstreamForQuery({chain:"ethereum"})).toBe("blockscout");
});
