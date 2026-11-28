// WLD (Worldcoin): ethereum is the canonical home chain, optimism is a second listing.
// Fixtures tests/fixtures/token-chain-supply/wld-{ethereum,optimism}-finalized.json hold the
// real eth_call responses captured from each chain's three RPC legs at "finalized".

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "supply-wld-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");
afterAll(() => { rmSync(SCRATCH_DIR, { recursive: true, force: true }); });

import { ApiError } from "../src/core/errors";
import { CHAIN_RPCS } from "../src/config/chains";
import { handleTokenSupply } from "../src/handlers/tokenSupply";
import { TOKEN_CONTRACTS, tokenContractFor, canonicalHomeChain } from "../src/handlers/tokenContracts";
import { getReceiptEvidence } from "../src/core/storage";

const WLD_ETH = "0x163f8C2467924be0ae7B5347228CABF260318753";
const WLD_OP = "0xdC6fF44d5d932Cbd77B52E5612Ba0529DC6226F1";
const load = (chain: string) => JSON.parse(readFileSync(join(__dirname, `fixtures/token-chain-supply/wld-${chain}-finalized.json`), "utf8"));
const captures: Record<string, any> = { ethereum: load("ethereum"), optimism: load("optimism") };

afterEach(() => { vi.unstubAllGlobals(); });

function stubCapture(capture: any): void {
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: unknown }) => {
    const leg = capture.legs.find((l: any) => l.url === String(url));
    if (!leg) throw new Error(`unexpected fetch to ${String(url)}`);
    const req = JSON.parse(String(init?.body));
    expect(req.params[0].to.toLowerCase()).toBe(capture.token.toLowerCase());
    const r = leg.responses.find((x: any) => x.request.params[0].data === req.params[0].data);
    return new Response(r.raw);
  });
}

describe("WLD registry", () => {
  it("lists WLD on ethereum and optimism only, case-insensitively", () => {
    expect(TOKEN_CONTRACTS.ethereum.WLD).toBe(WLD_ETH);
    expect(TOKEN_CONTRACTS.optimism.WLD).toBe(WLD_OP);
    for (const chain of Object.keys(TOKEN_CONTRACTS)) if (chain !== "ethereum" && chain !== "optimism") expect(TOKEN_CONTRACTS[chain].WLD).toBeUndefined();
    expect(tokenContractFor("ethereum", "wld")).toBe(WLD_ETH);
    expect(tokenContractFor("optimism", "wld")).toBe(WLD_OP);
  });
  it("canonicalHomeChain('WLD') is ethereum", () => {
    expect(canonicalHomeChain("WLD")).toEqual({ chain: "ethereum", contract: WLD_ETH });
    expect(canonicalHomeChain("wld")).toEqual({ chain: "ethereum", contract: WLD_ETH });
  });
  it("both chains have RPC legs", () => {
    expect(CHAIN_RPCS.ethereum.length).toBeGreaterThanOrEqual(3);
    expect(CHAIN_RPCS.optimism.length).toBeGreaterThanOrEqual(3);
  });
});

describe("WLD supply (recorded finalized eth_calls)", () => {
  it("bare WLD resolves to ethereum: 10B supply with the home-chain disclosure", async () => {
    const capture = captures.ethereum;
    stubCapture(capture);
    const out = await handleTokenSupply({ token: "WLD" });
    const raw = BigInt(JSON.parse(capture.legs[0].responses[0].raw).result);
    expect(out.chain).toBe("ethereum");
    expect(out.decimals).toBe(18);
    expect(out.supply_base_units).toBe(raw.toString());
    expect(out.supply_base_units).toBe("10000000000" + "0".repeat(18));
    expect(out.total_supply).toBe(10000000000);
    expect(String(out.answer)).toContain("canonical home chain ethereum");
    const ev = await getReceiptEvidence((out.receipt as any).receipt_id);
    const parsed = JSON.parse(String(ev.evidence));
    expect(parsed.chain_resolution.resolved_chain).toBe("ethereum");
    expect(parsed.supply_base_units_hex).toBe("0x" + raw.toString(16));
  });

  it("explicit optimism returns the optimism supply with no home-chain disclosure", async () => {
    const capture = captures.optimism;
    stubCapture(capture);
    const out = await handleTokenSupply({ token: "WLD on optimism" });
    const raw = BigInt(JSON.parse(capture.legs[0].responses[0].raw).result);
    expect(out.chain).toBe("optimism");
    expect(out.supply_base_units).toBe(raw.toString());
    expect(String(out.answer)).not.toContain("canonical home chain");
  });

  it("an unrelated unknown symbol still gives the same 400 MISSING_PARAM refusal", async () => {
    try { await handleTokenSupply({ token: "ZZZQ" }); throw new Error("expected refusal"); }
    catch (e) { expect(e).toBeInstanceOf(ApiError); expect((e as ApiError).status).toBe(400); expect((e as ApiError).code).toBe("MISSING_PARAM"); }
  });
});
