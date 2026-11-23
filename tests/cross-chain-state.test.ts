import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/cross-chain-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleCrossChainState } from "../src/handlers/crossChainState";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real mainnet receipt body retrieved 2026-11-23 (shared with crypto-transfer).
const receiptResult = JSON.parse(readFileSync(join(__dirname, "fixtures/crypto-transfer/eth-usdc-transfer-receipt.json"), "utf8"));
const TX_HASH = "0x345f9637c8610b24b8b9a5a030a12f3f439c112b8c340ff0c8a4a764c7ae4a63";
function rpcBody(result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result });
}
type Opts = { eth?: "found" | "notfound" | "down"; polygon?: "found" | "notfound" | "down" };
function stub(opts: Opts = {}): void {
  const eth = opts.eth ?? "found";
  const polygon = opts.polygon ?? "notfound";
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    const isPolygon = u.includes("polygon");
    const mode = isPolygon ? polygon : eth;
    if (mode === "down") throw new Error("rpc outage");
    return new Response(rpcBody(mode === "found" ? receiptResult : null), { status: 200 });
  });
}
describe("CROSS_CHAIN_STATE_VERIFY_GENERAL", () => {
  it("validates the reference and the chain list", async () => {
    await expect(handleCrossChainState({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleCrossChainState({ reference: "abc", chains: "ethereum,base" })).rejects.toMatchObject({ status: 400, code: "INVALID_REFERENCE" });
    await expect(handleCrossChainState({ reference: TX_HASH, chains: "ethereum" })).rejects.toMatchObject({ status: 400, code: "TOO_FEW_CHAINS" });
    await expect(handleCrossChainState({ reference: TX_HASH, chains: "ethereum,solana" })).rejects.toMatchObject({ status: 400, code: "UNSUPPORTED_CHAIN" });
  });
  it("present on one chain and absent on the other is NOT consistent, no bridge claim", async () => {
    stub();
    const result = await handleCrossChainState({ reference: TX_HASH, chains: "ethereum,polygon" });
    expect(result.consistent).toBe(false);
    const ans = String(result.answer);
    expect(ans).toContain("NOT consistent");
    expect(ans).toContain("does NOT verify or refute a bridge transfer");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("CROSS_CHAIN_STATE_VERIFY_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("narrowing");
  });
  it("present with success on one chain and reverted on the other is NOT consistent", async () => {
    const reverted = { ...receiptResult, status: "0x0" };
    vi.stubGlobal("fetch", async (url: unknown) => {
      const isPolygon = String(url).includes("polygon");
      return new Response(rpcBody(isPolygon ? reverted : receiptResult), { status: 200 });
    });
    const result = await handleCrossChainState({ reference: TX_HASH, chains: "ethereum,polygon" });
    expect(result.consistent).toBe(false);
    const ans = String(result.answer);
    expect(ans).toContain("NOT consistent");
    expect(ans).toContain("reverted");
  });
  it("a pre-Byzantium root-only receipt follows the effectiveStatus doctrine, never a default success", async () => {
    const preByzantium = { ...receiptResult } as Record<string, unknown>;
    delete preByzantium.status;
    preByzantium.root = "0x" + "ab".repeat(32);
    const broken = { ...receiptResult } as Record<string, unknown>;
    delete broken.status;
    delete broken.root;
    vi.stubGlobal("fetch", async (url: unknown) => {
      const isPolygon = String(url).includes("polygon");
      return new Response(rpcBody(isPolygon ? broken : preByzantium), { status: 200 });
    });
    const result = await handleCrossChainState({ reference: TX_HASH, chains: "ethereum,polygon" });
    // root-only means success; neither field means failure, so these differ.
    expect(result.consistent).toBe(false);
    const stored = await getReceiptEvidence(String((result.receipt as { receipt_id: string }).receipt_id));
    if (!stored.evidence) throw new Error("missing evidence");
    const perChain = (JSON.parse(String(stored.evidence)).per_chain ?? []) as { chain: string; status: number }[];
    expect(perChain.find((c) => c.chain === "ethereum")?.status).toBe(1);
    expect(perChain.find((c) => c.chain === "polygon")?.status).toBe(0);
  });
  it("present with the same status on both chains is consistent", async () => {
    stub({ polygon: "found" });
    const result = await handleCrossChainState({ reference: TX_HASH, chains: "ethereum,polygon" });
    expect(result.consistent).toBe(true);
    expect(String(result.answer)).toContain("does NOT verify any bridge transfer");
  });
  it("uniformly absent is consistent and says so", async () => {
    stub({ eth: "notfound" });
    const result = await handleCrossChainState({ reference: TX_HASH, chains: "ethereum,polygon" });
    expect(result.consistent).toBe(true);
    expect(String(result.answer)).toContain("absent");
  });
  it("one chain's quorum down fails closed, never a partial consistency claim", async () => {
    stub({ polygon: "down" });
    await expect(handleCrossChainState({ reference: TX_HASH, chains: "ethereum,polygon" })).rejects.toMatchObject({ status: 502, code: "RPC_QUORUM_UNREACHABLE" });
  });
  it("GET /v1/cross-chain-state is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/cross-chain-state" })).toBe(true);
    await app.close();
  });
});
