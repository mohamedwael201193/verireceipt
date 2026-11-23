// Tests for handleFxNow (FX_NOW_EUR / FX_NOW_CAD / FX_NOW_SEK) in
// src/handlers/currencyConvert.ts. All sources stubbed via global fetch;
// hermetic DB via a unique scratch SQLITE_PATH per run.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "fx-now-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import { handleFxNow } from "../src/handlers/currencyConvert";
import { buildServer } from "../src/server";

function bodies(ccy: string, rate: number, date = "2026-11-21") {
  const lower = ccy.toLowerCase();
  return {
    frankfurter: JSON.stringify({ amount: 1.0, base: "USD", date, rates: { [ccy]: rate } }),
    openEr: JSON.stringify({ result: "success", time_last_update_utc: "Sat, 22 Nov 2026 00:02:32 +0000", rates: { [ccy]: rate } }),
    fawaz: JSON.stringify({ date, usd: { [lower]: rate } }),
    vatcomply: JSON.stringify({ date, base: "USD", rates: { [ccy]: rate } }),
    floatrates: JSON.stringify({ [lower]: { code: ccy, rate: String(rate), date: "Sat, 21 Nov 2026 23:59:00 GMT", inverseRate: "1" } }),
  };
}

type StubOpt = string | "ERR" | "HANG" | undefined;
function stubFxSources(opts: Record<string, StubOpt>): void {
  vi.stubGlobal("fetch", (url: unknown) => {
    const u = String(url);
    const pick = (body: StubOpt, label: string): Promise<Response> => {
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
  });
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

describe("handleFxNow validation", () => {
  it("missing currency -> 400 MISSING_PARAM; malformed -> 400 INVALID_CURRENCY", async () => {
    await expectApiError(handleFxNow({}), 400, "MISSING_PARAM");
    await expectApiError(handleFxNow({ currency: "EU" }), 400, "INVALID_CURRENCY");
    await expectApiError(handleFxNow({ currency: "EU1" }), 400, "INVALID_CURRENCY");
  });
  it("well-formed but uncontracted code -> 422 NO_DATA, no network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expectApiError(handleFxNow({ currency: "GBP" }), 422, "NO_DATA");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("handleFxNow answers (stubbed sources)", () => {
  it("EUR: all five agree -> median served at confidence 1.0, contract direction", async () => {
    stubFxSources(bodies("EUR", 0.85));
    const r = await handleFxNow({ currency: "EUR" });
    expect(r.rate).toBe(0.85);
    expect(r.currency).toBe("EUR");
    expect(r.confidence).toBe(1.0);
    expect(r.rate_date).toBe("2026-11-21");
    expect((r.sources_used as string[]).length).toBe(5);
    expect((r.receipt as { intent: string }).intent).toBe("FX_NOW_EUR");
    expect(String(r.answer)).toContain("1 USD buys 0.85 EUR");
  });
  it("CAD and SEK stamp their own intents", async () => {
    stubFxSources(bodies("CAD", 1.41));
    const cad = await handleFxNow({ currency: "cad" });
    expect(cad.rate).toBe(1.41);
    expect((cad.receipt as { intent: string }).intent).toBe("FX_NOW_CAD");
    vi.unstubAllGlobals();
    stubFxSources(bodies("SEK", 10.44));
    const sek = await handleFxNow({ currency: "SEK" });
    expect(sek.rate).toBe(10.44);
    expect((sek.receipt as { intent: string }).intent).toBe("FX_NOW_SEK");
  });
  it("same-date disagreement beyond 0.5% is refused, never averaged", async () => {
    const b = bodies("EUR", 0.85);
    b.frankfurter = JSON.stringify({ amount: 1.0, base: "USD", date: "2026-11-21", rates: { EUR: 0.87 } });
    b.openEr = JSON.stringify({ result: "success", time_last_update_utc: "Sat, 21 Nov 2026 00:02:32 +0000", rates: { EUR: 0.85 } });
    stubFxSources(b);
    await expectApiError(handleFxNow({ currency: "EUR" }), 502, "FX_SOURCES_DISAGREE");
  });
  it("straddled update serves the freshest dated source alone at 0.9", async () => {
    const b = bodies("EUR", 0.85, "2026-11-21");
    b.frankfurter = JSON.stringify({ amount: 1.0, base: "USD", date: "2026-11-22", rates: { EUR: 0.86 } });
    stubFxSources(b);
    const r = await handleFxNow({ currency: "EUR" });
    expect(r.rate).toBe(0.86);
    expect(r.confidence).toBe(0.9);
    expect(String(r.answer)).toContain("straddled");
  });
  it("a single covering source answers at 0.9 with the source named", async () => {
    const b = bodies("EUR", 0.85);
    stubFxSources({ frankfurter: b.frankfurter, openEr: "ERR", fawaz: "ERR", vatcomply: "ERR", floatrates: "ERR" });
    const r = await handleFxNow({ currency: "EUR" });
    expect(r.rate).toBe(0.85);
    expect(r.confidence).toBe(0.9);
    expect(String(r.source)).toContain("Frankfurter");
  });
  it("every source down -> 502 FX_SOURCES_DOWN", async () => {
    stubFxSources({ frankfurter: "ERR", openEr: "ERR", fawaz: "ERR", vatcomply: "ERR", floatrates: "ERR" });
    await expectApiError(handleFxNow({ currency: "EUR" }), 502, "FX_SOURCES_DOWN");
  });
  it("an agreed but out-of-contract-range rate is refused", async () => {
    stubFxSources(bodies("EUR", 0.00001));
    await expectApiError(handleFxNow({ currency: "EUR" }), 502, "FX_RATE_OUT_OF_RANGE");
  });
  it("adopts the same anchor-cluster rule as /v1/fx: the tight fix cluster anchors over drifted recomputed quotes", async () => {
    // The weekend shape from the fx anchor-cluster review (measured
    // 2026-11-23): a fix pair and a late-GMT Friday quote vs two drifted
    // recomputed quotes. /v1/fx serves 0.909918 here; /v1/fx-now must
    // serve the SAME value so the routes never diverge.
    const b = bodies("EUR", 0.91);
    b.frankfurter = JSON.stringify({ amount: 1.0, base: "USD", date: "2026-11-20", rates: { EUR: 0.90992 } });
    b.vatcomply = JSON.stringify({ date: "2026-11-20", base: "USD", rates: { EUR: 0.909918 } });
    b.floatrates = JSON.stringify({ eur: { code: "EUR", rate: "0.910744", date: "Fri, 20 Nov 2026 23:59:00 GMT", inverseRate: "1" } });
    b.openEr = JSON.stringify({ result: "success", time_last_update_utc: "Sun, 22 Nov 2026 00:02:32 +0000", rates: { EUR: 0.911256 } });
    b.fawaz = JSON.stringify({ date: "2026-11-22", usd: { eur: 0.91158 } });
    stubFxSources(b);
    const result = await handleFxNow({ currency: "EUR" });
    expect(result.rate).toBe(0.909918);
    expect(result.confidence).toBe(1.0);
    const ans = String(result.answer);
    expect(ans).toContain("anchored on the tightest agreeing cluster");
    expect(ans).toContain("excluded");
    expect(String(result.source)).toContain("single-linkage");
  });
});

describe("/v1/fx-now route", () => {
  it("serves EUR and refuses GBP with the contract shape", async () => {
    stubFxSources(bodies("EUR", 0.85));
    const app = buildServer();
    try {
      const ok = await app.inject({ method: "GET", url: "/v1/fx-now?currency=EUR" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().rate).toBe(0.85);
      expect(ok.json().currency).toBe("EUR");
      const gbp = await app.inject({ method: "GET", url: "/v1/fx-now?currency=GBP" });
      expect(gbp.statusCode).toBe(422);
      expect(gbp.json().code).toBe("NO_DATA");
    } finally {
      await app.close();
    }
  });
});
