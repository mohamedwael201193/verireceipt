import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { escrowAskAuto } from "../src/client";

const fx = (n: string) => join(__dirname, "fixtures", n);
// The live 402 shape, retargeted to the auto-routed resource (no miner id).
const live402auto = readFileSync(fx("challenge-774921.json"), "utf8").replaceAll("/v1/ask/774921", "/v1/ask");
const acct = privateKeyToAccount(generatePrivateKey()); // throwaway test key
// A fresh signer spy per test (mockClear strips the implementation on this vitest).
const makePayer = () => ({ address: acct.address, signMessage: vi.fn((message: string) => acct.signMessage({ message })) });
const from = acct.address.toLowerCase();

function receiptHeader(over: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({
    receipt_hash: "0x" + "ab".repeat(32), rail: "escrow", payer: from, miner: "424242", intent: "TVL_LOOKUP_GENERAL",
    amount_uusdc: "10000", epoch_id: 40, settlement: "epoch", chain: "telegraph", timestamp: 1795267444, ...over,
  })).toString("base64");
}

function node(opts: { available?: string; paidStatus?: number; header?: string | null; challenge?: string } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/v1/ledger/account/")) return new Response(JSON.stringify({ available: opts.available ?? "1000000", balance: "1", deposited: "1", unbilled: "0", charged: "0" }));
    const h = new Headers(init?.headers);
    if (!h.get("X-PAYMENT")) return new Response(opts.challenge ?? live402auto, { status: 402 });
    const headers: Record<string, string> = {};
    if (opts.header !== null) headers["x-payment-response"] = opts.header ?? receiptHeader();
    return new Response(JSON.stringify({ miner_id: "424242", result: { tvl_usd: 1 }, signal_hash: "0x" + "cd".repeat(32) }), { status: opts.paidStatus ?? 200, headers });
  });
  return { f: f as unknown as typeof fetch, calls };
}

const body = { intent: "TVL_LOOKUP_GENERAL", params: { protocol: "aave-v3" } };
const base = { spentTodayUusdc: 0n, dailyCapUusdc: 2_000_000n };

describe("escrowAskAuto", () => {
  it("posts to /engine/v1/ask with no miner id, bounds the budget, decodes a receipt naming any serving miner", async () => {
    const payer = makePayer();
    const { f, calls } = node();
    const r = await escrowAskAuto(body, payer, { ...base, f });
    const paidCall = calls.find((c) => new Headers(c.init?.headers).get("X-PAYMENT"))!;
    expect(paidCall.url).toBe("https://devnode.telegraphprotocol.com/engine/v1/ask");
    const sent = JSON.parse(String(paidCall.init?.body));
    expect(sent).toEqual({ ...body, max_budget_usdc: 10000 });
    const challengeCall = calls.find((c) => !new Headers(c.init?.headers).get("X-PAYMENT") && !c.url.includes("ledger"))!;
    expect(String(challengeCall.init?.body)).toBe(String(paidCall.init?.body));
    const env = JSON.parse(Buffer.from(new Headers(paidCall.init?.headers).get("X-PAYMENT")!, "base64").toString());
    expect(env.scheme).toBe("escrow");
    expect(r.receipt.miner).toBe("424242");
    expect(r.signedMessage).toContain("Resource: /v1/ask");
  });
  it("rejects a receipt whose miner is not a decimal registration id", async () => {
    const payer = makePayer();
    const { f } = node({ header: receiptHeader({ miner: "verireceipt" }) });
    await expect(escrowAskAuto(body, payer, { ...base, f })).rejects.toThrow(/miner=verireceipt/);
  });
  it("hands the raw reply to onRawResponse even when the receipt check then fails", async () => {
    const payer = makePayer();
    const { f } = node({ header: receiptHeader({ miner: "not-a-number" }) });
    const raw = vi.fn();
    await expect(escrowAskAuto(body, payer, { ...base, f, onRawResponse: raw })).rejects.toThrow(/miner=not-a-number/);
    expect(raw).toHaveBeenCalledOnce();
  });
  it("refuses a max_budget above the Desk per-call cap before any network call or signature", async () => {
    const payer = makePayer();
    const { f, calls } = node();
    await expect(escrowAskAuto(body, payer, { ...base, maxBudgetUusdc: 20_000n, f })).rejects.toThrow(/per-call cap/);
    expect(calls).toHaveLength(0);
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("refuses a budget outside the node's bounds before any network call or signature", async () => {
    const payer = makePayer();
    const { f, calls } = node();
    await expect(escrowAskAuto(body, payer, { ...base, maxBudgetUusdc: 5_000n, f })).rejects.toThrow(/outside 10000/);
    expect(calls).toHaveLength(0);
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("refuses when the 402 challenge names a miner-scoped resource instead of /v1/ask, without signing", async () => {
    const payer = makePayer();
    const { f } = node({ challenge: live402auto.replaceAll("/v1/ask", "/v1/ask/774921") });
    await expect(escrowAskAuto(body, payer, { ...base, f })).rejects.toThrow(/resource/);
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("refuses a quote above one flat call, without signing", async () => {
    const payer = makePayer();
    const { f } = node({ challenge: live402auto.replace("Amount: 10000 uUSDC", "Amount: 20000 uUSDC") });
    await expect(escrowAskAuto(body, payer, { ...base, f })).rejects.toThrow(/per-call cap/);
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("refuses to sign past the daily cap", async () => {
    const payer = makePayer();
    const { f, calls } = node();
    await expect(escrowAskAuto(body, payer, { ...base, spentTodayUusdc: 1_995_000n, f })).rejects.toThrow(/daily cap/);
    expect(calls.some((c) => new Headers(c.init?.headers).get("X-PAYMENT"))).toBe(false);
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("refuses to sign when escrow available is below the quote", async () => {
    const payer = makePayer();
    const { f, calls } = node({ available: "9999" });
    await expect(escrowAskAuto(body, payer, { ...base, f })).rejects.toThrow(/available/);
    expect(calls.some((c) => new Headers(c.init?.headers).get("X-PAYMENT"))).toBe(false);
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("refuses a challenge on the wrong network without signing", async () => {
    const payer = makePayer();
    const { f } = node({ challenge: live402auto.replaceAll("eip155:11155111", "eip155:1") });
    await expect(escrowAskAuto(body, payer, { ...base, f })).rejects.toThrow(/not eip155:11155111/);
    expect(payer.signMessage).not.toHaveBeenCalled();
  });
  it("reports a refused paid call as not charged", async () => {
    const payer = makePayer();
    const { f } = node({ paidStatus: 402, header: null });
    await expect(escrowAskAuto(body, payer, { ...base, f })).rejects.toThrow(/not charged; header absent/);
  });
});
