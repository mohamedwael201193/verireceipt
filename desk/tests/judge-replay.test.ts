import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { evidenceGet, replayResearch, type PublishedResearch } from "../src/judgeReplay";
import { makeResearchPlan, planHash, RESEARCH_INTENT } from "../src/research";
import { signalHashOf } from "../src/verify";
const payer = "0x" + "ab".repeat(20);
const at = new Date("2026-11-21T20:00:00Z"), completed = "2026-11-21T20:00:02Z";
function fixture(change = "") {
  const plan = makeResearchPlan({ cik: "320193", year: 2025, form: "10-Q", minimum_count: 1 }, at);
  const raw = JSON.stringify({ cik: "0000320193", name: "Fixture Inc.", filings: { files: [], recent: {
    form: ["10-Q"], accessionNumber: ["0000320193-25-000001"], filingDate: ["2025-02-01"], primaryDocument: ["a.htm"] } } });
  const receipt = { receipt_id: "rcpt_" + "A".repeat(26), raw_response_sha256: createHash("sha256").update(raw).digest("hex"),
    upstream_url: "https://data.sec.gov/submissions/CIK0000320193.json", fetched_at: "2026-11-21T20:00:01Z" };
  const payload = { wallet_address: payer, miner_slug: "verireceipt", intent_id: RESEARCH_INTENT,
    request: `[intent] ${RESEARCH_INTENT} → ${JSON.stringify(plan.params)}`, timestamp: "2026-11-21T20:00:01Z",
    response: { filing_count: 1, form_type: "10-Q", receipt } };
  const record: PublishedResearch = { plan, plan_hash: planHash(plan), completed_at: completed, signal_hash: signalHashOf(payload),
    result: { status: "SUPPORTED", observed_count: 1 }, receipt: { receipt_hash: "0x" + "12".repeat(32), rail: "escrow", miner: "6160", intent: RESEARCH_INTENT,
      amount_uusdc: "10000", epoch_id: 33, settlement: "epoch", chain: "telegraph", timestamp: at.getTime() / 1000 + 1 } };
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error");
    if (change === "offline") throw new Error("offline");
    if (url.includes("/signal/")) return Response.json({ signal_hash: record.signal_hash, payload: change === "signal" ? { ...payload, miner_slug: "wrong" } : payload });
    if (url.endsWith("/raw")) return new Response(change === "raw" ? raw + "altered" : raw);
    if (url.includes("/receipts/")) return Response.json(receipt);
    if (url.includes("/deliveries/")) {
      if (change === "pending") return Response.json({ error: "no block recorded for this epoch" }, { status: 404 });
      return Response.json({ epoch_id: 33, deliveries_root: "0x" + "23".repeat(32), proof: [change === "proof" ? "bad" : "0x" + "34".repeat(32)],
        delivery: { receipt_hash: record.receipt.receipt_hash, payer: change === "payer" ? "0x" + "cd".repeat(20) : payer,
          miner_id: "6160", intent: RESEARCH_INTENT, usdc: change === "amount" ? 20000 : 10000 } });
    }
    if (url.endsWith("/v1/blocks/33")) return Response.json({ epoch_id: 33, window_from: change === "epoch" ? "2026-11-22T01:00:00Z" : "2026-11-21T19:00:00Z", window_to: "2026-11-21T22:00:00Z" });
    throw new Error("unexpected fixture URL");
  });
  return { record, f };
}
describe("no-wallet historical judge replay, synthetic network only", () => {
  it("recomputes the source count and current included delivery without trusting saved checks", async () => {
    const { record, f } = fixture(); const r = await replayResearch(record, payer, f as typeof fetch);
    expect(r.ok).toBe(true); expect(r.status).toBe("SUPPORTED"); expect(r.count).toBe(1); expect(r.delivery).toBe("included");
    expect(r.limits.join(" ")).toContain("not a fresh answer");
    expect(f.mock.calls.filter(([url]) => url.endsWith("/raw"))).toHaveLength(1);
    expect(f.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it.each(["signal", "raw", "payer", "amount", "proof", "epoch", "pending", "offline"])("fails closed with no count for %s", async change => {
    const { record, f } = fixture(change); const r = await replayResearch(record, payer, f as typeof fetch);
    expect(r.ok).toBe(false); expect(r.status).toBe("HOLD"); expect(r.count).toBeNull();
    expect(r.checks.some(c => !c.ok)).toBe(true);
  });
  it("rejects a mutated plan before any network call", async () => {
    const { record, f } = fixture(); record.plan.minimum_count = 2;
    const r = await replayResearch(record, payer, f as typeof fetch); expect(r.ok).toBe(false); expect(f).not.toHaveBeenCalled();
  });
  it("compares the saved outcome with independent extraction rather than honoring its label", async () => {
    const { record, f } = fixture(); record.result.status = "NOT_SUPPORTED";
    expect((await replayResearch(record, payer, f as typeof fetch)).ok).toBe(false);
  });
  it.each([
    ["https://devnode.telegraphprotocol.com/engine/v1/ask", { method: "POST" }],
    ["https://devnode.telegraphprotocol.com/v1/ledger/account/a", {}],
    ["https://example.com/receipts/a", {}],
    ["https://user:pass@devnode.telegraphprotocol.com/engine/v1/signal/a", {}],
    ["https://devnode.telegraphprotocol.com/engine/v1/signal/a", { body: "no" }],
  ] as const)("refuses non-evidence or write request %s", async (url, init) => {
    const f = vi.fn(); await expect(evidenceGet(f)(url, init)).rejects.toThrow(/only public evidence GET/); expect(f).not.toHaveBeenCalled();
  });
});
