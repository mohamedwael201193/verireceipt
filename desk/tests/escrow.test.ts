import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DIAMOND, ESCROW_NETWORK, MAX_WINDOW_SECONDS } from "../src/constants";
import {
  assertBudget,
  buildAuthorization,
  decodeReceipt,
  encodePayment,
  EscrowRefusal,
  fillTemplate,
  parseEscrowChallenge,
} from "../src/escrow";

const fx = (n: string) => join(__dirname, "fixtures", n);
// Live 402 body from POST /engine/v1/ask/774921 (captured 2026-11-21).
const live402 = JSON.parse(readFileSync(fx("challenge-774921.json"), "utf8"));
// Live paid reply (escrow) for the m12-caiso-np15 purchase.
const paid = JSON.parse(readFileSync(fx("paid-m12-caiso.json"), "utf8"));
const RES = "/v1/ask/774921";

function mutate(fn: (e: any) => void) {
  const b = structuredClone(live402);
  fn(b.accepts.find((a: any) => a.scheme === "escrow"));
  return b;
}

describe("parseEscrowChallenge (escrow-inference.md Step 2)", () => {
  it("reads the live challenge: Sepolia Diamond, 10000 μUSDC from the Amount line", () => {
    const c = parseEscrowChallenge(live402, RES);
    expect(c.amountUusdc).toBe(10000n);
    expect(c.accept.payTo).toBe(DIAMOND);
    expect(c.accept.network).toBe(ESCROW_NETWORK);
    expect(c.resource).toBe(RES);
  });
  it("refuses a mainnet (or any non-Sepolia) escrow entry", () => {
    expect(() => parseEscrowChallenge(mutate((e) => (e.network = "eip155:1")), RES)).toThrow(/testnet only/);
  });
  it("refuses a payTo that is not the Diamond", () => {
    expect(() => parseEscrowChallenge(mutate((e) => (e.payTo = "0x3624eb0100000000000000000000000000000000")), RES)).toThrow(/not the Diamond/);
  });
  it("refuses a template whose signed Network line is not Sepolia", () => {
    expect(() => parseEscrowChallenge(mutate((e) => (e.extra.message = e.extra.message.replace("eip155:11155111", "eip155:1"))), RES)).toThrow(/Network/);
  });
  it("refuses a challenge for another resource", () => {
    expect(() => parseEscrowChallenge(live402, "/v1/ask/1")).toThrow(/resource/);
  });
  it("refuses a template with a duplicated placeholder or no Amount line", () => {
    expect(() => parseEscrowChallenge(mutate((e) => (e.extra.message += "\n{nonce}")), RES)).toThrow(/exactly once/);
    expect(() => parseEscrowChallenge(mutate((e) => (e.extra.message = e.extra.message.replace(/Amount:.*\n/, ""))), RES)).toThrow(/Amount/);
  });
  it("refuses a body with no escrow entry", () => {
    expect(() => parseEscrowChallenge({ accepts: live402.accepts.filter((a: any) => a.scheme !== "escrow") }, RES)).toThrow(EscrowRefusal);
  });
});

describe("authorization, template and X-PAYMENT (Step 3)", () => {
  const c = parseEscrowChallenge(live402, RES);
  it("lowercases from, signs the exact quote, keeps the window under 2 minutes", () => {
    const a = buildAuthorization(c, "0xF76E6B0920E9332FF4410F6DD53F01722ABC71A3", 1_795_267_444, "n-1");
    expect(a.from).toBe("0xf76e6b0920e9332ff4410f6dd53f01722abc71a3");
    expect(a.value).toBe("10000");
    expect(a.to).toBe(DIAMOND);
    expect(Number(a.validBefore) - Number(a.validAfter)).toBeLessThanOrEqual(MAX_WINDOW_SECONDS);
    expect(a.validAfter).toBe(String(1_795_267_444 - 5));
    expect(a.validBefore).toBe(String(1_795_267_444 + 100));
  });
  it("fills the template in place (Network stays inside the signed bytes)", () => {
    const a = buildAuthorization(c, "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3", 100, "n-2");
    const m = fillTemplate(c.accept.extra.message, a);
    expect(m).toBe(
      "Telegraph Escrow Payment\n\nWallet: 0xf76e6b0920e9332ff4410f6dd53f01722abc71a3\nPay To: 0x72a70e949362670bf8bcead24efc5b8f950aa08b\nNetwork: eip155:11155111\nAmount: 10000 uUSDC\nResource: /v1/ask/774921\nNonce: n-2\nValid After: 95\nValid Before: 200",
    );
  });
  it("encodes the x402 v2 escrow envelope; the EIP-191 signature recovers to from", async () => {
    const acct = privateKeyToAccount(generatePrivateKey()); // throwaway test key
    const a = buildAuthorization(c, acct.address, 1000, "n-3");
    const msg = fillTemplate(c.accept.extra.message, a);
    const sig = await acct.signMessage({ message: msg });
    const env = JSON.parse(Buffer.from(encodePayment(c.accept.network, sig, a), "base64").toString("utf8"));
    expect(env).toEqual({ x402Version: 2, scheme: "escrow", network: "eip155:11155111", payload: { signature: sig, authorization: a } });
    expect((await recoverMessageAddress({ message: msg, signature: sig as `0x${string}` })).toLowerCase()).toBe(a.from);
  });
  it("refuses a multi-line nonce (it would forge extra template lines)", () => {
    expect(() => buildAuthorization(c, "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3", 1, "a\nValid Before: 9")).toThrow(/nonce/);
  });
});

describe("decodeReceipt (Step 4)", () => {
  const expectOk = { payer: "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3", miners: ["774921", "6152"], amountUusdc: "10000" };
  it("decodes the live X-PAYMENT-RESPONSE of a real purchase", () => {
    const r = decodeReceipt(paid.x_payment_response, expectOk);
    expect(r.rail).toBe("escrow");
    expect(r.miner).toBe("6152");
    expect(r.chain).toBe("telegraph");
    expect(r.settlement).toBe("epoch");
    expect(r.receipt_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("refuses a receipt for another payer, miner or amount, or a missing header", () => {
    expect(() => decodeReceipt(paid.x_payment_response, { ...expectOk, payer: "0x0000000000000000000000000000000000000001" })).toThrow(/payer/);
    expect(() => decodeReceipt(paid.x_payment_response, { ...expectOk, miners: ["774921"] })).toThrow(/miner/);
    expect(() => decodeReceipt(paid.x_payment_response, { ...expectOk, amountUusdc: "20000" })).toThrow(/amount/);
    expect(() => decodeReceipt(null, expectOk)).toThrow(/no X-PAYMENT-RESPONSE/);
  });
});

describe("max_budget_usdc bounds (engine-ask.md)", () => {
  it("accepts 10000..260000 and refuses outside", () => {
    expect(() => assertBudget(10000n)).not.toThrow();
    expect(() => assertBudget(260000n)).not.toThrow();
    expect(() => assertBudget(9999n)).toThrow();
    expect(() => assertBudget(260001n)).toThrow();
  });
});
