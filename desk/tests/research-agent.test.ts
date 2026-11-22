import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runResearch } from "../src/researchAgent";
import { makeResearchPlan, planHash, RESEARCH_INTENT } from "../src/research";
import { signalHashOf } from "../src/verify";
const T = new Date("2026-11-21T20:00:00Z"), done = new Date(T.getTime() + 2000);
const payer = "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3";
const challenge = readFileSync(join(__dirname, "fixtures", "challenge-774921.json"), "utf8");
function testNode(over: { intent?: string; error?: boolean; mismatch?: boolean } = {}) {
  const plan = makeResearchPlan({ cik: "320193", year: 2025, form: "10-Q", minimum_count: 1 }, T);
  const raw = JSON.stringify({ cik: "0000320193", name: "Apple", filings: { files: [], recent: { form: ["10-Q"], accessionNumber: ["0000320193-25-000001"], filingDate: ["2025-02-01"], primaryDocument: ["a.htm"] } } });
  const receipt = { receipt_id: "rcpt_" + "A".repeat(26), raw_response_sha256: createHash("sha256").update(raw).digest("hex"),
    upstream_url: "https://data.sec.gov/submissions/CIK0000320193.json", fetched_at: "2026-11-21T20:00:01Z" };
  const payload = { wallet_address: payer, miner_slug: "verireceipt", intent_id: RESEARCH_INTENT,
    request: `[intent] ${RESEARCH_INTENT} → ${JSON.stringify(plan.params)}`, timestamp: "2026-11-21T20:00:01Z",
    response: { filing_count: 1, form_type: "10-Q", receipt } };
  const signal = { payload, signal_hash: signalHashOf(payload) };
  const events: string[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/v1/ask/")) {
      if (!new Headers(init?.headers).has("X-PAYMENT")) { events.push("challenge"); return new Response(challenge, { status: 402 }); }
      events.push("paid-call");
      if (over.error) throw new Error("network lost after possible charge");
      const rr = { receipt_hash: "0x" + "ab".repeat(32), rail: "escrow", payer, miner: "6160", intent: over.intent ?? RESEARCH_INTENT,
        amount_uusdc: "10000", epoch_id: 33, settlement: "epoch", chain: "telegraph", timestamp: T.getTime() / 1000 + 1 };
      return new Response(JSON.stringify({ signal_hash: signal.signal_hash, result: { filing_count: 1 } }),
        { headers: { "x-payment-response": Buffer.from(JSON.stringify(rr)).toString("base64") } });
    }
    if (url.includes("/v1/ledger/account/")) return new Response(JSON.stringify({ available: "1000000" }));
    if (url.includes("/engine/v1/signal/")) return new Response(JSON.stringify(signal));
    if (url.endsWith("/raw")) return new Response(raw);
    if (url.includes("/receipts/")) return new Response(JSON.stringify(receipt));
    if (url.includes("/v1/blocks/")) {
      if (over.mismatch && url.includes("/deliveries/") && !url.endsWith("0".repeat(64))) {
        return new Response(JSON.stringify({ epoch_id: 33, deliveries_root: "0x" + "11".repeat(32), proof: ["0x" + "22".repeat(32)],
          delivery: { payer, receipt_hash: "0x" + "ab".repeat(32), usdc: 10000, miner_id: "6160", intent: "WRONG" } }));
      }
      return new Response(JSON.stringify({ error: "no block recorded for this epoch" }), { status: 404 });
    }
    throw new Error(`unexpected test URL ${url}`);
  }) as unknown as typeof fetch;
  const signMessage = vi.fn(async () => { events.push("sign"); return "0x" + "11".repeat(65); });
  const beforeSign = vi.fn(() => { events.push("reserve"); });
  const onRawResponse = vi.fn(() => { events.push("capture"); });
  return { plan, f, events, signMessage, beforeSign, onRawResponse };
}
describe("research purchase pipeline (synthetic network, no live purchases)", () => {
  it("reserves before signing; binds plan hash in nonce; verifies source then reports pending honestly", async () => {
    const n = testNode();
    const r = await runResearch(n.plan, planHash(n.plan), { address: payer, signMessage: n.signMessage }, { ...n, spentTodayUusdc: 0n, now: () => done });
    expect(n.events).toEqual(["challenge", "reserve", "sign", "paid-call", "capture"]);
    expect(r.result.status).toBe("SUPPORTED"); expect(r.result.observed_count).toBe(1);
    expect(r.nonce).toContain(planHash(n.plan)); expect(r.delivery.status).toBe("pending");
    expect(r.accounting_limit).toContain("not inclusion"); expect(r.testnet_amount_uusdc).toBe("10000");
    expect(n.signMessage).toHaveBeenCalledTimes(1);
  });
  it("stops before signing if the spend reservation cannot be persisted", async () => {
    const n = testNode(); n.beforeSign.mockImplementation(() => { throw new Error("disk full"); });
    await expect(runResearch(n.plan, planHash(n.plan), { address: payer, signMessage: n.signMessage }, { ...n, spentTodayUusdc: 0n, now: () => done })).rejects.toThrow("disk full");
    expect(n.signMessage).not.toHaveBeenCalled(); expect(n.events).not.toContain("paid-call");
  });
  it("awaits an asynchronous reservation failure before signing or paying", async () => {
    const n = testNode();
    const beforeSign = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve,5)); throw new Error("database commit failed"); });
    await expect(runResearch(n.plan,planHash(n.plan),{ address:payer,signMessage:n.signMessage },{ ...n,beforeSign,spentTodayUusdc:0n,now:()=>done })).rejects.toThrow("database commit failed");
    expect(n.signMessage).not.toHaveBeenCalled(); expect(n.events).not.toContain("paid-call");
  });
  it("awaits private response persistence before trusting a paid result", async () => {
    const n = testNode();
    const onRawResponse = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve,5)); throw new Error("private evidence commit failed"); });
    await expect(runResearch(n.plan,planHash(n.plan),{ address:payer,signMessage:n.signMessage },{ ...n,onRawResponse,spentTodayUusdc:0n,now:()=>done })).rejects.toThrow("private evidence commit failed");
    expect(n.events.filter(x=>x==="paid-call")).toHaveLength(1);
    expect(vi.mocked(n.f).mock.calls.some(x=>String(x[0]).includes('/engine/v1/signal/'))).toBe(false);
  });
  it("holds a receipt carrying the wrong intent even when other evidence verifies", async () => {
    const n = testNode({ intent: "WRONG" });
    const r = await runResearch(n.plan, planHash(n.plan), { address: payer, signMessage: n.signMessage }, { ...n, spentTodayUusdc: 0n, now: () => done });
    expect(r.result.status).toBe("HOLD"); expect(r.result.rows).toEqual([]);
  });
  it("holds mismatched included delivery rather than calling it settlement", async () => {
    const n = testNode({ mismatch: true });
    const r = await runResearch(n.plan, planHash(n.plan), { address: payer, signMessage: n.signMessage }, { ...n, spentTodayUusdc: 0n, now: () => done });
    expect(r.result.status).toBe("HOLD");
  });
  it("does not retry a paid request if its response is lost", async () => {
    const n = testNode({ error: true });
    await expect(runResearch(n.plan, planHash(n.plan), { address: payer, signMessage: n.signMessage }, { ...n, spentTodayUusdc: 0n, now: () => done })).rejects.toThrow("possible charge");
    expect(n.events.filter(x => x === "paid-call")).toHaveLength(1); expect(n.beforeSign).toHaveBeenCalledOnce();
  });
  it("rejects stale/mutated plans before any network access", async () => {
    const n = testNode(); const hash = planHash(n.plan); n.plan.minimum_count = 2;
    await expect(runResearch(n.plan, hash, { address: payer, signMessage: n.signMessage }, { ...n, spentTodayUusdc: 0n, now: () => done })).rejects.toThrow();
    expect(n.f).not.toHaveBeenCalled();
  });
  it("refuses daily-cap overflow before signing", async () => {
    const n = testNode();
    await expect(runResearch(n.plan, planHash(n.plan), { address: payer, signMessage: n.signMessage }, { ...n, spentTodayUusdc: 1999999n, now: () => done })).rejects.toThrow(/daily cap/);
    expect(n.signMessage).not.toHaveBeenCalled();
  });
});
