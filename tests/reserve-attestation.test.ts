import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/reserve-attestation-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleReserveAttestation, parseRoundData } from "../src/handlers/reserveAttestation";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real eth_call bodies for the WBTC PoR proxy, retrieved 2026-11-23 from
// two independent legs; they agree exactly (answer 116144.74510048 WBTC,
// updatedAt 1795338491, decimals 8).
const roundBlast = readFileSync(join(__dirname, "fixtures/reserve-attestation/wbtc-round-blastapi.json"), "utf8");
const roundDrpc = readFileSync(join(__dirname, "fixtures/reserve-attestation/wbtc-round-drpc.json"), "utf8");
const decBody = readFileSync(join(__dirname, "fixtures/reserve-attestation/wbtc-decimals-blastapi.json"), "utf8");
function stub(opts: { round?: string; dec?: string; down?: boolean; emptyRound?: boolean } = {}): void {
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
    if (opts.down) throw new Error("rpc outage");
    const data = JSON.parse(String(init?.body ?? "{}")).params?.[0]?.data;
    if (data === "0x313ce567") return new Response(opts.dec ?? decBody, { status: 200 });
    if (opts.emptyRound) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 });
    return new Response(opts.round ?? roundBlast, { status: 200 });
  });
}
describe("ASSET_RESERVE_ATTESTATION_GENERAL", () => {
  it("requires a probed-live PoR asset; stETH is refused, not served wrong", async () => {
    await expect(handleReserveAttestation({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    stub();
    await expect(handleReserveAttestation({ asset: "stETH" })).rejects.toMatchObject({ status: 422, code: "UNSUPPORTED_ASSET" });
    await expect(handleReserveAttestation({ asset: "DOGE" })).rejects.toMatchObject({ status: 422, code: "UNSUPPORTED_ASSET" });
  });
  it("parses the real round body", () => {
    const d = parseRoundData(JSON.parse(roundBlast).result);
    expect(d.answer).toBe(11614474510048n);
    expect(d.updatedAt).toBe(1795338491);
  });
  it("serves the WBTC attestation in micro-units with age and source named", async () => {
    stub();
    const result = await handleReserveAttestation({ asset: "wbtc" });
    expect(result.attested_reserve).toBe(116144745100); // answer / 100 (8 decimals -> micro)
    const ans = String(result.answer);
    expect(ans).toContain("Chainlink WBTC Proof of Reserves");
    expect(ans).toContain("not an independent audit");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("ASSET_RESERVE_ATTESTATION_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("micro_remainder");
  });
  it("an RPC outage and an empty feed answer both fail closed", async () => {
    stub({ down: true });
    await expect(handleReserveAttestation({ asset: "WBTC" })).rejects.toMatchObject({ status: 502, code: "RPC_QUORUM_UNREACHABLE" });
    vi.unstubAllGlobals();
    stub({ emptyRound: true });
    await expect(handleReserveAttestation({ asset: "WBTC" })).rejects.toMatchObject({ status: 502, code: "FEED_UNREADABLE" });
  });
  it("GET /v1/reserve-attestation is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/reserve-attestation" })).toBe(true);
    await app.close();
  });
});
