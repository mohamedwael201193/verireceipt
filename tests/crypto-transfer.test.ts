import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/crypto-transfer-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleCryptoTransferVerify, findMatchingTransfer, projectReceipt } from "../src/handlers/cryptoTransferVerify";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real mainnet bodies, retrieved 2026-11-23 (block 0x193f7cd window):
// a USDC transfer of 13365780 base units, two RPC legs byte-identical.
const txResult = JSON.parse(readFileSync(join(__dirname, "fixtures/crypto-transfer/eth-usdc-transfer-tx.json"), "utf8"));
const receiptResult = JSON.parse(readFileSync(join(__dirname, "fixtures/crypto-transfer/eth-usdc-transfer-receipt.json"), "utf8"));
const TX_HASH = txResult.hash;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const T_FROM = "0x000000000004444c5dc75cb358380d2e3de08a90";
const T_TO = "0x0000000aa232009084bd71a5797d089aa4edfad4";
type Mode = "ok" | "disagree" | "notfound" | "down";
function stub(mode: Mode): void {
  let calls = 0;
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
    calls++;
    if (mode === "down") throw new Error("test outage");
    const method = JSON.parse(String(init?.body ?? "{}")).method;
    if (method === "eth_getTransactionReceipt") {
      if (mode === "notfound") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 });
      const r = mode === "disagree" && calls <= 2
        ? { ...receiptResult, logs: [] } // first leg disagrees
        : receiptResult;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: r }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: txResult }), { status: 200 });
  });
}
const base = { tx_hash: TX_HASH, chain: "ethereum" };
describe("CRYPTO_TRANSFER_VERIFY_GENERAL", () => {
  it("validates hash, chain and expectations", async () => {
    await expect(handleCryptoTransferVerify({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleCryptoTransferVerify({ tx_hash: "0x1234", chain: "ethereum" })).rejects.toMatchObject({ status: 400, code: "INVALID_TX_HASH" });
    await expect(handleCryptoTransferVerify({ tx_hash: TX_HASH, chain: "solana" })).rejects.toMatchObject({ status: 400, code: "UNSUPPORTED_CHAIN" });
    await expect(handleCryptoTransferVerify({ ...base, from: "not-an-address" })).rejects.toMatchObject({ status: 400, code: "INVALID_ADDRESS" });
    await expect(handleCryptoTransferVerify({ ...base, amount: "13.36" })).rejects.toMatchObject({ status: 400, code: "INVALID_AMOUNT" });
  });
  it("verifies the real USDC transfer with exact expectations, 3/3 legs", async () => {
    stub("ok");
    const result = await handleCryptoTransferVerify({ ...base, token: USDC, from: T_FROM, to: T_TO, amount: "13365780" });
    expect(result.verified).toBe(true);
    expect(result.legs_agreeing).toBe(3);
    const m = result.matched_transfer as { kind: string; amount_base_units: string };
    expect(m.kind).toBe("erc20");
    expect(m.amount_base_units).toBe("13365780");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("CRYPTO_TRANSFER_VERIFY_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
  });
  it("a wrong amount is verified=false, never bent to fit", async () => {
    stub("ok");
    const result = await handleCryptoTransferVerify({ ...base, token: USDC, amount: "13365781" });
    expect(result.verified).toBe(false);
    expect(String(result.answer)).toContain("NOT verified");
  });
  it("native path reads the tx value; zero-value is not a transfer", () => {
    const projection = projectReceipt(receiptResult);
    // The real tx is a contract call (value 0), so native matching is null.
    expect(findMatchingTransfer(projection, projection.to, "0x0", {})).toBeNull();
    const m = findMatchingTransfer({ ...projection, to: T_TO }, T_TO, "0xde0b6b3a7640000", { to: T_TO, amount: "1000000000000000000" });
    expect(m).toMatchObject({ kind: "native", amount_base_units: "1000000000000000000" });
  });
  it("2-of-3 agreeing legs serve after one disagrees; all-null is TX_NOT_FOUND; all-down is 502", async () => {
    stub("disagree");
    const r = await handleCryptoTransferVerify({ ...base, token: USDC });
    expect(r.verified).toBe(true);
    expect(r.legs_agreeing).toBe(2);
    vi.unstubAllGlobals();
    stub("notfound");
    await expect(handleCryptoTransferVerify({ ...base })).rejects.toMatchObject({ status: 422, code: "TX_NOT_FOUND" });
    vi.unstubAllGlobals();
    stub("down");
    await expect(handleCryptoTransferVerify({ ...base })).rejects.toMatchObject({ status: 502, code: "QUORUM_NOT_REACHED" });
  });
  it("GET /v1/crypto-transfer is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/crypto-transfer" })).toBe(true);
    await app.close();
  });
});

describe("crypto-transfer malformed log data (reviewer nit)", () => {
  it("a Transfer-topic log with empty 0x data is a typed 422, never a generic 500", () => {
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const projection = {
      status: 1,
      from: T_FROM.toLowerCase(), to: T_TO.toLowerCase(),
      logs: [{
        address: USDC.toLowerCase(),
        topics: [TRANSFER_TOPIC, `0x${"0".repeat(24)}${T_FROM.slice(2)}`, `0x${"0".repeat(24)}${T_TO.slice(2)}`],
        data: "0x",
      }],
    };
    expect(() => findMatchingTransfer(projection, T_TO.toLowerCase(), "0x0", { token: USDC }))
      .toThrowError(expect.objectContaining({ status: 422, code: "MALFORMED_LOG" }));
  });
});

function stubLegs(change: (tx: any, receipt: any, leg: number) => void): void {
  let leg = -1;
  let current: any;
  vi.stubGlobal('fetch', async (_url: unknown, init?: {body?: string}) => {
    const method = JSON.parse(String(init?.body)).method;
    if (method === 'eth_getTransactionReceipt') {
      leg++;
      current = {tx: structuredClone(txResult), receipt: structuredClone(receiptResult)};
      change(current.tx, current.receipt, leg);
      return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:current.receipt}));
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:current.tx}));
  });
}
describe('transaction identity/value quorum and canonical ERC-20 encoding', () => {
  it('native amount from one leg cannot borrow a receipt quorum of three', async () => {
    stubLegs((tx, _r, leg) => {tx.value = leg === 0 ? '0x1' : '0x2';});
    const result = await handleCryptoTransferVerify({...base,amount:'1'});
    expect(result.verified).toBe(false);
    expect(result.legs_agreeing).toBe(2);
    stubLegs((tx, _r, leg) => {tx.value = leg === 0 ? '0x1' : '0x2';});
    const agreed = await handleCryptoTransferVerify({...base,amount:'2'});
    expect(agreed.verified).toBe(true);
    expect(agreed.matched_transfer).toMatchObject({amount_base_units:'2'});
    const receipt = agreed.receipt as {receipt_id:string};
    const stored = await getReceiptEvidence(receipt.receipt_id);
    const evidence = JSON.parse(stored.evidence!);
    expect(evidence.agreeing_legs).toHaveLength(2);
    for (const leg of evidence.agreeing_legs) {
      expect(JSON.parse(leg.raw_bodies[1]).result.value).toBe('0x2');
      expect(JSON.parse(leg.raw_bodies[0]).result.transactionHash).toBe(TX_HASH);
    }
  });
  it('all-distinct native values fail quorum', async () => {
    stubLegs((tx,_r,leg) => {tx.value = '0x'+(leg+1);});
    await expect(handleCryptoTransferVerify(base)).rejects.toMatchObject({code:'QUORUM_NOT_REACHED'});
  });
  it.each(['hash','blockHash','blockNumber','from','to','value','status'])('invalid transaction/receipt %s cannot supply an agreeing leg', async key => {
    stubLegs((tx,r) => {
      if(key==='status')r.status='0x2';
      else tx[key]=key==='value'?'0x01':key==='blockNumber'?'0x1':'0x'+'f'.repeat(key==='hash'||key==='blockHash'?64:40);
    });
    await expect(handleCryptoTransferVerify({...base,token:USDC})).rejects.toMatchObject({code:'QUORUM_NOT_REACHED'});
  });
  it('different but internally consistent block identities do not form a quorum',async()=>{
    stubLegs((tx,r,leg)=>{tx.blockHash=r.blockHash='0x'+String(leg+1).repeat(64);});
    await expect(handleCryptoTransferVerify({...base,token:USDC})).rejects.toMatchObject({code:'QUORUM_NOT_REACHED'});
  });
  it.each(['short-from','short-to','high-padding','four-topics','short-data','oversized-data'])('refuses malformed or NFT-shaped transfer logs: %s',kind=>{
    const p=projectReceipt(receiptResult);
    const log=p.logs.find(l=>l.address===USDC.toLowerCase() && l.topics[0]==='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')!;
    p.logs=[structuredClone(log)];
    if(kind==='short-from')p.logs[0].topics[1]='0xab';
    if(kind==='short-to')p.logs[0].topics[2]='0xcd';
    if(kind==='high-padding')p.logs[0].topics[1]='0x'+'f'.repeat(64);
    if(kind==='four-topics')p.logs[0].topics.push('0x'+'0'.repeat(64));
    if(kind==='short-data')p.logs[0].data='0x1';
    if(kind==='oversized-data')p.logs[0].data='0x'+'0'.repeat(128);
    expect(()=>findMatchingTransfer(p,p.to,'0x0',{token:USDC})).toThrowError(expect.objectContaining({code:'MALFORMED_LOG'}));
  });
  it('a validly encoded ERC-721 four-topic event is refused with empty data',()=>{
    const p=projectReceipt(receiptResult);const log=p.logs.find(l=>l.topics.length===3)!;
    p.logs=[{...log,address:USDC.toLowerCase(),topics:[...log.topics,'0x'+'0'.repeat(63)+'1'],data:'0x'}];
    expect(()=>findMatchingTransfer(p,p.to,'0x0',{token:USDC})).toThrowError(expect.objectContaining({code:'MALFORMED_LOG'}));
  });
});
