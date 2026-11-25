// Tests for src/handlers/macroEconomic.ts (MACRO_ECONOMIC_INDICATOR_GENERAL).
//
// resolveCountry is tested as a pure function against a small fixture
// catalog; the handler paths are driven by a stubbed global fetch
// (catalog + indicator calls), and the LIVE tests at the bottom hit the
// real keyless World Bank API. Hermetic DB via a unique scratch
// SQLITE_PATH per run.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "fs";
import { join, resolve } from "path";

const SCRATCH_PARENT = resolve(process.cwd(), "..", "tmp");
mkdirSync(SCRATCH_PARENT, { recursive: true });
const SCRATCH_DIR = mkdtempSync(join(SCRATCH_PARENT, "macro-test-"));
process.env.SQLITE_PATH = join(SCRATCH_DIR, "verireceipt.sqlite");

afterAll(() => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import { sha256Hex } from "../src/core/receipt";
import { getReceiptEvidence } from "../src/core/storage";
import {
  INTENT,
  handleMacro,
  resetMacroCachesForTests,
  resolveCountry,
} from "../src/handlers/macroEconomic";

const SHA256_RE = /^[0-9a-f]{64}$/;

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
  throw new Error(`expected ApiError ${status}/${code} but the call succeeded`);
}

const FIXTURE_CATALOG = [
  { id: "EG", iso2Code: "EG", name: "Egypt, Arab Rep.", iso3: "EGY", isAggregate: false },
  { id: "US", iso2Code: "US", name: "United States", iso3: "USA", isAggregate: false },
  { id: "GB", iso2Code: "GB", name: "United Kingdom", iso3: "GBR", isAggregate: false },
  { id: "TR", iso2Code: "TR", name: "Turkiye", iso3: "TUR", isAggregate: false },
  { id: "KR", iso2Code: "KR", name: "Korea, Rep.", iso3: "KOR", isAggregate: false },
  { id: "WLD", iso2Code: "1W", name: "World", iso3: "WLD", isAggregate: true },
];

describe("resolveCountry (pure, fixture catalog)", () => {
  it("matches the WB name case-insensitively", () => {
    expect(resolveCountry(FIXTURE_CATALOG, "egypt, arab rep.")?.iso2Code).toBe("EG");
    expect(resolveCountry(FIXTURE_CATALOG, "United States")?.iso2Code).toBe("US");
  });

  it("matches ISO-2 and ISO-3", () => {
    expect(resolveCountry(FIXTURE_CATALOG, "eg")?.iso2Code).toBe("EG");
    expect(resolveCountry(FIXTURE_CATALOG, "EGY")?.iso2Code).toBe("EG");
    expect(resolveCountry(FIXTURE_CATALOG, "gbr")?.iso2Code).toBe("GB");
  });

  it("resolves the alias table (Egypt, UK, Turkey, South Korea)", () => {
    expect(resolveCountry(FIXTURE_CATALOG, "Egypt")?.iso2Code).toBe("EG");
    expect(resolveCountry(FIXTURE_CATALOG, "UK")?.iso2Code).toBe("GB");
    expect(resolveCountry(FIXTURE_CATALOG, "Turkey")?.iso2Code).toBe("TR");
    expect(resolveCountry(FIXTURE_CATALOG, "South Korea")?.iso2Code).toBe("KR");
  });

  it("excludes aggregate regions", () => {
    expect(resolveCountry(FIXTURE_CATALOG, "World")).toBeNull();
    expect(resolveCountry(FIXTURE_CATALOG, "WLD")).toBeNull();
  });

  it("returns null for an unknown country", () => {
    expect(resolveCountry(FIXTURE_CATALOG, "Narnia")).toBeNull();
  });
});

/** Stub the two World Bank calls: catalog, then indicator. */
function stubWorldBank(opts: {
  catalog?: string | "ERR";
  indicator?: string | "ERR";
}): void {
  const fetchStub = async (url: unknown) => {
    const u = String(url);
    if (u.includes("/country?") || u.endsWith("/country?format=json&per_page=400")) {
      if (opts.catalog === "ERR" || opts.catalog === undefined) throw new Error("wb down");
      return { ok: true, status: 200, text: async () => opts.catalog! } as Response;
    }
    if (u.includes("/indicator/")) {
      if (opts.indicator === "ERR" || opts.indicator === undefined) throw new Error("wb down");
      return { ok: true, status: 200, text: async () => opts.indicator! } as Response;
    }
    throw new Error(`unexpected fetch to ${u}`);
  };
  vi.stubGlobal("fetch", fetchStub);
}

function catalogJson(): string {
  return JSON.stringify([
    { page: 1, pages: 1, per_page: 400, total: FIXTURE_CATALOG.length },
    FIXTURE_CATALOG.map((c) => ({
      id: c.iso3,
      iso2Code: c.iso2Code,
      name: c.name,
      region: { id: c.isAggregate ? "NA" : "MEA", value: c.isAggregate ? "Aggregates" : "Region" },
    })),
  ]);
}

function indicatorJson(year: number, value: number | null): string {
  return JSON.stringify([
    { page: 1, pages: 1, per_page: 100, total: 1 },
    [
      {
        indicator: { id: "SL.UEM.TOTL.ZS", value: "Unemployment, total (% of total labor force)" },
        country: { id: "EG", value: "Egypt, Arab Rep." },
        countryiso3code: "EGY",
        date: String(year),
        value,
        decimal: 1,
      },
    ],
  ]);
}

beforeEach(() => {
  resetMacroCachesForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetMacroCachesForTests();
});

describe("handleMacro validation (stubbed, no network use)", () => {
  it("rejects missing params with 400 MISSING_PARAM", async () => {
    await expectApiError(handleMacro({}), 400, "MISSING_PARAM");
  });

  it("rejects an unsupported indicator with 422 UNSUPPORTED_INDICATOR", async () => {
    await expectApiError(
      handleMacro({ indicator: "unknown statistic", country: "Egypt", year: "2023" }),
      422,
      "UNSUPPORTED_INDICATOR",
    );
  });

  it("rejects a malformed year with 400 INVALID_YEAR", async () => {
    await expectApiError(
      handleMacro({ indicator: "unemployment rate", country: "Egypt", year: "20x3" }),
      400,
      "INVALID_YEAR",
    );
    await expectApiError(
      handleMacro({ indicator: "unemployment rate", country: "Egypt", year: "1959" }),
      400,
      "INVALID_YEAR",
    );
  });

  it("rejects an unknown country with 422 COUNTRY_NOT_FOUND", async () => {
    stubWorldBank({ catalog: catalogJson() });
    await expectApiError(
      handleMacro({ indicator: "unemployment rate", country: "Narnia", year: "2023" }),
      422,
      "COUNTRY_NOT_FOUND",
    );
  });
});

describe("M1 indicator normalization (stubbed World Bank)", () => {
  it.each(["Unemployment", "unemployment rate (%)", "jobless rate", "UNEMPLOYMENT   RATE", "unemployment rate (percent)", "unemployment % of total labor force", "the unemployment rate", "the jobless rate", "The Unemployment", "rate of unemployment", "SL.UEM.TOTL.ZS"])(
    "serves the variant %j as the contract enum, disclosed", async (variant) => {
      stubWorldBank({ catalog: catalogJson(), indicator: indicatorJson(2024, 5.2) });
      const out = await handleMacro({ indicator: variant, country: "Egypt", year: "2024" });
      expect(out.indicator).toBe("unemployment rate");
      expect(out.indicator_input).toBe(variant);
      expect(out.rate_pct).toBe(5.2);
      const ans = String(out.answer);
      if (variant !== "unemployment rate") {
        expect(ans).toContain(`"${variant}" read as "unemployment rate"`);
      }
    },
  );

  it("the exact enum value carries no normalization disclosure", async () => {
    stubWorldBank({ catalog: catalogJson(), indicator: indicatorJson(2024, 5.2) });
    const out = await handleMacro({ indicator: "unemployment rate", country: "Egypt", year: "2024" });
    expect(String(out.answer)).not.toContain("read as");
  });

  it("unknown indicators still refuse without a default", async () => {
    await expectApiError(handleMacro({ indicator: "GDP per hour", country: "Egypt" }), 422, "UNSUPPORTED_INDICATOR");
    await expectApiError(handleMacro({ indicator: "unknown statistic", country: "Egypt" }), 422, "UNSUPPORTED_INDICATOR");
  });

  it("a non-unit parenthetical is NOT stripped (no smuggling a different statistic past the alias check)", async () => {
    await expectApiError(handleMacro({ indicator: "unemployment (youth, ages 15-24)", country: "Egypt" }), 422, "UNSUPPORTED_INDICATOR");
    await expectApiError(handleMacro({ indicator: "the unemployment (youth, ages 15-24)", country: "Egypt" }), 422, "UNSUPPORTED_INDICATOR");
  });
});

describe("handleMacro answers (stubbed World Bank)", () => {
  it("uses the source's latest nonempty year when year is absent", async () => {
    const bodies = [indicatorJson(2021, 4.1), indicatorJson(2024, 5.2), indicatorJson(2025, null)].map((text) => JSON.parse(text)[1][0]);
    const raw = JSON.stringify([{ pages: 1 }, bodies]);
    stubWorldBank({ catalog: catalogJson(), indicator: raw });
    const out = await handleMacro({ indicator: "unemployment rate", country: "Egypt" });
    expect(out.year).toBe(2024);
    expect(out.rate_pct).toBe(5.2);
    expect(out.year_resolution).toBe("latest_published_nonempty");
    expect(out.answer).toContain("latest published");
    const receipt = out.receipt as { upstream_url: string; receipt_id: string; raw_response_sha256: string };
    expect(receipt.upstream_url).toContain("mrnev=1");
    expect(receipt.upstream_url).not.toContain("date=");
    const evidence = await getReceiptEvidence(receipt.receipt_id);
    expect(sha256Hex(evidence.evidence!)).toBe(receipt.raw_response_sha256);
    expect(evidence.evidence!.toString()).toBe(raw);
  });

  it("does not silently use latest when an explicit requested year is missing", async () => {
    stubWorldBank({ catalog: catalogJson(), indicator: indicatorJson(2024, 5.2) });
    expect((await handleMacro({ indicator: "unemployment rate", country: "Egypt", year: "2023" })).rate_pct).toBeNull();
  });

  it("refuses latest when every returned value is null", async () => {
    stubWorldBank({ catalog: catalogJson(), indicator: indicatorJson(2025, null) });
    expect((await handleMacro({ indicator: "unemployment rate", country: "Egypt" })).rate_pct).toBeNull();
  });

  it("rejects an explicitly empty year rather than silently choosing latest", async () => {
    await expectApiError(handleMacro({ indicator: "unemployment rate", country: "Egypt", year: " " }), 400, "INVALID_YEAR");
  });

  it("maps a malformed row collection to an explicit upstream failure", async () => {
    stubWorldBank({ catalog: catalogJson(), indicator: JSON.stringify([{}, {}]) });
    await expectApiError(handleMacro({ indicator: "unemployment rate", country: "Egypt" }), 502, "WORLD_BANK_UNAVAILABLE");
  });

  it("answers a country's rate with 6-decimal rounding and a raw-bytes receipt", async () => {
    stubWorldBank({ catalog: catalogJson(), indicator: indicatorJson(2023, 5.30999994277954) });
    const res = await handleMacro({ indicator: "unemployment rate", country: "Egypt", year: "2023" });
    expect(res.rate_pct).toBe(5.31);
    expect(res.country).toBe("Egypt, Arab Rep.");
    expect(res.country_iso3).toBe("EGY");
    expect(res.year).toBe(2023);
    expect(res.indicator_id).toBe("SL.UEM.TOTL.ZS");
    expect(res.verdict).toBe("verified");
    const rc = res.receipt as { raw_response_sha256: string; receipt_id: string; upstream_url: string };
    expect(rc.upstream_url).toContain("api.worldbank.org");
    const ev = await getReceiptEvidence(rc.receipt_id);
    expect(ev.found).toBe(true);
    expect(ev.evidence!.toString("utf8")).toBe(indicatorJson(2023, 5.30999994277954));
    expect(sha256Hex(ev.evidence!)).toBe(rc.raw_response_sha256);
  });

  it("resolves the alias 'Turkey' to Turkiye", async () => {
    stubWorldBank({ catalog: catalogJson(), indicator: indicatorJson(2022, 10.25) });
    const res = await handleMacro({ indicator: "unemployment rate", country: "Turkey", year: "2022" });
    expect(res.country).toBe("Turkiye");
    expect(res.rate_pct).toBe(10.25);
  });

  it("discloses no data when the year has a null value", async () => {
    stubWorldBank({ catalog: catalogJson(), indicator: indicatorJson(2024, null) });
    const out = await handleMacro({ indicator: "unemployment rate", country: "Egypt", year: "2024" });
    expect(out.rate_pct).toBeNull();
    expect(out.answer).toContain("no data");
  });

  it("502 WORLD_BANK_UNAVAILABLE when the catalog call fails", async () => {
    stubWorldBank({ catalog: "ERR" });
    await expectApiError(
      handleMacro({ indicator: "unemployment rate", country: "Egypt", year: "2023" }),
      502,
      "WORLD_BANK_UNAVAILABLE",
    );
  });

  it("502 WORLD_BANK_UNAVAILABLE when the indicator call fails", async () => {
    stubWorldBank({ catalog: catalogJson(), indicator: "ERR" });
    await expectApiError(
      handleMacro({ indicator: "unemployment rate", country: "Egypt", year: "2023" }),
      502,
      "WORLD_BANK_UNAVAILABLE",
    );
  });

  it("discloses an out-of-range value without filling rate_pct", async () => {
    stubWorldBank({ catalog: catalogJson(), indicator: indicatorJson(2023, 150) });
    const out = await handleMacro({ indicator: "unemployment rate", country: "Egypt", year: "2023" });
    expect(out.rate_pct).toBeNull();
    expect(out.answer).toContain("150");
  });
});

describe("handleMacro LIVE (real World Bank API, no stub)", () => {
  const LIVE_TIMEOUT_MS = 60000;

  it(
    "answers Egypt's live published unemployment rate for 2023 with a verifiable receipt",
    async () => {
      const res = await handleMacro({ indicator: "unemployment rate", country: "Egypt", year: "2023" });
      const rate = res.rate_pct as number;
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThanOrEqual(100);
      expect(res.country).toBe("Egypt, Arab Rep.");
      const rc = res.receipt as { raw_response_sha256: string; receipt_id: string; intent: string };
      expect(rc.intent).toBe(INTENT);
      expect(rc.raw_response_sha256).toMatch(SHA256_RE);
      const ev = await getReceiptEvidence(rc.receipt_id);
      expect(ev.found).toBe(true);
      expect(sha256Hex(ev.evidence!)).toBe(rc.raw_response_sha256);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "answers the United States rate via the 'USA' ISO-3 input",
    async () => {
      const res = await handleMacro({ indicator: "unemployment rate", country: "USA", year: "2022" });
      expect(res.rate_pct as number).toBeGreaterThan(0);
      expect(res.country).toBe("United States");
    },
    LIVE_TIMEOUT_MS,
  );
});


describe("latest published annual data LIVE", () => {
  it("returns the source-selected year with a verifiable receipt, not an assumed current year", async () => {
    const out = await handleMacro({ indicator: "unemployment rate", country: "United States" });
    expect(Number.isInteger(out.year)).toBe(true);
    expect(out.year as number).toBeGreaterThanOrEqual(1960);
    expect(out.year as number).toBeLessThanOrEqual(2100);
    expect(out.year_resolution).toBe("latest_published_nonempty");
    expect(out.rate_pct as number).toBeGreaterThanOrEqual(0);
    expect(out.rate_pct as number).toBeLessThanOrEqual(100);
    const receipt = out.receipt as { upstream_url: string; receipt_id: string; raw_response_sha256: string };
    expect(receipt.upstream_url).toContain("mrnev=1");
    const evidence = await getReceiptEvidence(receipt.receipt_id);
    expect(sha256Hex(evidence.evidence!)).toBe(receipt.raw_response_sha256);
  }, 60000);
});


describe("World Bank endpoint aliases from captured Germany 2022 observations", () => {
  const series = [
    ["inflation", "FP.CPI.TOTL.ZG", "cpi"], ["cpi", "FP.CPI.TOTL.ZG", "cpi"],
    ["consumer prices", "FP.CPI.TOTL.ZG", "cpi"],
    ["gdp growth", "NY.GDP.MKTP.KD.ZG", "gdp"],
    ["current account", "BN.CAB.XOKA.GD.ZS", "current-account"],
    ["gdp per capita", "NY.GDP.PCAP.CD", "gdp-per-capita"],
    ["population", "SP.POP.TOTL", "population"],
  ];
  it.each(series)("maps %s to the exact source series %s", async (input, id, file) => {
    const raw = readFileSync(resolve("tests/fixtures/macro-alias", `deu-${file}-2022.json`), "utf8");
    const observed = JSON.parse(raw)[1][0].value;
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url); requests.push(u);
      if (u.includes("/indicator/")) { expect(u).toContain(`/indicator/${id}?date=2022`); return new Response(raw); }
      return new Response(JSON.stringify([{}, [{ id: "DEU", iso2Code: "DE", name: "Germany", region: { value: "Europe" } }]]));
    });
    const out = await handleMacro({ indicator: input, country: "DEU", year: "2022" });
    expect(out.indicator_id).toBe(id);
    expect(out.answer).toContain(id);
    expect(out.answer).toContain(String(observed));
    expect(out.rate_pct).toBe(observed >= 0 && observed <= 100 && !["population", "gdp per capita"].includes(input) ? Math.round(observed * 1e6) / 1e6 : null);
    const receipt = out.receipt as { raw_response_sha256: string };
    expect(receipt.raw_response_sha256).toBe(sha256Hex(raw));
    expect(requests).toHaveLength(2);
  });
  it("reports a null observation with disclosed no-data, never zero or a fabricated rate", async () => {
    stubWorldBank({ catalog: catalogJson(), indicator: indicatorJson(2022, null) });
    const out = await handleMacro({ indicator: "inflation", country: "EG", year: "2022" });
    expect(out.rate_pct).toBeNull(); expect(out.answer).toContain("no data");
    expect(out.answer).toContain("FP.CPI.TOTL.ZG"); expect(out.verdict).toBe("no_data");
  });
});

describe('punctuation and descriptive total-unemployment aliases',()=>{
 it.each(['unemployment_rate','UNEMPLOYMENT-RATE','unemployment.rate','SL_UEM_TOTL_ZS','Unemployment, total (% of total labor force) (modeled ILO estimate)','unemployment total labour force percentage'])('normalizes %s with disclosed series binding and raw source receipt',async(input)=>{
  const unemployment=readFileSync(resolve('tests/fixtures/macro-unemployment-deu-2022.json'),'utf8');
  vi.stubGlobal('fetch',async(url:unknown)=>{if(String(url).includes('/indicator/')){expect(String(url)).toContain('/SL.UEM.TOTL.ZS?date=2022');return new Response(unemployment);}return new Response(JSON.stringify([{},[{id:'DEU',iso2Code:'DE',name:'Germany',region:{value:'Europe'}}]]));});
  const out=await handleMacro({indicator:input,country:'DEU',year:'2022'});expect(out.indicator).toBe('unemployment rate');expect(out.indicator_id).toBe('SL.UEM.TOTL.ZS');expect(out.answer).toContain('read as "unemployment rate"');expect((out.receipt as any).raw_response_sha256).toBe(sha256Hex(unemployment));expect(out.rate_pct).toBe(Math.round(JSON.parse(unemployment)[1][0].value*1e6)/1e6);
 });
 it.each(['national unemployment rate','youth unemployment rate','female unemployment','long-term unemployment rate','unemployment benefit spending','employment rate','not unemployment','underemployment rate','GDP per hour','unemployment inflation'])('refuses unrelated or qualified series %s before fetching',async(input)=>{const f=vi.fn();vi.stubGlobal('fetch',f);await expectApiError(handleMacro({indicator:input,country:'DEU'}),422,'UNSUPPORTED_INDICATOR');expect(f).not.toHaveBeenCalled();});
});
