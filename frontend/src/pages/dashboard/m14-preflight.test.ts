// Mission 14 "Token-Risk Preflight" preset.
// Four live checks: holder breadth, pool liquidity and total supply (as in
// the listing screen) plus the new on-chain leg — the pool contract's
// native-coin balance at a finalized block pinned at run time. APPROVE only
// when all four verify AND both declared floors pass AND the contract holds
// exactly 0 wei. Anything unverified is HOLD; an unexpected contract balance
// is a NEEDS REVIEW HOLD (trapped or sent coin is a review trigger, not
// proof of malice); a verified floor failure is a NEEDS REVIEW HOLD (a
// screen threshold, never a finding about the token). The trade is always
// simulated; no wallet, signing or purchase exists in this page.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getOnchainMetric, getPoolLiquidity, getTokenHolders, getTokenSupply } from "../../lib/api";
import { DESK_PRESETS, type DeskCheckResult } from "./presets";
import { toLiveReceipt } from "./utils";

const HOLDERS_RECEIPT = {
  receipt_id: "rcpt_M14H000000000000000001",
  intent: "TOKEN_HOLDER_COUNT_GENERAL",
  upstream_url: "https://eth.blockscout.com/api/v2/tokens/0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  raw_response_sha256: "a".repeat(64),
  quorum_votes: "1/1 indexer of record",
  fetched_at: "2026-11-25T02:52:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M14H000000000000000001",
};

const LIQUIDITY_RECEIPT = {
  receipt_id: "rcpt_M14L000000000000000001",
  intent: "LIQUIDITY_DEPTH_VERIFY_GENERAL",
  upstream_url: "https://api.geckoterminal.com/api/v2/networks/eth/pools/0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801",
  raw_response_sha256: "b".repeat(64),
  quorum_votes: "1/1 primary source",
  fetched_at: "2026-11-25T02:52:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M14L000000000000000001",
};

const SUPPLY_RECEIPT = {
  receipt_id: "rcpt_M14S000000000000000001",
  intent: "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL",
  upstream_url: "https://eth.llamarpc.com",
  raw_response_sha256: "c".repeat(64),
  quorum_votes: "3/3 sources agreed",
  fetched_at: "2026-11-25T02:52:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M14S000000000000000001",
};

const BALANCE_RECEIPT = {
  receipt_id: "rcpt_M14B000000000000000001",
  intent: "ONCHAIN_METRIC_VERIFY_GENERAL",
  upstream_url: "https://eth-mainnet.public.blastapi.io",
  raw_response_sha256: "d".repeat(64),
  quorum_votes: "2/3 same finalized block hash, balance and nonce",
  fetched_at: "2026-11-25T02:52:01.543Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M14B000000000000000001",
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

// Holder/liquidity/supply shapes checked live 2026-11-24 20:04-20:14 UTC;
// the balance shape checked live 2026-11-25 02:52 UTC (unbilled probes).
const HOLDERS_BODY = {
  token: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  chain: "ethereum",
  holders_count: 432070,
  token_symbol: "UNI",
  as_of: "2026-11-25T02:52:00.000Z",
  stale: false,
  verdict: "verified",
};

const LIQUIDITY_BODY = {
  pool: "0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801",
  chain: "ethereum",
  liquidity_usd: 10496122.08,
  verdict: "verified",
  confidence: 0.95,
  checked_at: "2026-11-25T02:52:00.000Z",
};

const SUPPLY_BODY = {
  total_supply: 1000000000,
  total_supply_scope: "chain-specific ERC-20 totalSupply, decimals applied; not a global asset or circulating supply",
  token_symbol: "UNI",
  chain: "ethereum",
  as_of: "2026-11-25T02:52:00.000Z",
  verdict: "verified",
};

const BALANCE_BODY = {
  address: "0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801",
  chain: "ethereum",
  block: "26489252",
  block_hash: "0x7c626f5fcf249e4c764126d0e783748295e06d5ac6d4fafef922f2b8931a4d1c",
  balance_gwei: 0,
  balance_wei: "0",
  tx_count: 1,
  metric: "balance",
  verdict: "verified",
  confidence: 0.95,
  checked_at: "2026-11-25T02:52:01.561Z",
};

const H_URL = "https://verireceipt.onrender.com/v1/token-holders?token=UNI&chain=ethereum";
const L_URL = "https://verireceipt.onrender.com/v1/liquidity?pool=0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801&chain=ethereum";
const SP_URL = "https://verireceipt.onrender.com/v1/token-supply?token=UNI+on+ethereum";
const B_URL = "https://verireceipt.onrender.com/v1/onchain-metric?address=0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801&block=26489252&chain=ethereum&metric=balance";

const okHolders = () => verified("TOKEN_HOLDER_COUNT_GENERAL", H_URL, HOLDERS_BODY, HOLDERS_RECEIPT);
const okLiquidity = () => verified("LIQUIDITY_DEPTH_VERIFY_GENERAL", L_URL, LIQUIDITY_BODY, LIQUIDITY_RECEIPT);
const okSupply = () => verified("TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL", SP_URL, SUPPLY_BODY, SUPPLY_RECEIPT);
const okBalance = () => verified("ONCHAIN_METRIC_VERIFY_GENERAL", B_URL, BALANCE_BODY, BALANCE_RECEIPT);

describe("M14 token-risk preflight preset", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds four checks: holders, liquidity, supply, and the block-pinned contract balance", () => {
    const p = preset("m14-preflight");
    const checks = p.buildChecks(p.inputs);
    expect(checks).toHaveLength(4);
    const [h, l, s, b] = checks;
    expect(new URL(h.requestUrl).searchParams.get("token")).toBe("UNI");
    expect(new URL(l.requestUrl).searchParams.get("pool")).toBe("0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801");
    expect(new URL(s.requestUrl).searchParams.get("token")).toBe("UNI on ethereum");
    expect(new URL(b.requestUrl).searchParams.get("address")).toBe("0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801");
    expect(b.intent).toBe("ONCHAIN_METRIC_VERIFY_GENERAL");
    expect(b.query).toContain("finalized at run");
  });

  it("declares the simulated-trade framing", () => {
    expect(preset("m14-preflight").sub).toContain("simulated");
  });

  it("APPROVEs the simulated purchase when all four checks verify and pass", () => {
    const out = preset("m14-preflight").evaluate([okHolders(), okLiquidity(), okSupply(), okBalance()]);
    expect(out.verdict).toBe("APPROVE");
    expect(out.score).toBe(100);
    expect(out.headline).toContain("Simulated purchase cleared");
    expect(out.headline).toContain("no wallet, signing or purchase occurs");
    expect(out.headline).toContain("not an endorsement or investment advice");
    const bCard = out.why.find((c) => c.k === "Contract Balance")!;
    expect(bCard.v).toContain("0 gwei");
    expect(bCard.v).toContain("26489252");
    expect(bCard.ok).toBe(true);
  });

  it("HOLDs for review when a declared floor fails on verified data, never a REJECT", () => {
    const thin = verified("LIQUIDITY_DEPTH_VERIFY_GENERAL", L_URL, { ...LIQUIDITY_BODY, liquidity_usd: 4000000 }, LIQUIDITY_RECEIPT);
    const out = preset("m14-preflight").evaluate([okHolders(), thin, okSupply(), okBalance()]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
    expect(out.headline).toContain("below declared floor");
    expect(out.headline).toContain("A screen threshold, not a finding about the token");
    expect(out.headline).toContain("no trade occurs");
    expect(out.why.find((c) => c.k === "Pool Liquidity")!.ok).toBe(false);
    expect(out.why.find((c) => c.k === "Contract Balance")!.ok).toBe(true);
  });

  it("HOLDs for review when holders are below the declared floor even with a clean balance", () => {
    const few = verified("TOKEN_HOLDER_COUNT_GENERAL", H_URL, { ...HOLDERS_BODY, holders_count: 90000 }, HOLDERS_RECEIPT);
    const out = preset("m14-preflight").evaluate([few, okLiquidity(), okSupply(), okBalance()]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
    expect(out.headline).toContain("holders 90,000 below declared floor 100,000");
    expect(out.headline).toContain("A screen threshold, not a finding about the token");
  });

  it("HOLDs for review when the contract holds unexpected native coin, gated on exact wei", () => {
    const trapped = verified("ONCHAIN_METRIC_VERIFY_GENERAL", B_URL, { ...BALANCE_BODY, balance_gwei: 42.5, balance_wei: "42500000000" }, BALANCE_RECEIPT);
    const out = preset("m14-preflight").evaluate([okHolders(), okLiquidity(), okSupply(), trapped]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
    expect(out.headline).toContain("42.5 gwei");
    expect(out.headline).toContain("not proof of malice");
    expect(out.headline).toContain("not cleared");
    expect(out.why.find((c) => c.k === "Contract Balance")!.ok).toBe(false);
  });

  it("HOLDs as unverified when the balance response omits the exact wei string", () => {
    const noWei = verified("ONCHAIN_METRIC_VERIFY_GENERAL", B_URL, { ...BALANCE_BODY, balance_wei: undefined }, BALANCE_RECEIPT);
    const out = preset("m14-preflight").evaluate([okHolders(), okLiquidity(), okSupply(), noWei]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("Evidence did not verify");
    expect(out.why.find((c) => c.k === "Contract Balance")!.ok).toBe(false);
  });

  it("HOLDs with an unsupported-chain note when the scope is not ethereum", () => {
    const out = preset("m14-preflight").evaluate([okHolders(), okLiquidity(), okSupply(), okBalance()], { entity: "UNI", ref: "0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801", scope: "polygon" });
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("NEEDS REVIEW");
    expect(out.headline).toContain('unsupported chain "polygon"');
    expect(out.headline).toContain("ethereum");
  });

  it("HOLDs when the balance check does not verify, never clearing", () => {
    const out = preset("m14-preflight").evaluate([okHolders(), okLiquidity(), okSupply(), refused("ONCHAIN_METRIC_VERIFY_GENERAL", B_URL)]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("Evidence did not verify");
    expect(out.headline).toContain("not cleared");
    expect(out.score).toBe(75);
  });

  it("HOLDs when every check fails and reports a zero verification score", () => {
    const out = preset("m14-preflight").evaluate([
      refused("TOKEN_HOLDER_COUNT_GENERAL", H_URL),
      refused("LIQUIDITY_DEPTH_VERIFY_GENERAL", L_URL),
      refused("TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL", SP_URL),
      refused("ONCHAIN_METRIC_VERIFY_GENERAL", B_URL),
    ]);
    expect(out.verdict).toBe("HOLD");
    expect(out.score).toBe(0);
  });

  it("turns a failed block resolution into a failed check, never an aborted run", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const checks = preset("m14-preflight").buildChecks(preset("m14-preflight").inputs);
    const balanceCheck = checks[3];
    const outcome = await balanceCheck.run();
    expect(outcome.ok).toBe(false);
    const receipt = toLiveReceipt(balanceCheck.intent, balanceCheck.query, balanceCheck.requestUrl, outcome);
    const out = preset("m14-preflight").evaluate([okHolders(), okLiquidity(), okSupply(), { check: balanceCheck, receipt }]);
    expect(out.verdict).toBe("HOLD");
    expect(out.headline).toContain("Evidence did not verify");
  });

  it("resolves the finalized block at run time before calling the miner", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("blastapi")) {
        expect(String(init?.body)).toContain("finalized");
        return Response.json({ jsonrpc: "2.0", id: 1, result: { number: "0x123" } });
      }
      return Response.json({ error: "unit" }, { status: 503 });
    });
    const checks = preset("m14-preflight").buildChecks(preset("m14-preflight").inputs);
    await Promise.allSettled(checks.map((c) => c.run()));
    const metricCall = seen.find((u) => u.includes("/v1/onchain-metric"));
    expect(metricCall).toBeDefined();
    expect(metricCall).toContain("block=291");
    expect(metricCall).toContain("metric=balance");
    expect(seen.some((u) => u.includes("/v1/token-holders") && u.includes("UNI"))).toBe(true);
    expect(seen.some((u) => u.includes("/v1/liquidity"))).toBe(true);
    expect(seen.some((u) => u.includes("/v1/token-supply"))).toBe(true);
  });

  it("exposes the live onchain-metric client", () => {
    expect(typeof getOnchainMetric).toBe("function");
    expect(typeof getTokenHolders).toBe("function");
    expect(typeof getPoolLiquidity).toBe("function");
    expect(typeof getTokenSupply).toBe("function");
  });
});
