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
function stub(opts: { round?: string; dec?: string; down?: boolean; emptyRound?: boolean; supplyDown?: boolean; supplyDecimals?: string } = {}): void {
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
    if (opts.down) throw new Error("rpc outage");
    const call = JSON.parse(String(init?.body ?? "{}")).params?.[0];
    const data = call?.data;
    if (call?.to?.toLowerCase() === "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599") {
      if (opts.supplyDown) throw new Error("sensitive upstream token error");
      return new Response(data === "0x18160ddd"
        ? readFileSync(join(__dirname, "fixtures/reserve-attestation/wbtc-supply-blast.json"), "utf8")
        : opts.supplyDecimals ?? decBody);
    }
    if (data === "0x313ce567") return new Response(opts.dec ?? decBody, { status: 200 });
    if (opts.emptyRound) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 });
    return new Response(opts.round ?? roundBlast, { status: 200 });
  });
}
describe("ASSET_RESERVE_ATTESTATION_GENERAL", () => {
  it("requires an asset and discloses coverage-only unknown responses", async () => {
    await expect(handleReserveAttestation({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    stub();
    expect(await handleReserveAttestation({ asset: "stETH" })).toMatchObject({ attested_reserve: null, verdict: "unavailable" });
    expect(await handleReserveAttestation({ asset: "DOGE" })).toMatchObject({ attested_reserve: null, verdict: "unavailable" });
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


describe("reserve supply scope from actual RPC bodies", () => {
  it("leads with human reserve and compares only to Ethereum supply without a global ratio", async () => {
    stub();
    const out = await handleReserveAttestation({ asset: "WBTC" });
    expect(out.ethereum_total_supply).toBe(116381.88357262);
    expect(out.reserve_vs_ethereum_supply_pct).toBeCloseTo(116144.74510048 / 116381.88357262 * 100, 8);
    expect(out.collateral_ratio_pct).toBeNull();
    expect(out.answer).toContain("not a global collateral ratio");
    expect(out.answer).toContain("other native chains are excluded");
    expect(String(out.answer).indexOf("116,144.74510048")).toBeLessThan(String(out.answer).indexOf("micro-units"));
    expect(out.updated_at).toBe(new Date(1795338491 * 1000).toISOString());
    expect(out.heartbeat_seconds).toBe(86400);
    const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    expect(sha256Hex(stored.evidence!)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("raw_supply");
  });
  it("keeps the reserve but does not invent supply or ratio on supply quorum failure", async () => {
    stub({ supplyDown: true }); const out = await handleReserveAttestation({ asset: "WBTC" });
    expect(out.attested_reserve).toBe(116144745100); expect(out.ethereum_total_supply).toBeNull();
    expect(out.reserve_vs_ethereum_supply_pct).toBeNull(); expect(out.answer).toContain("supply unavailable");
    expect(JSON.stringify(out)).not.toContain("sensitive upstream");
  });
  it("rejects wrong token decimals as unavailable rather than scaling a false supply", async () => {
    stub({ supplyDecimals: JSON.stringify({ result: "0x" + "12".padStart(64, "0") }) });
    expect((await handleReserveAttestation({ asset: "WBTC" })).ethereum_total_supply).toBeNull();
  });
  it("unknown inherited property names never select a feed", async () => {
    expect((await handleReserveAttestation({ asset: "constructor" })).attested_reserve).toBeNull();
  });
});


describe("all enabled token bindings from two live RPC captures", () => {
  it.each([
    ["WBTC", "wbtc", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", 8],
    ["cbBTC", "cbbtc", "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", 8],
    ["TUSD", "tusd", "0x0000000000085d4780b73119b644ae5ecd22b376", 18],
  ] as const)("binds %s supply to the verified token and decimals", async (asset, file, token, decimals) => {
    const raw = (name: string, leg: string) => readFileSync(join(__dirname, `fixtures/reserve-attestation/${file}-${name}-${leg}.json`), "utf8");
    expect(JSON.parse(raw("supply", "blast")).result).toBe(JSON.parse(raw("supply", "drpc")).result);
    vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
      const leg = String(url).includes("drpc") ? "drpc" : "blast";
      const call = JSON.parse(String(init?.body)).params[0];
      if (call.to.toLowerCase() === token) return new Response(raw(call.data === "0x18160ddd" ? "supply" : "token-decimals", leg));
      if (call.data === "0xfeaf968c") return new Response(raw("round", leg + "-supply-slice"));
      return new Response(readFileSync(join(__dirname, `fixtures/reserve-attestation/${file}-feed-decimals-supply-slice.json`), "utf8"));
    });
    const out = await handleReserveAttestation({ asset });
    const expected = Number(BigInt(JSON.parse(raw("supply", "blast")).result)) / 10 ** decimals;
    expect(out.ethereum_total_supply).toBe(expected);
    expect(out.reserve_vs_ethereum_supply_pct).toBeCloseTo(Number(out.reserve_units) / expected * 100, 8);
    expect(out.collateral_ratio_pct).toBeNull();
  });
});
