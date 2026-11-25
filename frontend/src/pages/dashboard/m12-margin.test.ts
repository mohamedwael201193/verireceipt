// Mission 12 "Hashprice Margin Allocation" preset.
// Three live checks: BTC hashprice (weekly measured basis at the current
// tip), BTC USD spot and the CAISO grid LMP. With a user-typed fleet J/TH
// the estimated margin (hashprice revenue − LMP power cost) yields RUN or
// CURTAIL; without one the outcome is VERIFIED data only (QA-03 mirror: no
// silent default drives an operational outcome). Unverified inputs are
// HOLD. The margin is an allocation screen from live measured inputs,
// never a dispatch order; no real energy is dispatched.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getCryptoPrice, getMiningHashprice } from "../../lib/api";
import { DESK_PRESETS, parseJoulesPerTh, type DeskCheckResult } from "./presets";
import { toLiveReceipt } from "./utils";

const HP_RECEIPT = {
  receipt_id: "rcpt_M12H000000000000000001",
  intent: "MINING_HASHPRICE_VERIFY_GENERAL",
  upstream_url: "https://mempool.space/api/v1/mining/hashrate/1w",
  raw_response_sha256: "d".repeat(64),
  quorum_votes: "mempool.space measured series + Coinbase spot; disclosed computation",
  fetched_at: "2026-11-25T03:31:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M12H000000000000000001",
};

const BTC_RECEIPT = {
  receipt_id: "rcpt_M12B000000000000000001",
  intent: "CRYPTO_PRICE_USD",
  upstream_url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
  raw_response_sha256: "e".repeat(64),
  quorum_votes: "Coinbase public spot",
  fetched_at: "2026-11-25T03:31:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_M12B000000000000000001",
};

const GRID_RECEIPT = {
  receipt_id: "rcpt_01NNDK8NZUJJ8D5J10M4KSYUMW",
  intent: "GRID_POWER_PRICE_GENERAL",
  upstream_url: "https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP&market_run_id=DAM&node=TH_NP15_GEN-APND&resultformat=6",
  raw_response_sha256: "c4e21aade1e5877c3252d168cc9bcc0c161a2e632af46873f9b4bb1bf12850b3",
  quorum_votes: "1/1 cache row from verified ISO feed",
  fetched_at: "2026-11-25T03:28:43.865Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_01NNDK8NZUJJ8D5J10M4KSYUMW",
};

function preset(id: string) {
  const p = DESK_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p;
}

function verified(intent: string, url: string, body: Record<string, unknown>, rcpt: typeof HP_RECEIPT): DeskCheckResult {
  const full = { ...body, receipt: rcpt };
  const receipt = toLiveReceipt(intent, "q", url, { ok: true, body: full, receipt: rcpt, latencyMs: 5, ledgerGenAtStart: 0 });
  return { check: { label: "x", intent, query: "q", requestUrl: url, run: async () => { throw new Error("unused"); } }, receipt };
}

function refused(intent: string, url: string): DeskCheckResult {
  const receipt = toLiveReceipt(intent, "q", url, {
    ok: false,
    body: { error: "x", message: "refused" },
    latencyMs: 5,
    status: 503,
    errorCode: "UPSTREAM_UNAVAILABLE",
    errorMessage: "refused",
  });
  return { check: { label: "x", intent, query: "q", requestUrl: url, run: async () => { throw new Error("unused"); } }, receipt };
}

// Hashprice and grid shapes checked live 2026-11-25 03:31-03:32 UTC
// (unbilled probes). The BTC spot figure is a unit fixture, not a live
// observation.
const HP_BODY = { hashprice_sats_per_ph_day: 43542.84, block_height: 977460, hashrate_eh_s: 1040.7, hashprice_usd_per_ph_day: 42.24, verdict: "verified", confidence: 0.85 };
const BTC_BODY = { symbol: "BTC", price_usd: 97000, quote_currency: "USD", verdict: "verified", confidence: 0.9 };
const GRID_BODY = { lmp_usd_per_mwh: 61.52711, node_or_zone: "TH_NP15_GEN-APND", market: "CAISO", interval_start: "2026-11-25T00:00:00.000Z", currency: "USD", verdict: "verified", confidence: 1 };

const HP_URL = "https://verireceipt.onrender.com/v1/mining-hashprice";
const BTC_URL = "https://verireceipt.onrender.com/v1/crypto-price?symbol=BTC";
const G_URL = "https://verireceipt.onrender.com/v1/grid-price?node_or_zone=TH_NP15_GEN-APND&interval_start=2026-11-25T00%3A00%3A00.000Z";

const okHashprice = () => verified("MINING_HASHPRICE_VERIFY_GENERAL", HP_URL, HP_BODY, HP_RECEIPT);
const okSpot = () => verified("CRYPTO_PRICE_USD", BTC_URL, BTC_BODY, BTC_RECEIPT);
const okGrid = (lmp = 61.52711) => verified("GRID_POWER_PRICE_GENERAL", G_URL, { ...GRID_BODY, lmp_usd_per_mwh: lmp }, GRID_RECEIPT);

const WITH_JTH = { entity: "Bitcoin mining fleet", ref: "TH_NP15_GEN-APND", scope: "2026-11-25T00:00:00.000Z · J/TH 25" };

describe("M12 hashprice margin allocation preset", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds three checks with the right intents and wire params", () => {
    const p = preset("m12-margin");
    const checks = p.buildChecks(p.inputs);
    expect(checks).toHaveLength(3);
    const [hp, btc, grid] = checks;
    expect(hp.intent).toBe("MINING_HASHPRICE_VERIFY_GENERAL");
    expect(hp.requestUrl).toBe("https://verireceipt.onrender.com/v1/mining-hashprice");
    expect(btc.intent).toBe("CRYPTO_PRICE_USD");
    expect(new URL(btc.requestUrl).searchParams.get("symbol")).toBe("BTC");
    expect(grid.intent).toBe("GRID_POWER_PRICE_GENERAL");
    expect(new URL(grid.requestUrl).searchParams.get("node_or_zone")).toBe("TH_NP15_GEN-APND");
  });

  it("ships no fleet J/TH default — no margin decision until the user types one", () => {
    expect(preset("m12-margin").inputs.scope).toContain("no fleet J/TH");
    const out = preset("m12-margin").evaluate([okHashprice(), okSpot(), okGrid()], preset("m12-margin").inputs);
    expect(out.verdict).toBe("VERIFIED");
    expect(out.headline).toContain("no margin decision");
  });

  it("RUNs when the estimated margin is positive", () => {
    // Revenue 43542.84 * 97000 / 1e8 = 42.2365548; power 61.52711 * 25 * 0.024 = 36.916266.
    const out = preset("m12-margin").evaluate([okHashprice(), okSpot(), okGrid()], WITH_JTH);
    expect(out.verdict).toBe("RUN");
    expect(out.headline).toContain("never a dispatch order");
    expect(out.headline).toContain("no real energy is dispatched");
  });

  it("CURTAILs when the estimated margin is negative", () => {
    const out = preset("m12-margin").evaluate([okHashprice(), okSpot(), okGrid(100)], WITH_JTH);
    expect(out.verdict).toBe("CURTAIL");
  });

  it("a negative-price hour widens the estimated margin, never a failed check", () => {
    const out = preset("m12-margin").evaluate([okHashprice(), okSpot(), okGrid(-10)], WITH_JTH);
    expect(out.verdict).toBe("RUN");
    expect(out.why[2].ok).toBe(true);
    expect(out.why[2].v).toContain("-");
  });

  it("HOLDs when any live input does not verify", () => {
    expect(preset("m12-margin").evaluate([refused("MINING_HASHPRICE_VERIFY_GENERAL", HP_URL), okSpot(), okGrid()], WITH_JTH).verdict).toBe("HOLD");
    expect(preset("m12-margin").evaluate([okHashprice(), refused("CRYPTO_PRICE_USD", BTC_URL), okGrid()], WITH_JTH).verdict).toBe("HOLD");
    expect(preset("m12-margin").evaluate([okHashprice(), okSpot(), refused("GRID_POWER_PRICE_GENERAL", G_URL)], WITH_JTH).verdict).toBe("HOLD");
  });

  it("run() wires the paramless hashprice call and the BTC symbol", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return Response.json({ error: "unit" }, { status: 503 });
    });
    const checks = preset("m12-margin").buildChecks(preset("m12-margin").inputs);
    await Promise.allSettled(checks.map((c) => c.run()));
    expect(seen.some((u) => u.includes("/v1/mining-hashprice"))).toBe(true);
    expect(seen.some((u) => u.includes("/v1/crypto-price") && u.includes("symbol=BTC"))).toBe(true);
    expect(seen.some((u) => u.includes("/v1/grid-price") && u.includes("TH_NP15_GEN-APND"))).toBe(true);
  });

  it("parses the fleet efficiency only from an explicit positive J/TH", () => {
    expect(parseJoulesPerTh("2026-11-25T00:00:00.000Z · J/TH 25")).toBe(25);
    expect(parseJoulesPerTh("j/th 19.5")).toBe(19.5);
    expect(parseJoulesPerTh("no fleet J/TH")).toBe(null);
    expect(parseJoulesPerTh("J/TH 0")).toBe(null);
    expect(parseJoulesPerTh("J/TH abc")).toBe(null);
  });

  it("exposes the live clients", () => {
    expect(typeof getMiningHashprice).toBe("function");
    expect(typeof getCryptoPrice).toBe("function");
  });
});
