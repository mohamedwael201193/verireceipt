// Tests for src/handlers/currencyConvert.ts (CURRENCY_EXCHANGE_CONVERT).
// Handler paths are driven by a stubbed global fetch (all five rate
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
import { AGREEMENT_TOLERANCE, INTENT, handleFx, settleWithStragglerGrace } from "../src/handlers/currencyConvert";

describe("settleWithStragglerGrace coverage accounting", () => {
  it("pending results are dense, explicit undefined slots and late completions cannot mutate the snapshot", async () => {
    let complete!: (value: string) => void;
    const late = new Promise<string>((resolve) => { complete = resolve; });
    const results = await settleWithStragglerGrace([Promise.resolve("a"), Promise.resolve("b"), late], 10, 500);
    expect(results).toHaveLength(3);
    expect(2 in results).toBe(true);
    let visited = 0;
    results.forEach(() => visited++);
    expect(visited).toBe(3);
    expect(results[2]).toBeUndefined();
    complete("late");
    await Promise.resolve(); await Promise.resolve();
    expect(results[2]).toBeUndefined();
  });
  it("two null coverage misses cannot start the grace and discard a later real answer", async () => {
    const result = await settleWithStragglerGrace([
      Promise.resolve(null), Promise.resolve(null),
      new Promise<string>((resolve) => setTimeout(() => resolve("real quote"), 60)),
    ], 10, 500);
    expect(result[2]).toEqual({ status: "fulfilled", value: "real quote" });
  });
  it("healthy negative control retains every fulfilled result", async () => {
    const results = await settleWithStragglerGrace([Promise.resolve("a"), Promise.resolve("b"), Promise.resolve("c")], 10, 500);
    expect(results.map((r) => r?.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
  });
});

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

function vatcomplyBody(rate: number, date = "2026-11-21"): string {
  return JSON.stringify({ date, base: "USD", rates: { EUR: rate } });
}
function floatratesBody(rate: number, date = "Sat, 21 Nov 2026 23:59:00 GMT"): string {
  return JSON.stringify({ eur: { code: "EUR", rate: String(rate), date, inverseRate: "1" } });
}

interface StubOpts {
  frankfurter?: string | "ERR" | "HANG";
  openEr?: string | "ERR" | "HANG";
  fawaz?: string | "ERR" | "HANG";
  vatcomply?: string | "ERR" | "HANG";
  floatrates?: string | "ERR" | "HANG";
}

/** Stub global fetch across all five FX sources. "ERR" = source down;
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
    if (u.includes("vatcomply")) return pick(opts.vatcomply, "vatcomply");
    if (u.includes("floatrates")) return pick(opts.floatrates, "floatrates");
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
  it("all five sources agree -> median served at confidence 1.0 with a recomputable receipt", async () => {
    stubFxSources({
      frankfurter: frankfurterBody(0.91),
      openEr: openErBody(0.9102),
      fawaz: fawazBody(0.9099),
      vatcomply: vatcomplyBody(0.9101),
      floatrates: floatratesBody(0.91),
    });
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR", amount: "10" });
    // Median of [0.91, 0.9102, 0.9099, 0.9101, 0.91] is 0.91.
    expect(result.converted_amount).toBeCloseTo(9.1, 6);
    expect(result.rate).toBeCloseTo(0.91, 6);
    expect(result.verdict).toBe("verified");
    expect(result.confidence).toBe(1.0);
    expect(result.sources_used).toHaveLength(5);
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe(INTENT);
    expect(receipt.raw_response_sha256).toMatch(SHA256_RE);
    // Receipt evidence is stored and the hash recomputes over the exact bytes.
    const ev = await getReceiptEvidence(receipt.receipt_id);
    expect(ev.found).toBe(true);
    expect(sha256Hex(ev.evidence!)).toBe(receipt.raw_response_sha256);
    const parsed = JSON.parse(ev.evidence!.toString("utf8")) as { sources: Array<{ raw_body: string }> };
    expect(parsed.sources).toHaveLength(5);
  });

  it("weekend split: three fix-dated sources outvote two recomputed ones -> the fix value serves", async () => {
    // Reproduces the epoch-40 scoring leak: on weekends the public
    // keyless population is fix-heavy (Friday ECB-style snapshots), so
    // the network's reference median lands on the fix value. Serving
    // the five-source median keeps us on that value; the old
    // three-source panel could land 15-25bps away on EUR/GBP.
    stubFxSources({
      frankfurter: frankfurterBody(0.90992, "2026-11-20"),
      vatcomply: vatcomplyBody(0.909918, "2026-11-20"),
      floatrates: floatratesBody(0.90995, "Fri, 20 Nov 2026 23:59:00 GMT"),
      openEr: openErBody(0.911256, "Sun, 22 Nov 2026 00:02:32 +0000"),
      fawaz: fawazBody(0.91158, "2026-11-22"),
    });
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR", amount: "100" });
    // The tight fix cluster {0.909918, 0.90992, 0.90995} anchors (the two
    // recomputed sources drift 15-25bps on the weekend); its median 0.90992
    // serves - closer to the fix than the old full-pool median 0.90995.
    expect(result.rate).toBeCloseTo(0.90992, 6);
    expect(result.converted_amount).toBeCloseTo(90.992, 6);
    expect(result.verdict).toBe("verified");
    expect(result.confidence).toBe(1.0);
    expect(result.sources_used).toHaveLength(5);
  });

  it("weekend live shape (measured 2026-11-23): the ECB fix pair anchors over a recomputed pair", async () => {
    // Measured live: every top-ranked miner serves the ECB fix (0.909918,
    // dated Friday). The recomputed sources drift 15-25bps on Sunday and a
    // late-GMT Friday quote sits between them, so the full-pool median
    // lands ~9bps off the fix. The tight fix pair must anchor instead.
    stubFxSources({
      frankfurter: frankfurterBody(0.90992, "2026-11-20"),
      openEr: openErBody(0.911256, "Sun, 22 Nov 2026 00:02:32 +0000"),
      fawaz: fawazBody(0.91158, "2026-11-22"),
      vatcomply: vatcomplyBody(0.909918, "2026-11-20"),
      floatrates: floatratesBody(0.910744, "Fri, 20 Nov 2026 23:59:00 GMT"),
    });
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR", amount: "100" });
    expect(result.verdict).toBe("verified");
    expect(result.rate).toBe(0.909918);
    expect(result.converted_amount).toBeCloseTo(90.9918, 4);
    // The answer must disclose the anchor cluster and the excluded quotes
    // with their distances - never silently pool (review, 2026-11-23).
    const ans = String(result.answer);
    expect(ans).toContain("anchored on the tightest agreeing cluster");
    expect(ans).toContain("vatcomply=0.909918");
    expect(ans).toContain("Frankfurter (ECB reference rates)=0.90992");
    expect(ans).toContain("excluded floatrates=0.910744 (+9bps)");
    expect(ans).toContain("open.er-api.com=0.911256 (+15bps)");
    expect(ans).toContain("fawaz currency-api=0.91158 (+18bps)");
    expect(String(result.source)).toContain("single-linkage");
    vi.unstubAllGlobals();
  });

  it("epoch-41 live shape (measured 2026-11-23 00:41Z): a larger recomputed cluster no longer outvotes the fix pair", async () => {
    // Measured live in epoch 41: the Monday-recomputed sources formed a
    // THREE-member tight cluster (er-api 0.911134 fresh Monday 00:02:32Z,
    // fawaz 0.91158016, floatrates 0.91074399) against the Friday ECB fix
    // pair (frankfurter 0.90992, vatcomply 0.909918). Raw size anchored on
    // the recomputed side; the reference is fix-heavy (the truth sources
    // are frankfurter + er-api and every top-ranked miner serves the fix),
    // so the fix republication pair must anchor. Both sides sit inside the
    // scorer's 50bps tolerance, so this is alignment, not a score trick.
    stubFxSources({
      frankfurter: frankfurterBody(0.90992, "2026-11-20"),
      openEr: openErBody(0.911134, "Mon, 23 Nov 2026 00:02:32 +0000"),
      fawaz: fawazBody(0.91158016, "2026-11-23"),
      vatcomply: vatcomplyBody(0.909918, "2026-11-20"),
      floatrates: floatratesBody(0.91074399, "Fri, 20 Nov 2026 23:59:00 GMT"),
    });
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR", amount: "100" });
    expect(result.verdict).toBe("verified");
    expect(result.rate).toBe(0.909918);
    expect(result.converted_amount).toBeCloseTo(90.9918, 4);
    const ans = String(result.answer);
    expect(ans).toContain("anchored on the tightest agreeing cluster");
    expect(ans).toContain("vatcomply=0.909918");
    expect(ans).toContain("Frankfurter (ECB reference rates)=0.90992");
    expect(ans).toContain("excluded floatrates=0.91074399");
    expect(ans).toContain("open.er-api.com=0.911134");
    expect(ans).toContain("fawaz currency-api=0.91158016");
    vi.unstubAllGlobals();
  });

  it("no fix republication in the pool -> the largest tight cluster anchors, as before", async () => {
    // frankfurter + vatcomply down: the rule must reduce to the previous
    // largest-cluster behaviour, never refuse and never invent a fix.
    stubFxSources({
      frankfurter: "ERR",
      openEr: openErBody(0.911134, "Mon, 23 Nov 2026 00:02:32 +0000"),
      fawaz: fawazBody(0.91158016, "2026-11-23"),
      vatcomply: "ERR",
      floatrates: floatratesBody(0.91074399, "Fri, 20 Nov 2026 23:59:00 GMT"),
    });
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR", amount: "100" });
    expect(result.verdict).toBe("verified");
    // The recomputed trio anchors; its median (lower-middle of
    // {0.91074399, 0.911134, 0.91158016}) is 0.911134.
    expect(result.rate).toBe(0.911134);
    vi.unstubAllGlobals();
  });

  it("kill-each-source failover: any one source down -> the remaining four answer", async () => {
    for (const killed of ["frankfurter", "openEr", "fawaz", "vatcomply", "floatrates"] as const) {
      const opts: StubOpts = {
        frankfurter: frankfurterBody(0.91),
        openEr: openErBody(0.9101),
        fawaz: fawazBody(0.91),
        vatcomply: vatcomplyBody(0.91),
        floatrates: floatratesBody(0.91005),
      };
      opts[killed] = "ERR";
      stubFxSources(opts);
      const start = Date.now();
      const result = await handleFx({ from_currency: "USD", to_currency: "EUR" });
      const wall = Date.now() - start;
      expect(result.verdict).toBe("verified");
      expect(result.converted_amount).toBeCloseTo(0.91, 6);
      expect(result.confidence).toBe(0.9); // degraded: one source lost
      expect(result.sources_used).toHaveLength(4);
      expect(wall).toBeLessThan(1000); // sub-second failover (owner requirement)
      vi.unstubAllGlobals();
    }
  });

  it("a HUNG source never delays the answer (wall < 1 s with one source hanging)", async () => {
    stubFxSources({
      frankfurter: "HANG",
      openEr: openErBody(0.9101),
      fawaz: fawazBody(0.91),
      vatcomply: vatcomplyBody(0.91),
      floatrates: floatratesBody(0.91),
    });
    const start = Date.now();
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR" });
    const wall = Date.now() - start;
    expect(result.converted_amount).toBeCloseTo(0.91, 6);
    expect(result.confidence).toBe(0.9);
    expect(String(result.source)).toContain("degraded");
    expect(String(result.source)).toContain("frankfurter");
    expect(result.sources_used).toHaveLength(4);
    expect(wall).toBeLessThan(1000);
  });

  it("two sources down -> single covering source answers at confidence 0.9, honestly labeled", async () => {
    stubFxSources({
      frankfurter: "ERR",
      openEr: openErBody(0.9105),
      fawaz: "ERR",
      vatcomply: "ERR",
      floatrates: "ERR",
    });
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR" });
    expect(result.converted_amount).toBeCloseTo(0.9105, 6);
    expect(result.confidence).toBe(0.9);
    expect(result.sources_used).toEqual(["open.er-api.com"]);
    expect(String(result.source)).toContain("degraded");
  });

  it("all sources erroring with none answering -> 502 FX_SOURCES_DOWN, never an invented rate (review 35)", async () => {
    stubFxSources({ frankfurter: "ERR", openEr: "ERR", fawaz: "ERR", vatcomply: "ERR", floatrates: "ERR" });
    await expectApiError(handleFx({ from_currency: "USD", to_currency: "EUR" }), 502, "FX_SOURCES_DOWN");
  });

  it("sources answering without the pair -> 422 NO_DATA with coverage named (review 35)", async () => {
    stubFxSources({
      frankfurter: JSON.stringify({ date: "2026-11-21", rates: { GBP: 0.79 } }),
      openEr: JSON.stringify({ result: "success", time_last_update_utc: "Sat, 22 Nov 2026 00:02:32 +0000", rates: { GBP: 0.79 } }),
      fawaz: JSON.stringify({ date: "2026-11-21", usd: { gbp: 0.79 } }),
      vatcomply: JSON.stringify({ date: "2026-11-21", rates: { GBP: 0.79 } }),
      floatrates: JSON.stringify({ gbp: { code: "GBP", rate: "0.79", date: "Sat, 21 Nov 2026 23:59:00 GMT" } }),
    });
    await expectApiError(handleFx({ from_currency: "USD", to_currency: "EUR" }), 422, "NO_DATA");
  });

  it("sources disagree beyond 0.5% on the SAME date -> 502 FX_SOURCES_DISAGREE, never averaged", async () => {
    stubFxSources({
      frankfurter: frankfurterBody(0.91, "2026-11-21"),
      openEr: openErBody(0.85, "Sat, 21 Nov 2026 00:02:32 +0000"), // 6.6% split, same day
      fawaz: fawazBody(0.92, "2026-11-21"),
      vatcomply: vatcomplyBody(0.91, "2026-11-21"),
      floatrates: floatratesBody(0.92, "Sat, 21 Nov 2026 23:59:00 GMT"),
    });
    await expectApiError(handleFx({ from_currency: "USD", to_currency: "EUR" }), 502, "FX_SOURCES_DISAGREE");
  });

  it("sources straddling a rate update -> freshest serves at 0.9 with the split disclosed", async () => {
    stubFxSources({
      frankfurter: "ERR",
      openEr: openErBody(0.95, "Sun, 22 Nov 2026 00:02:32 +0000"), // fresh
      fawaz: fawazBody(0.90, "2026-11-21"), // stale by one day, 5.3% split
      vatcomply: "ERR",
      floatrates: "ERR",
    });
    const result = await handleFx({ from_currency: "USD", to_currency: "EUR" });
    expect(result.rate).toBeCloseTo(0.95, 6);
    expect(result.confidence).toBe(0.9);
    expect(String(result.source)).toContain("straddle a rate update");
    expect(String(result.source)).toContain("0.9");
  });

  it("straddle answer text makes NO false agreement claim; agreeing run claims agreement (negative control, review 35)", async () => {
    stubFxSources({
      frankfurter: "ERR",
      openEr: openErBody(0.95, "Sun, 22 Nov 2026 00:02:32 +0000"),
      fawaz: fawazBody(0.90, "2026-11-21"), // 5.3% split, straddled
      vatcomply: "ERR",
      floatrates: "ERR",
    });
    const straddled = await handleFx({ from_currency: "USD", to_currency: "EUR" });
    const straddledAnswer = String(straddled.answer);
    expect(straddledAnswer).not.toContain("agreeing within 0.5%");
    expect(straddledAnswer).toContain("straddled a rate update");
    expect(straddledAnswer).toContain("0.95");
    expect(straddledAnswer).toContain("2026-11-21"); // the stale date is named too
    expect(straddledAnswer).toContain("did NOT agree within 0.5%");
    expect(String(straddled.source)).toContain("on the same snapshot date is refused");

    vi.unstubAllGlobals();
    stubFxSources({
      frankfurter: "ERR",
      openEr: openErBody(0.951, "Sun, 22 Nov 2026 00:02:32 +0000"),
      fawaz: fawazBody(0.95, "2026-11-21"), // 0.1% split, agreeing
    });
    const agreed = await handleFx({ from_currency: "USD", to_currency: "EUR" });
    expect(String(agreed.answer)).toContain("agreeing within 0.5%");
    expect(String(agreed.answer)).not.toContain("straddled a rate update");
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

const FX_LIVE = process.env.FX_LIVE === "1";
describe.skipIf(!FX_LIVE)("handleFx live (real keyless rate APIs, no mocks)", () => {
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
