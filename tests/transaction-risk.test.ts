import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/tx-risk-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleTransactionRisk, extractSdnCryptoAddresses, riskLevel } from "../src/handlers/transactionRisk";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real mainnet RPC bodies retrieved 2026-11-23 (shared with crypto-transfer).
const txResult = JSON.parse(readFileSync(join(__dirname, "fixtures/crypto-transfer/eth-usdc-transfer-tx.json"), "utf8"));
const receiptResult = JSON.parse(readFileSync(join(__dirname, "fixtures/crypto-transfer/eth-usdc-transfer-receipt.json"), "utf8"));
const TX_HASH = String(txResult.hash).toLowerCase();
const T_FROM = "0xc917c3fa468f2c4b9c84c72caa46420eb9825249"; // the fixture tx sender
// Synthetic-labelled SDN excerpt carrying T_FROM as a Digital Currency Address.
const sdnWith = readFileSync(join(__dirname, "fixtures/transaction-risk/sdn-excerpt.csv"), "utf8");
const sdnWithout = sdnWith.replace(/Digital Currency Address - ETH 0x[0-9a-fA-F]{40}/g, "Digital Currency Address - ETH 0x1111111111111111111111111111111111111111");
function rpcBody(result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result });
}
type Opts = { sdn?: string | "ERR"; rpc?: "ok" | "down" | "notfound" };
function stub(opts: Opts = {}): void {
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("ofac.treas.gov")) {
      if (opts.sdn === "ERR") throw new Error("sdn outage");
      return new Response(opts.sdn ?? sdnWithout, { status: 200 });
    }
    if (opts.rpc === "down") throw new Error("rpc outage");
    const method = JSON.parse(String(init?.body ?? "{}")).method;
    if (opts.rpc === "notfound") return new Response(rpcBody(null), { status: 200 });
    return new Response(rpcBody(method === "eth_getTransactionReceipt" ? receiptResult : txResult), { status: 200 });
  });
}
describe("TRANSACTION_RISK_GENERAL", () => {
  it("requires an ethereum mainnet tx hash", async () => {
    await expect(handleTransactionRisk({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleTransactionRisk({ transaction: "1234" })).rejects.toMatchObject({ status: 400, code: "INVALID_TX_HASH" });
  });
  it("extracts only Digital Currency Address entries from the SDN text", () => {
    const addrs = extractSdnCryptoAddresses(sdnWith);
    expect(addrs).toContain(T_FROM);
    expect(addrs).toHaveLength(2);
  });
  it("a clean tx is LOW with the heuristic disclaimer, never a safety claim", async () => {
    stub();
    const result = await handleTransactionRisk({ transaction: TX_HASH });
    expect(result.risk_level).toBe("LOW");
    expect(result.risk_score).toBe(0);
    const ans = String(result.answer);
    expect(ans).toContain("no rubric signal fired");
    expect(ans).toContain("not that the transaction is safe");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("TRANSACTION_RISK_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const ev = String(stored.evidence);
    expect(ev).toContain("heuristic_notice");
    expect(ev).toContain("ethereum mainnet only");
  });
  it("an SDN-listed counterparty is CRITICAL 1.0 with the list named as ground truth", async () => {
    stub({ sdn: sdnWith });
    const result = await handleTransactionRisk({ transaction: TX_HASH });
    expect(result.risk_level).toBe("CRITICAL");
    expect(result.risk_score).toBe(1);
    const sigs = (result.signals as string[]).join(" ");
    expect(sigs).toContain("SANCTIONED_COUNTERPARTY");
    expect(sigs).toContain("OFAC SDN");
    expect(String(result.answer)).toContain("CRITICAL");
  });
  it("the sanctions leg down fails closed, never a grade without screening", async () => {
    stub({ sdn: "ERR" });
    await expect(handleTransactionRisk({ transaction: TX_HASH })).rejects.toMatchObject({ status: 502, code: "SANCTIONS_UNAVAILABLE" });
  });
  it("RPC outage is a 502 and an unknown hash a 422", async () => {
    stub({ rpc: "down" });
    await expect(handleTransactionRisk({ transaction: TX_HASH })).rejects.toMatchObject({ status: 502, code: "RPC_QUORUM_UNREACHABLE" });
    vi.unstubAllGlobals();
    stub({ rpc: "notfound" });
    await expect(handleTransactionRisk({ transaction: TX_HASH })).rejects.toMatchObject({ status: 422, code: "TX_NOT_FOUND" });
  });
  it("risk levels follow the published rubric", () => {
    expect(riskLevel(0)).toBe("LOW");
    expect(riskLevel(0.3)).toBe("MEDIUM");
    expect(riskLevel(0.5)).toBe("HIGH");
    expect(riskLevel(1)).toBe("CRITICAL");
  });
  it("GET /v1/transaction-risk is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/transaction-risk" })).toBe(true);
    await app.close();
  });
});

describe("transaction-risk follow-ups (reviewer)", () => {
  it("heuristic-only combinations are capped at 0.4 MEDIUM, never HIGH", async () => {
    // Reverted (+0.3) contract creation (+0.1) carrying 200 ETH (+0.1)
    // sums to 0.5 by raw weights but must cap at 0.4.
    const bigCreationTx = { ...txResult, to: null, value: "0xad78ebc5ac6200000" }; // 200 ETH
    const revertedReceipt = { ...receiptResult, status: "0x0", logs: [] };
    vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes("ofac.treas.gov")) return new Response(sdnWithout, { status: 200 });
      const method = JSON.parse(String(init?.body ?? "{}")).method;
      return new Response(rpcBody(method === "eth_getTransactionReceipt" ? revertedReceipt : bigCreationTx), { status: 200 });
    });
    const result = await handleTransactionRisk({ transaction: TX_HASH });
    expect(result.risk_score).toBe(0.4);
    expect(result.risk_level).toBe("MEDIUM");
  });
  it("legacy root before fork means effective success; missing status and root refuses", async () => {
    const byzantine = { ...receiptResult, blockNumber: "0xb443" };
    delete (byzantine as Record<string, unknown>).status;
    (byzantine as Record<string, unknown>).root = "0x" + "ab".repeat(32);
    vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes("ofac.treas.gov")) return new Response(sdnWithout, { status: 200 });
      const method = JSON.parse(String(init?.body ?? "{}")).method;
      return new Response(rpcBody(method === "eth_getTransactionReceipt" ? byzantine : txResult), { status: 200 });
    });
    const ok = await handleTransactionRisk({ transaction: TX_HASH });
    expect(ok.risk_level).toBe("LOW"); // root present: NOT flagged reverted
    vi.unstubAllGlobals();
    const noRoot = { ...receiptResult };
    delete (noRoot as Record<string, unknown>).status;
    vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes("ofac.treas.gov")) return new Response(sdnWithout, { status: 200 });
      const method = JSON.parse(String(init?.body ?? "{}")).method;
      return new Response(rpcBody(method === "eth_getTransactionReceipt" ? noRoot : txResult), { status: 200 });
    });
    await expect(handleTransactionRisk({ transaction: TX_HASH })).rejects.toMatchObject({ code: "RPC_QUORUM_DISAGREEMENT" });
  });
});

it('null-vs-found receipt recovery preserves actual risk and all attempts in stored evidence',async()=>{
 const calls=new Map<string,number>();vi.stubGlobal('fetch',async(u:unknown,init?:RequestInit)=>{
  const url=String(u);if(url.includes('ofac.treas.gov'))return new Response(sdnWithout);
  const method=JSON.parse(String(init?.body)).method;if(method!=='eth_getTransactionReceipt')return new Response(rpcBody(txResult));
  calls.set(url,(calls.get(url)??0)+1);return new Response(rpcBody(url.includes('mevblocker')?null:receiptResult));
 });
 const out=await handleTransactionRisk({transaction:TX_HASH});expect(out.risk_level).toBe('LOW');expect([...calls.values()]).toEqual([2,2,2]);
 const stored=await getReceiptEvidence((out.receipt as any).receipt_id),ev=JSON.parse(stored.evidence!.toString());expect(Object.keys(ev.raw_bodies.receipt)).toHaveLength(6);expect(ev.receipt_quorum_policy).toContain('1100ms');expect(sha256Hex(stored.evidence!)).toBe((out.receipt as any).raw_response_sha256);
});
it('RPC error envelopes never masquerade as null not-found quorum',async()=>{
 vi.stubGlobal('fetch',async(u:unknown)=>new Response(String(u).includes('ofac.treas.gov')?sdnWithout:JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32029,message:'synthetic rate limit'}})));
 await expect(handleTransactionRisk({transaction:TX_HASH})).rejects.toMatchObject({status:502,code:'RPC_QUORUM_UNREACHABLE'});
});
