import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { escrowAskMiner } from "../src/client";

const fx = (n: string) => join(__dirname, "fixtures", n);
const live402 = readFileSync(fx("challenge-774921.json"), "utf8");
const acct = privateKeyToAccount(generatePrivateKey()); // throwaway test key
const payer = { address: acct.address, signMessage: (message: string) => acct.signMessage({ message }) };
const from = acct.address.toLowerCase();

function receiptHeader(over: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({
    receipt_hash: "0x" + "ab".repeat(32), rail: "escrow", payer: from, miner: "6152", intent: "TVL_LOOKUP_GENERAL",
    amount_uusdc: "10000", epoch_id: 31, settlement: "epoch", chain: "telegraph", timestamp: 1795267444, ...over,
  })).toString("base64");
}

function node(opts: { available?: string; paidStatus?: number; header?: string | null; challenge?: string } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/v1/ledger/account/")) return new Response(JSON.stringify({ available: opts.available ?? "1000000", balance: "1", deposited: "1", unbilled: "0", charged: "0" }));
    const h = new Headers(init?.headers);
    if (!h.get("X-PAYMENT")) return new Response(opts.challenge ?? live402, { status: 402 });
    const headers: Record<string, string> = {};
    if (opts.header !== null) headers["x-payment-response"] = opts.header ?? receiptHeader();
    return new Response(JSON.stringify({ result: { tvl_usd: 1 }, signal_hash: "0x" + "cd".repeat(32) }), { status: opts.paidStatus ?? 200, headers });
  });
  return { f: f as unknown as typeof fetch, calls };
}

const body = { intent: "TVL_LOOKUP_GENERAL", params: { protocol: "aave-v3" } };
const base = { spentTodayUusdc: 0n, dailyCapUusdc: 2_000_000n, minerIds: ["774921", "6152"] };

describe("escrowAskMiner", () => {
  it("pays with X-PAYMENT (never PAYMENT-SIGNATURE), resends the same body, decodes the receipt", async () => {
    const { f, calls } = node();
    const raw = vi.fn();
    const r = await escrowAskMiner("774921", body, payer, { ...base, f, onRawResponse: raw });
    const paidCall = calls.find((c) => new Headers(c.init?.headers).get("X-PAYMENT"))!;
    expect(paidCall.url).toBe("https://devnode.telegraphprotocol.com/engine/v1/ask/774921");
    expect(new Headers(paidCall.init?.headers).get("PAYMENT-SIGNATURE")).toBeNull();
    expect(paidCall.init?.body).toBe(JSON.stringify(body));
    const env = JSON.parse(Buffer.from(new Headers(paidCall.init?.headers).get("X-PAYMENT")!, "base64").toString());
    expect(env.scheme).toBe("escrow");
    expect(env.payload.authorization.value).toBe("10000");
    expect(r.receipt.miner).toBe("6152");
    expect(raw).toHaveBeenCalledOnce();
    expect(r.signedMessage).toContain("Network: eip155:11155111");
  });
  it("hands the raw reply to onRawResponse even when the receipt check then fails", async () => {
    const { f } = node({ header: receiptHeader({ miner: "999" }) });
    const raw = vi.fn();
    await expect(escrowAskMiner("774921", body, payer, { ...base, f, onRawResponse: raw })).rejects.toThrow(/miner=999/);
    expect(raw).toHaveBeenCalledOnce();
  });
  it("refuses to sign when escrow available is below the quote", async () => {
    const { f, calls } = node({ available: "9999" });
    await expect(escrowAskMiner("774921", body, payer, { ...base, f })).rejects.toThrow(/available/);
    expect(calls.some((c) => new Headers(c.init?.headers).get("X-PAYMENT"))).toBe(false);
  });
  it("refuses to sign past the daily cap", async () => {
    const { f, calls } = node();
    await expect(escrowAskMiner("774921", body, payer, { ...base, spentTodayUusdc: 1_995_000n, f })).rejects.toThrow(/daily cap/);
    expect(calls.some((c) => new Headers(c.init?.headers).get("X-PAYMENT"))).toBe(false);
  });
  it("refuses a quote above one flat call", async () => {
    const { f } = node({ challenge: live402.replace("Amount: 10000 uUSDC", "Amount: 20000 uUSDC") });
    await expect(escrowAskMiner("774921", body, payer, { ...base, f })).rejects.toThrow(/per-call cap/);
  });
  it("reports a refused paid call as not charged", async () => {
    const { f } = node({ paidStatus: 402, header: null });
    await expect(escrowAskMiner("774921", body, payer, { ...base, f })).rejects.toThrow(/not charged; header absent/);
  });
  it("uses a fresh nonce per call", async () => {
    const { f, calls } = node();
    await escrowAskMiner("774921", body, payer, { ...base, f });
    await escrowAskMiner("774921", body, payer, { ...base, f });
    const nonces = calls
      .map((c) => new Headers(c.init?.headers).get("X-PAYMENT"))
      .filter(Boolean)
      .map((p) => JSON.parse(Buffer.from(p!, "base64").toString()).payload.authorization.nonce);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});
