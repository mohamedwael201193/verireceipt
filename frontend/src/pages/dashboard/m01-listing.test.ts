// Mission 01 "Token Listing-Risk Screen" preset.
// Three live checks (token holders, pool liquidity, token supply context).
// APPROVE only when all three verify AND holders >= the declared 100,000
// floor AND pool reserves >= the declared $5,000,000 floor. Total supply is
// context, never a gate. Anything unverified is HOLD; a verified floor
// failure is a NEEDS REVIEW HOLD (the rule outcome, not a failed check).

import { afterEach, describe, expect, it, vi } from "vitest";
import { getPoolLiquidity, getTokenHolders, getTokenSupply } from "../../lib/api";
import { DESK_PRESETS, type DeskCheckResult } from "./presets";
import { toLiveReceipt } from "./utils";

const HOLDERS_RECEIPT = {
  receipt_id: "rcpt_M01H000000000000000001",
  intent: "TOKEN_HOLDER_COUNT_GENERAL",
  upstream_url: "https://eth.blockscout.com/api/v2/tokens/0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  raw_response_sha256: "d".repeat(64),
  quorum_votes: "1/1 indexer of record",
  fetched_at: "2026-11-24T20:04:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M01H000000000000000001",
};

const LIQUIDITY_RECEIPT = {
  receipt_id: "rcpt_M01L000000000000000001",
  intent: "LIQUIDITY_DEPTH_VERIFY_GENERAL",
  upstream_url: "https://api.geckoterminal.com/api/v2/networks/eth/pools/0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801",
  raw_response_sha256: "e".repeat(64),
  quorum_votes: "1/1 primary source",
  fetched_at: "2026-11-24T20:04:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M01L000000000000000001",
};

const SUPPLY_RECEIPT = {
  receipt_id: "rcpt_M01S000000000000000001",
  intent: "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL",
  upstream_url: "https://eth.llamarpc.com",
  raw_response_sha256: "f".repeat(64),
  quorum_votes: "3/3 sources agreed",
  fetched_at: "2026-11-24T20:04:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M01S000000000000000001",
};

function preset(id: string) {
  const p = DESK_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p;
}

function verified(intent: string, url: string, body: Record<string, unknown>, rcpt: typeof HOLDERS_RECEIPT): DeskCheckResult {
  const full = { ...body, receipt: rcpt };
  const receipt = toLiveReceipt(intent, "q", url, { ok: true, body: full, receipt: rcpt, latencyMs: 5, ledgerGenAtStart: 0 });
  return { check: { label: "x", intent, query: "q", requestUrl: url, run: async () => { throw new Error("unused"); } }, receipt };
}

function refused(intent: string, url: string): DeskCheckResult {
  const receipt = toLiveReceipt(intent, "q", url, {
    ok: false,
    body: { error: "x", message: "refused" },
    latencyMs: 5,
    status: 503,
    errorCode: "UPSTREAM_UNAVAILABLE",
    errorMessage: "refused",
  });
  return { check: { label: "x", intent, query: "q", requestUrl: url, run: async () => { throw new Error("unused"); } }, receipt };
}

// Live shapes checked 2026-11-24 20:04-20:14 UTC (unbilled probes).
const HOLDERS_BODY = {
  token: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  chain: "ethereum",
  holders_count: 432070,
  token_symbol: "UNI",
  as_of: "2026-11-24T20:04:00.000Z",
  stale: false,
  verdict: "verified",
};

const LIQUIDITY_BODY = {
  pool: "0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801",
  chain: "ethereum",
  liquidity_usd: 10496122.08,
  verdict: "verified",
  confidence: 0.95,
  checked_at: "2026-11-24T20:13:58.823Z",
};

const SUPPLY_BODY = {
  total_supply: 1000000000,
  total_supply_scope: "chain-specific ERC-20 totalSupply, decimals applied; not a global asset or circulating supply",
  token_symbol: "UNI",
  chain: "ethereum",
  as_of: "2026-11-24T20:13:59.898Z",
  verdict: "verified",
};

const H_URL = "https://verireceipt.onrender.com/v1/token-holders?token=UNI&chain=ethereum";
const L_URL = "https://verireceipt.onrender.com/v1/liquidity?pool=0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801&chain=ethereum";
const SP_URL = "https://verireceipt.onrender.com/v1/token-supply?token=UNI+on+ethereum";

const okHolders = () => verified("TOKEN_HOLDER_COUNT_GENERAL", H_URL, HOLDERS_BODY, HOLDERS_RECEIPT);
const okLiquidity = () => verified("LIQUIDITY_DEPTH_VERIFY_GENERAL", L_URL, LIQUIDITY_BODY, LIQUIDITY_RECEIPT);
const okSupply = () => verified("TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL", SP_URL, SUPPLY_BODY, SUPPLY_RECEIPT);

describe("M01 token listing-risk preset", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds three checks carrying token+chain, pool+chain, and the chained supply token on the wire", () => {
    const p = preset("m01-listing");
    const checks = p.buildChecks(p.inputs);
    expect(checks).toHaveLength(3);
    const [h, l, s] = checks;
    const hu = new URL(h.requestUrl);
    expect(hu.searchParams.get("token")).toBe("UNI");
    expect(hu.searchParams.get("chain")).toBe("ethereum");
    const lu = new URL(l.requestUrl);
    expect(lu.searchParams.get("pool")).toBe("0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801");
    expect(lu.searchParams.get("chain")).toBe("ethereum");
    expect(new URL(s.requestUrl).searchParams.get("token")).toBe("UNI on ethereum");
    expect(h.intent).toBe("TOKEN_HOLDER_COUNT_GENERAL");
    expect(l.intent).toBe("LIQUIDITY_DEPTH_VERIFY_GENERAL");
    expect(s.intent).toBe("TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL");
  });

  it("APPROVEs at 100 when all three verify and both declared floors clear", () => {
    const out = preset("m01-listing").evaluate([okHolders(), okLiquidity(), okSupply()]);
    expect(out.verdict).toBe("APPROVE");
    expect(out.score).toBe(100);
    expect(out.headline).toContain("432,070 holders");
    expect(out.headline).toContain("not an endorsement or investment advice");
    const holdersCard = out.why.find((c) => c.k === "Token Holders")!;
    expect(holdersCard.v).toContain("432,070");
    expect(holdersCard.v).toContain("100,000");
    expect(holdersCard.ok).toBe(true);
    const liquidityCard = out.why.find((c) => c.k === "Pool Liquidity")!;
    expect(liquidityCard.v).toContain("$10,496,122.08");
    expect(liquidityCard.ok).toBe(true);
  });

  it("marks total supply as context, never a gate", () => {
    const out = preset("m01-listing").evaluate([okHolders(), okLiquidity(), okSupply()]);
    const supplyCard = out.why.find((c) => c.k === "Total Supply (context)")!;
    expect(supplyCard.v).toContain("1,000,000,000");
    expect(supplyCard.v).toContain("context only, no floor applies");
    expect(supplyCard.ok).toBe("na");
  });

  it("HOLDs needs-review when the holders floor fails on verified data", () => {
    const low = verified("TOKEN_HOLDER_COUNT_GENERAL", H_URL, { ...HOLDERS_BODY, holders_count: 99999 }, HOLDERS_RECEIPT);
    const out = preset("m01-listing").evaluate([low, okLiquidity(), okSupply()]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
    expect(out.headline).toContain("99,999");
    expect(out.headline).toContain("below declared floor 100,000");
    expect(out.why.find((c) => c.k === "Token Holders")!.ok).toBe(false);
    expect(out.why.find((c) => c.k === "Pool Liquidity")!.ok).toBe(true);
  });

  it("HOLDs needs-review when the liquidity floor fails on verified data", () => {
    const low = verified("LIQUIDITY_DEPTH_VERIFY_GENERAL", L_URL, { ...LIQUIDITY_BODY, liquidity_usd: 4999999.99 }, LIQUIDITY_RECEIPT);
    const out = preset("m01-listing").evaluate([okHolders(), low, okSupply()]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
    expect(out.headline).toContain("$4,999,999.99");
  });

  it("HOLDs when any check fails to verify, including the context supply", () => {
    const out = preset("m01-listing").evaluate([okHolders(), okLiquidity(), refused("TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL", SP_URL)]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toBe("Evidence did not verify — review the rows before relying on this mark.");
    expect(out.score).toBe(67);
    expect(out.why.find((c) => c.k === "Total Supply (context)")!.ok).toBe(false);
  });

  it("treats a stale holder count as unverified, never as a current count", () => {
    const stale = verified("TOKEN_HOLDER_COUNT_GENERAL", H_URL, { ...HOLDERS_BODY, stale: true, stale_reason: "indexer timeout" }, HOLDERS_RECEIPT);
    const out = preset("m01-listing").evaluate([stale, okLiquidity(), okSupply()]);
    expect(out.verdict).toBe("HOLD");
    expect(out.why.find((c) => c.k === "Token Holders")!.v).toBe("not verified");
  });

  it("floors are the declared 100,000 holders and $5,000,000 boundaries", () => {
    const atH = verified("TOKEN_HOLDER_COUNT_GENERAL", H_URL, { ...HOLDERS_BODY, holders_count: 100000 }, HOLDERS_RECEIPT);
    const atL = verified("LIQUIDITY_DEPTH_VERIFY_GENERAL", L_URL, { ...LIQUIDITY_BODY, liquidity_usd: 5000000 }, LIQUIDITY_RECEIPT);
    expect(preset("m01-listing").evaluate([atH, atL, okSupply()]).verdict).toBe("APPROVE");
    const belowH = verified("TOKEN_HOLDER_COUNT_GENERAL", H_URL, { ...HOLDERS_BODY, holders_count: 99999 }, HOLDERS_RECEIPT);
    const belowL = verified("LIQUIDITY_DEPTH_VERIFY_GENERAL", L_URL, { ...LIQUIDITY_BODY, liquidity_usd: 4999999 }, LIQUIDITY_RECEIPT);
    const out = preset("m01-listing").evaluate([belowH, belowL, okSupply()]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("holders 99,999");
    expect(out.headline).toContain("$4,999,999");
  });

  it("runs the live clients against /v1/token-holders, /v1/liquidity and /v1/token-supply", async () => {
    const bodies: Record<string, Record<string, unknown>> = {
      "/v1/token-holders": HOLDERS_BODY,
      "/v1/liquidity": LIQUIDITY_BODY,
      "/v1/token-supply": SUPPLY_BODY,
    };
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const path = Object.keys(bodies).find((k) => url.includes(k))!;
      const body = bodies[path];
      const rcpt = path === "/v1/token-holders" ? HOLDERS_RECEIPT : path === "/v1/liquidity" ? LIQUIDITY_RECEIPT : SUPPLY_RECEIPT;
      return new Response(JSON.stringify({ ...body, receipt: rcpt }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const p = preset("m01-listing");
    const results: DeskCheckResult[] = [];
    for (const check of p.buildChecks(p.inputs)) {
      const outcome = await check.run();
      results.push({ check, receipt: toLiveReceipt(check.intent, check.query, check.requestUrl, outcome) });
    }
    expect(calls.some((u) => u.includes("/v1/token-holders"))).toBe(true);
    expect(calls.some((u) => u.includes("/v1/liquidity"))).toBe(true);
    expect(calls.some((u) => u.includes("/v1/token-supply"))).toBe(true);
    const out = p.evaluate(results);
    expect(out.verdict).toBe("APPROVE");
    expect(getTokenHolders).toBeDefined();
    expect(getPoolLiquidity).toBeDefined();
    expect(getTokenSupply).toBeDefined();
  });
});
