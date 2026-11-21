import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOND_INTENT_COUNT,
  BOND_REGISTRATION_ID,
  MINER_BOND_BASE_UNITS,
  MINER_BOND_USD,
  MINER_BOND_USD_TEXT,
  SEL_MINER_BOND,
  SEL_QUOTE_MINER_BOND,
  SEPOLIA_RPC,
  bondForIntents,
  fetchLiveMinerBond,
  formatUsdcBaseUnits,
} from "./minerBond";
import { SEPOLIA_REGISTRATION_ID } from "./minerRegistration";
import { BOND_DISPLAY } from "../config";
import { MINER_BOND_USDC } from "./constants";
import { MINER_BOND_USDC as DASH_BOND } from "../pages/dashboard/utils";
import { SPRINT_STEPS } from "../pages/landing/data";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");

describe("miner bond (single source)", () => {
  it("is the on-chain 6152 bond for six intents: 1,500,000 = $1.50", () => {
    expect(BOND_REGISTRATION_ID).toBe(SEPOLIA_REGISTRATION_ID);
    expect(BOND_INTENT_COUNT).toBe(6);
    expect(MINER_BOND_BASE_UNITS).toBe(1_500_000);
    expect(MINER_BOND_USD).toBe(1.5);
    expect(MINER_BOND_USD_TEXT).toBe("$1.50");
  });

  it("reproduces quoteMinerBond(n) as read on-chain 2026-11-21", () => {
    // live: n=1 1000000, 2 1100000, 3 1200000, 6 1500000, 9 1800000, 10 1870000, 12 2010000
    const live: Array<[number, number]> = [
      [1, 1_000_000], [2, 1_100_000], [3, 1_200_000], [6, 1_500_000], [9, 1_800_000], [10, 1_870_000], [12, 2_010_000],
    ];
    for (const [n, v] of live) expect(bondForIntents(n)).toBe(v);
    expect(bondForIntents(BOND_INTENT_COUNT)).toBe(MINER_BOND_BASE_UNITS);
    expect(() => bondForIntents(0)).toThrow(RangeError);
  });

  it("formats base units exactly", () => {
    expect(formatUsdcBaseUnits(1_500_000)).toBe("$1.50");
    expect(formatUsdcBaseUnits(1_870_000)).toBe("$1.87");
    expect(formatUsdcBaseUnits(BigInt(2_010_000))).toBe("$2.01");
    expect(formatUsdcBaseUnits(0)).toBe("$0.00");
  });

  it("every display derives from it (no stale $1.40)", () => {
    expect(BOND_DISPLAY).toBe("$1.50 Test USDC Bond");
    expect(MINER_BOND_USDC).toBe(1.5);
    expect(DASH_BOND).toBe("$1.50 Test USDC");
    const plan = SPRINT_STEPS.map((s) => s.g2).join("\n");
    expect(plan).toContain("$1.50 Test USDC bond");
    expect(plan).not.toContain("$1.40");
  });

  it("uses the correct selectors", () => {
    // cast sig "minerBond(uint256)" / "quoteMinerBond(uint256)"
    expect(SEL_MINER_BOND).toBe("0x692030d4");
    expect(SEL_QUOTE_MINER_BOND).toBe("0xc17a8722");
  });
});

describe("fetchLiveMinerBond", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads minerBond(6152) and quoteMinerBond(6) and reports a match", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe(SEPOLIA_RPC);
        const body = JSON.parse(String(init.body));
        calls.push(body.params[0].data);
        expect(body.params[0].to).toBe("0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b");
        const out = body.params[0].data.startsWith(SEL_QUOTE_MINER_BOND) ? word(1_500_000) + word(1_500_000).slice(2) : word(1_500_000);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: out }), { status: 200 });
      }),
    );
    const r = await fetchLiveMinerBond();
    expect(r.registrationBond).toBe(BigInt(1_500_000));
    expect(r.quoteForIntents).toBe(BigInt(1_500_000));
    expect(r.matchesConstant).toBe(true);
    expect(calls.sort()).toEqual(
      [SEL_MINER_BOND + (6152).toString(16).padStart(64, "0"), SEL_QUOTE_MINER_BOND + (6).toString(16).padStart(64, "0")].sort(),
    );
  });

  it("surfaces a mismatch instead of hiding it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: word(1_400_000) }), { status: 200 })));
    const r = await fetchLiveMinerBond();
    expect(r.matchesConstant).toBe(false);
    expect(formatUsdcBaseUnits(r.registrationBond)).toBe("$1.40");
  });

  it("throws on RPC error / empty result (caller shows UNVERIFIED)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 200 })));
    await expect(fetchLiveMinerBond()).rejects.toThrow(/boom/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "0x" }), { status: 200 })));
    await expect(fetchLiveMinerBond()).rejects.toThrow(/no uint256/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 502 })));
    await expect(fetchLiveMinerBond()).rejects.toThrow(/HTTP 502/);
  });
});
