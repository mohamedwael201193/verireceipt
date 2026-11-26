import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const dir = mkdtempSync("/tmp/gas-chains-added-");
process.env.SQLITE_PATH = join(dir, "receipts.sqlite");
import { handleGasPrice } from "../src/handlers/gasPrice";
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

const RPCS: Record<string, string[]> = {
  linea: ["https://rpc.linea.build", "https://1rpc.io/linea", "https://linea-rpc.publicnode.com"],
  scroll: ["https://rpc.scroll.io", "https://scroll.drpc.org", "https://1rpc.io/scroll"],
  "zksync-era": ["https://mainnet.era.zksync.io", "https://zksync.drpc.org", "https://1rpc.io/zksync2-era"],
  mantle: ["https://rpc.mantle.xyz", "https://mantle.drpc.org", "https://mantle-rpc.publicnode.com"],
};
/** Serves eth_gasPrice per URL (value hex), a Coinbase spot, and fails every other RPC method. */
function stub(values: Record<string, string>, requested: string[] = []) {
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
    const u = String(url); requested.push(u);
    if (u.includes("api.coinbase.com")) return new Response(JSON.stringify({ data: { base: "ETH", currency: "USD", amount: "3000" } }));
    const body = JSON.parse(init?.body ?? "{}");
    if (body.method !== "eth_gasPrice") throw new Error("not served in this stub");
    const v = values[u]; if (!v) throw new Error("down");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: v }));
  });
}
const same = (chain: string, v: string) => Object.fromEntries(RPCS[chain].map(u => [u, v]));

describe("added gas chains", () => {
  it.each(Object.keys(RPCS).filter(c => c !== "mantle"))("%s serves its own 3-source quorum with a USD fee", async chain => {
    const req: string[] = []; stub(same(chain, "0x3b9aca00"), req);
    const r = await handleGasPrice({ chain });
    expect(r).toMatchObject({ chain, gas_price_gwei: 1, transfer_fee_usd: 0.063 });
    expect(String(r.answer)).toContain(`on ${chain}`); expect(String(r.answer)).toContain("3/3 sources agreed");
    expect(req.filter(u => !u.includes("coinbase")).every(u => RPCS[chain].includes(u))).toBe(true);
    expect(req.some(u => RPCS[chain].includes(u))).toBe(true);
  });
  it("mantle serves gas_price_gwei but no USD fee and says so", async () => {
    stub(same("mantle", "0x3b9aca00"));
    const r = await handleGasPrice({ chain: "mantle" });
    expect(r).toMatchObject({ chain: "mantle", gas_price_gwei: 1, transfer_fee_usd: null });
    expect(String(r.transfer_fee_usd_reason)).toContain("MNT");
    expect(String(r.answer)).toContain("USD transfer fee not given");
    expect(String(r.answer)).not.toContain("$null");
  });
  it("2-of-3 agreement serves the agreeing value on a new chain, a 3-way split refuses 502", async () => {
    const [a, b, c] = RPCS.linea;
    stub({ [a]: "0x3b9aca00", [b]: "0x3b9aca00", [c]: "0x77359400" });
    expect(await handleGasPrice({ chain: "linea" })).toMatchObject({ gas_price_gwei: 1 });
    stub({ [a]: "0x3b9aca00", [b]: "0x77359400", [c]: "0xb2d05e00" });
    await expect(handleGasPrice({ chain: "linea" })).rejects.toMatchObject({ status: 502, code: "QUORUM_DISAGREEMENT" });
  });
  it.each([
    ["optimism mainnet", "optimism"], ["op mainnet", "optimism"], ["OP", "optimism"], ["arbitrum one", "arbitrum"],
    ["base mainnet", "base"], ["ethereum mainnet", "ethereum"], ["mainnet", "ethereum"], ["eth", "ethereum"],
    ["matic", "polygon"], ["bnb", "bsc"], ["BNB Smart Chain", "bsc"], ["zkSync Era", "zksync-era"], ["zksync", "zksync-era"],
    ["Linea Mainnet", "linea"], ["scroll mainnet", "scroll"], ["mantle mainnet", "mantle"],
  ])("alias %s resolves to %s", async (alias, chain) => {
    vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes("api.coinbase.com")) return new Response(JSON.stringify({ data: { base: "X", currency: "USD", amount: "3000" } }));
      const body = JSON.parse(init?.body ?? "{}");
      if (body.method !== "eth_gasPrice") throw new Error("x");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x3b9aca00" }));
    });
    expect((await handleGasPrice({ chain: alias })).chain).toBe(chain);
  });
  it.each(["celo", "gnosis", "blast", "solana", "Solana", "sui", "bitcoin", "base-goerli", "eip155:42220"])("%s is refused 422 CHAIN_NOT_SERVED with no fetch and no substituted data", async chain => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const e: any = await handleGasPrice({ chain }).catch(e => e);
    expect(e).toMatchObject({ status: 422, code: "CHAIN_NOT_SERVED" });
    expect(String(e.message)).toContain("linea"); expect(String(e.message)).toContain("mantle"); expect(String(e.message)).toContain("not served");
    expect(f).not.toHaveBeenCalled();
  });
  it("a hostile chain value is not echoed", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const e: any = await handleGasPrice({ chain: "x\n<script>" + "y".repeat(100) }).catch(e => e);
    expect(e.code).toBe("CHAIN_NOT_SERVED"); expect(String(e.message)).not.toContain("script"); expect(String(e.message)).toContain("the requested chain");
  });
  it("a named unserved chain is never the ethereum default; empty stays the disclosed default", async () => {
    stub({}); await expect(handleGasPrice({ chain: "solana" })).rejects.toMatchObject({ status: 422 });
    vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
      const u = String(url); if (u.includes("coinbase")) return new Response(JSON.stringify({ data: { amount: "3000" } }));
      const body = JSON.parse(init?.body ?? "{}"); if (body.method !== "eth_gasPrice") throw new Error("x");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x3b9aca00" }));
    });
    expect(await handleGasPrice({ chain: "" })).toMatchObject({ chain: "ethereum" });
  });
});
