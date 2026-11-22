// Tests for src/handlers/currencyConvert.ts (CURRENCY_EXCHANGE_CONVERT).
// Handler paths are driven by a stubbed global fetch (all three rate
// sources); the LIVE tests at the bottom hit the real keyless APIs.
// Hermetic DB via a unique scratch SQLITE_PATH per run.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "fx-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import { sha256Hex } from "../src/core/receipt";
import { getReceiptEvidence } from "../src/core/storage";
import { AGREEMENT_TOLERANCE, INTENT, handleFx } from "../src/handlers/currencyConvert";

const SHA256_RE = /^[0-9a-f]{64}$/;

function frankfurterBody(rate: number, date = "2026-11-21"): string {
  return JSON.stringify({ amount: 1.0, base: "USD", date, rates: { EUR: rate } });
}
function openErBody(rate: number, date = "Sat, 22 Nov 2026 00:02:32 +0000"): string {
  return JSON.stringify({
    result: "success",
    time_last_update_utc: date,
    rates: { EUR: rate, EGP: 47.65 },
  });
}
function fawazBody(rate: number, date = "2026-11-21"): string {
  return JSON.stringify({ date, usd: { eur: rate, egp: 47.61 } });
}

interface StubOpts {
  frankfurter?: string | "ERR" | "HANG";
  openEr?: string | "ERR" | "HANG";
  fawaz?: string | "ERR" | "HANG";
}

/** Stub global fetch across all three FX sources. "ERR" = source down;
 * "HANG" = source never answers (the 4 s per-source budget is NOT
 * shortened in tests — the failover assertions prove a hung source
 * never delays the answer). */
function stubFxSources(opts: StubOpts): void {
  const fetchStub = (url: unknown) => {
    const u = String(url);
    const pick = (body: string | "ERR" | "HANG" | undefined, label: string): Promise<Response> => {
      if (body === "ERR") return Promise.reject(new Error(`${label} down`));
      if (body === "HANG") return new Promise<Response>(() => {});
      if (body === undefined) return Promise.reject(new Error(`unexpected fetch to ${u}`));
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    if (u.includes("frankfurter")) return pick(opts.frankfurter, "frankfurter");
    if (u.includes("open.er-api")) return pick(opts.openEr, "open.er-api");
    if (u.includes("jsdelivr")) return pick(opts.fawaz, "fawaz");
    return Promise.reject(new Error(`unexpected fetch to ${u}`));
  };
  vi.stubGlobal("fetch", fetchStub);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function expectApiError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(status);
    expect(e.code).toBe(code);
    return;
  }
  throw new Error("expected ApiError " + status + " " + code);
}

describe("handleFx validation (stubbed, no network use)", () => {
  it("missing from/to -> 400 MISSING_PARAM", async () => {
    await expectApiError(handleFx({}), 400, "MISSING_PARAM");
    await expectApiError(handleFx({ from_currency: "USD" }), 400, "MISSING_PARAM");
    await expectApiError(handleFx({ to_currency: "EUR" }), 400, "MISSING_PARAM");
  });

  it("non-ISO codes -> 400 INVALID_CURRENCY", async () => {
    await expectApiError(handleFx({ from_currency: "US", to_currency: "EUR" }), 400, "INVALID_CURRENCY");
    await expectApiError(handleFx({ from_currency: "USD1", to_currency: "EUR" }), 400, "INVALID_CURRENCY");
    await expectApiError(handleFx({ from_currency: "USD'; DROP--", to_currency: "EUR" }), 400, "INVALID_CURRENCY");
  });

  it("bad amounts -> 400 INVALID_AMOUNT", async () => {
    await expectApiError(handleFx({ from_currency: "USD", to_currency: "EUR", amount: "abc" }), 400, "INVALID_AMOUNT");
    await expectApiError(handleFx({ from_currency: "USD", to_currency: "EUR", amount: "-5" }), 400, "INVALID_AMOUNT");
    await expectApiError(handleFx({ from_currency: "USD", to_currency: "EUR", amount: "0" }), 400, "INVALID_AMOUNT");
    await expectApiError(handleFx({ from_currency: "USD", to_currency: "EUR", amount: "1e13" }), 400, "INVALID_AMOUNT");
  });
});

describe("handleFx answers (stubbed sources)", () => {
  it("all three sources agree -> median served at confidence 1.0 with a recomputable receipt", async () => {
    stubFxSources({
      frankfurter: frankfurterBody(0.91),
      openEr: openErBody(0.9102),
      fawaz: fawazBody(0.9099),
    });
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR", amount: "10" });
    // Median of [0.91, 0.9102, 0.9099] is 0.91 (Frankfurter's quote).
    expect(result.converted_amount).toBeCloseTo(9.1, 6);
    expect(result.rate).toBeCloseTo(0.91, 6);
    expect(result.verdict).toBe("verified");
    expect(result.confidence).toBe(1.0);
    expect(result.sources_used).toHaveLength(3);
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe(INTENT);
    expect(receipt.raw_response_sha256).toMatch(SHA256_RE);
    // Receipt evidence is stored and the hash recomputes over the exact bytes.
    const ev = await getReceiptEvidence(receipt.receipt_id);
    expect(ev.found).toBe(true);
    expect(sha256Hex(ev.evidence!)).toBe(receipt.raw_response_sha256);
    const parsed = JSON.parse(ev.evidence!.toString("utf8")) as { sources: Array<{ raw_body: string }> };
    expect(parsed.sources).toHaveLength(3);
  });

  it("kill-each-source failover: any one source down -> the remaining two answer", async () => {
    for (const killed of ["frankfurter", "openEr", "fawaz"] as const) {
      const opts: StubOpts = {
        frankfurter: frankfurterBody(0.91),
        openEr: openErBody(0.9101),
        fawaz: fawazBody(0.91),
      };
      opts[killed] = "ERR";
      stubFxSources(opts);
      const start = Date.now();
      const result = await handleFx({ from_currency: "USD", to_currency: "EUR" });
      const wall = Date.now() - start;
      expect(result.verdict).toBe("verified");
      expect(result.converted_amount).toBeCloseTo(0.91, 6);
      expect(result.confidence).toBe(0.9); // degraded: one source lost
      expect(result.sources_used).toHaveLength(2);
      expect(wall).toBeLessThan(1000); // sub-second failover (owner requirement)
      vi.unstubAllGlobals();
    }
  });

  it("a HUNG source never delays the answer (wall < 1 s with one source hanging)", async () => {
    stubFxSources({
      frankfurter: "HANG",
      openEr: openErBody(0.9101),
      fawaz: fawazBody(0.91),
    });
    const start = Date.now();
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR" });
    const wall = Date.now() - start;
    expect(result.converted_amount).toBeCloseTo(0.91, 6);
    expect(wall).toBeLessThan(1000);
  });

  it("two sources down -> single covering source answers at confidence 0.9, honestly labeled", async () => {
    stubFxSources({
      frankfurter: "ERR",
      openEr: openErBody(0.9105),
      fawaz: "ERR",
    });
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR" });
    expect(result.converted_amount).toBeCloseTo(0.9105, 6);
    expect(result.confidence).toBe(0.9);
    expect(result.sources_used).toEqual(["open.er-api.com"]);
    expect(String(result.source)).toContain("degraded");
  });

  it("all sources down -> 422 NO_DATA, never an invented rate", async () => {
    stubFxSources({ frankfurter: "ERR", openEr: "ERR", fawaz: "ERR" });
    await expectApiError(handleFx({ from_currency: "USD", to_currency: "EUR" }), 422, "NO_DATA");
  });

  it("sources disagree beyond 0.5% on the SAME date -> 502 FX_SOURCES_DISAGREE, never averaged", async () => {
    stubFxSources({
      frankfurter: frankfurterBody(0.91, "2026-11-21"),
      openEr: openErBody(0.85, "Sat, 21 Nov 2026 00:02:32 +0000"), // 6.6% split, same day
      fawaz: fawazBody(0.92, "2026-11-21"),
    });
    await expectApiError(handleFx({ from_currency: "USD", to_currency: "EUR" }), 502, "FX_SOURCES_DISAGREE");
  });

  it("sources straddling a rate update -> freshest serves at 0.9 with the split disclosed", async () => {
    stubFxSources({
      frankfurter: "ERR",
      openEr: openErBody(0.95, "Sun, 22 Nov 2026 00:02:32 +0000"), // fresh
      fawaz: fawazBody(0.90, "2026-11-21"), // stale by one day, 5.3% split
    });
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR" });
    expect(result.rate).toBeCloseTo(0.95, 6);
    expect(result.confidence).toBe(0.9);
    expect(String(result.source)).toContain("straddle a rate update");
    expect(String(result.source)).toContain("0.9");
  });

  it("agreement boundary: exactly 0.5% apart serves; just over refuses", async () => {
    const base = 0.91;
    const within = base * (1 + AGREEMENT_TOLERANCE * 0.99);
    stubFxSources({
      frankfurter: frankfurterBody(base),
      openEr: openErBody(within),
      fawaz: "ERR",
    });
    const ok = await handleFx({ from_currency: "USD", to_currency: "EUR" });
    expect(ok.verdict).toBe("verified");
    vi.unstubAllGlobals();
    const beyond = base * (1 + AGREEMENT_TOLERANCE * 1.01);
    stubFxSources({
      frankfurter: frankfurterBody(base),
      openEr: openErBody(beyond, "Sat, 21 Nov 2026 00:02:32 +0000"), // same date as frankfurter's -> a real same-day disagreement
      fawaz: "ERR",
    });
    await expectApiError(handleFx({ from_currency: "USD", to_currency: "EUR" }), 502, "FX_SOURCES_DISAGREE");
  });

  it("codes are case-insensitive (usd/eur resolve)", async () => {
    stubFxSources({
      frankfurter: frankfurterBody(0.91),
      openEr: openErBody(0.91),
      fawaz: fawazBody(0.91),
    });
    const result = await handleFx({ from_currency: "usd", to_currency: "eur" });
    expect(result.from_currency).toBe("USD");
    expect(result.to_currency).toBe("EUR");
  });
});

describe("handleFx live (real keyless rate APIs, no mocks)", () => {
  it("USD -> EUR answers a plausible rate from real sources with a receipt", async () => {
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR" });
    expect(result.verdict).toBe("verified");
    const rate = result.rate as number;
    // Wide band: any real USD/EUR rate in living memory.
    expect(rate).toBeGreaterThan(0.5);
    expect(rate).toBeLessThan(1.5);
    expect(result.converted_amount).toBeCloseTo(rate, 6);
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string };
    expect(receipt.raw_response_sha256).toMatch(SHA256_RE);
    const ev = await getReceiptEvidence(receipt.receipt_id);
    expect(ev.found).toBe(true);
    expect(sha256Hex(ev.evidence!)).toBe(receipt.raw_response_sha256);
  }, 30000);

  it("USD -> EGP answers via the broad-coverage fallback sources (Frankfurter has no EGP)", async () => {
    const result = await handleFx({ from_currency: "USD", to_currency: "EGP", amount: "100" });
    expect(result.verdict).toBe("verified");
    const rate = result.rate as number;
    expect(rate).toBeGreaterThan(10);
    expect(rate).toBeLessThan(200);
    expect(result.converted_amount).toBeCloseTo(100 * rate, 4);
  }, 30000);
});
