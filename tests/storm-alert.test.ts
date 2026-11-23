import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/storm-alert-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); resetStormForecastForTests(); });
import { resetStormForecastForTests } from "../src/handlers/stormForecast";
const actualForecast=JSON.parse(readFileSync(join(__dirname,"fixtures/storm-forecast/cairo.json"),"utf8"));
// Retimed controls derived from the real capture. Exact unmodified replay lives in storm-forecast.test.ts.
function forecastResponse(url:string):Response|null {
 if(!url.startsWith("https://api.open-meteo.com/"))return null;
 const u=new URL(url),start=Date.parse(u.searchParams.get("start_hour")+"Z"),end=Date.parse(u.searchParams.get("end_hour")+"Z"),n=(end-start)/3600000+1;
 const j=structuredClone(actualForecast);j.hourly={time:Array.from({length:n},(_,i)=>start/1000+i*3600),wind_gusts_10m:Array.from({length:n},(_,i)=>actualForecast.hourly.wind_gusts_10m[i%24]),precipitation:Array(n).fill(0)};return new Response(JSON.stringify(j));
}
import { handleStormAlert, parseAlerts, assessAlerts, parseLocation } from "../src/handlers/stormAlert";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real NWS api.weather.gov bodies, retrieved 2026-11-23.
const corpusAlerts = readFileSync(join(__dirname, "fixtures/storm-alert/nws-active-corpus-christi.json"), "utf8");
const corpusPoints = readFileSync(join(__dirname, "fixtures/storm-alert/nws-points-corpus.json"), "utf8");
const louisvilleNone = readFileSync(join(__dirname, "fixtures/storm-alert/nws-active-louisville-none.json"), "utf8");
// Both fixture alerts are active at this instant (2026-11-23T01:00Z).
const FROZEN = new Date("2026-11-23T01:00:00Z");
function stub(opts: { alerts?: string; points?: string | "404" } = {}): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    const forecast=forecastResponse(u);if(forecast)return forecast;
    if (u.includes("/points/")) {
      if (opts.points === "404") return new Response("{}", { status: 404 });
      if (opts.points === "ERR") throw new Error("test outage");
      return new Response(opts.points ?? corpusPoints, { status: 200 });
    }
    if (opts.alerts === "ERR") throw new Error("test outage");
    return new Response(opts.alerts ?? corpusAlerts, { status: 200 });
  });
}
describe("STORM_ALERT_GENERAL", () => {
  it("location may be lat,lon or a place name; window_hours is bounded", async () => {
    await expect(handleStormAlert({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    // A place name the geocoder cannot resolve is an honest 422, not a guess.
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
    const forecast=forecastResponse(u);if(forecast)return forecast;
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response('{"results":[]}', { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    await expect(handleStormAlert({ location: "Zzznotaplace" })).rejects.toMatchObject({ status: 422, code: "PLACE_NOT_FOUND" });
    vi.unstubAllGlobals();
    await expect(handleStormAlert({ location: "91,0" })).rejects.toMatchObject({ status: 400, code: "BAD_LOCATION" });
    await expect(handleStormAlert({ location: "27.3,-97.2", window_hours: "0" })).rejects.toMatchObject({ status: 400, code: "BAD_WINDOW" });
    await expect(handleStormAlert({ location: "27.3,-97.2", window_hours: "241" })).rejects.toMatchObject({ status: 400, code: "BAD_WINDOW" });
    expect(parseLocation(" 27.345 , -97.225 ")).toEqual({ lat: 27.345, lon: -97.225 });
  });
  it("parses the real issued products with their issue/expiry times", () => {
    const alerts = parseAlerts(corpusAlerts);
    expect(alerts.length).toBe(2);
    const smw = alerts.find((a) => a.event === "Special Marine Warning")!;
    expect(smw.severity).toBe("Severe");
    expect(smw.score).toBe(0.75);
    expect(smw.sent).toContain("2026-11-22");
    expect(smw.expires).toBe("2026-11-22T20:00:00-06:00");
  });
  it("risk is the worst severity among in-window products; out-of-window products are disclosed, not scored", () => {
    const alerts = parseAlerts(corpusAlerts);
    // At 01:00Z only the Special Marine Warning counts: the Small Craft
    // Advisory's onset (03:00Z) is after the assessment instant, so it is
    // disclosed as excluded, never scored.
    const r = assessAlerts(alerts, FROZEN.toISOString(), 24);
    expect(r.score).toBe(0.75);
    expect(r.level).toBe("HIGH");
    expect(r.counted.map((a) => a.event)).toEqual(["Special Marine Warning"]);
    expect(r.excluded.map((a) => a.event)).toEqual(["Small Craft Advisory"]);
    // A 1-hour window from 01:00Z keeps the warning (expires 02:00Z) and
    // excludes the Small Craft Advisory (expires 02:45Z), disclosed not scored.
    const narrow = assessAlerts(alerts, FROZEN.toISOString(), 1);
    expect(narrow.counted.map((a) => a.event)).toEqual(["Special Marine Warning"]);
    expect(narrow.excluded.map((a) => a.event)).toEqual(["Small Craft Advisory"]);
    expect(narrow.score).toBe(0.75);
  });
  it("serves the real point answer with honest issued-product scoping", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    stub();
    const result = await handleStormAlert({ location: "27.345,-97.225", window_hours: "24" });
    expect(result.risk_score).toBe(0.75);
    expect(result.risk_level).toBe("HIGH");
    // schema off-chain field `window`: the assessed interval, ISO 8601
    expect(result.window).toBe(`${FROZEN.toISOString()}/${new Date(FROZEN.getTime() + 24 * 3600_000).toISOString()}`);
    expect(result.peak_gust_kmh).toBe(22.3);
    expect(result.precipitation_mm).toBe(0);
    const ans = String(result.answer);
    expect(ans).toContain("NWS available");
    expect(ans).toContain("Special Marine Warning (Severe)");
    expect(ans).toContain("expires 2026-11-22T20:00:00-06:00");
    expect(ans).toContain("VeriReceipt heuristic");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("STORM_ALERT_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(JSON.parse(stored.evidence.toString("utf8")).raw_bodies.alerts).toBe(corpusAlerts);
  });
  it("no active products is LOW 0, never an error", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    stub({ alerts: louisvilleNone });
    const result = await handleStormAlert({ location: "38.2527,-85.7585" });
    expect(result.risk_score).toBe(0);
    expect(result.risk_level).toBe("LOW");
    expect(String(result.answer)).toContain("scored issued products (none)");
  });
  it("S1: a place name is geocoded, resolved and named in the answer", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    const geo = JSON.stringify({ results: [{ name: "Corpus Christi", latitude: 27.8006, longitude: -97.3964, country: "United States", admin1: "Texas", country_code: "US" }] });
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
    const forecast=forecastResponse(u);if(forecast)return forecast;
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response(geo, { status: 200 });
      if (u.includes("/points/")) return new Response(corpusPoints, { status: 200 });
      return new Response(corpusAlerts, { status: 200 });
    });
    const result = await handleStormAlert({ location: "Corpus Christi", window_hours: "24" });
    expect(result.risk_score).toBe(0.75);
    const ans = String(result.answer);
    expect(ans).toContain("Corpus Christi, Texas, United States (27.8006, -97.3964)");
    expect(ans).toContain("Special Marine Warning (Severe)");
    // Outside the NWS grid after geocoding stays an honest 422, never LOW.
    const geoCairo = JSON.stringify({ results: [{ name: "Cairo", latitude: 30.0444, longitude: 31.2357, country: "Egypt", country_code: "EG" }] });
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
    const forecast=forecastResponse(u);if(forecast)return forecast;
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response(geoCairo, { status: 200 });
      if (u.includes("/points/")) return new Response("{}", { status: 404 });
      throw new Error(`unexpected fetch ${u}`);
    });
    expect((await handleStormAlert({ location: "Cairo, Egypt" })).nws_status).toBe("outside NWS grid");
  });

  it("outside NWS grid uses disclosed forecast-only risk", async () => {
    stub({ points: "404" });
    expect((await handleStormAlert({ location: "48.85,2.35" })).nws_status).toBe("outside NWS grid");
  });
  it("NWS outage is disclosed, not mistaken for no warnings", async () => {
    stub({ points: "ERR" });
    const r=await handleStormAlert({ location: "27.3,-97.2" });expect(r.nws_status).toBe("unavailable");expect(r.answer).toContain("does not confirm absence of official warnings");
  });
  it("GET /v1/storm-alert is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/storm-alert" })).toBe(true);
    await app.close();
  });
});

describe("storm-alert horizon clause (reviewer follow-up)", () => {
  it("a Severe product expiring ~11h out: 1h window excludes with score 0, 24h window counts with 0.75", () => {
    const now = "2026-11-23T01:00:00.000Z";
    const severe = {
      event: "Severe Thunderstorm Warning", severity: "Severe", area: "Test County",
      sent: "2026-11-23T00:30:00.000Z", effective: "2026-11-23T00:30:00.000Z",
      onset: "2026-11-23T00:30:00.000Z", expires: "2026-11-23T12:00:00.000Z", // 11h out
      score: 0.75,
    };
    const narrow = assessAlerts([severe], now, 1);
    expect(narrow.score).toBe(0);
    expect(narrow.counted).toHaveLength(0);
    expect(narrow.excluded).toHaveLength(1);
    const wide = assessAlerts([severe], now, 24);
    expect(wide.score).toBe(0.75);
    expect(wide.counted).toHaveLength(1);
    expect(wide.excluded).toHaveLength(0);
  });
});

describe('storm ranked-name policy, accepted actual geocoder capture',()=>{
 const geo=readFileSync(join(__dirname,'fixtures/route-ranked/springfield.json'),'utf8');
 it('accepts actual multi-result Springfield with chosen result and ambiguity disclosure',async()=>{
  const top=JSON.parse(geo).results[0];vi.useFakeTimers();vi.setSystemTime(FROZEN);
  vi.stubGlobal('fetch',async(input:unknown)=>{const u=String(input);const forecast=forecastResponse(u);if(forecast)return forecast;return new Response(u.includes('geocoding-api')?geo:u.includes('/points/')?corpusPoints:corpusAlerts);});
  const r=await handleStormAlert({location:'Springfield'});expect(r.location).toBe(top.latitude+','+top.longitude);expect(String(r.answer)).toContain('rank 1, provider order; not confirmed unique');expect(String(r.answer)).toContain(JSON.parse(geo).results.length+' matches returned');
  const stored=await getReceiptEvidence((r.receipt as any).receipt_id);const ev=JSON.parse(stored.evidence!.toString());expect(ev.geocoder.raw_body).toBe(geo);expect(ev.geocoder.sha256).toBe(sha256Hex(Buffer.from(geo)));expect(sha256Hex(stored.evidence!)).toBe((r.receipt as any).raw_response_sha256);
 });
 it('invalid first result refuses instead of selecting valid later result',async()=>{
  const j=JSON.parse(geo);j.results[0].latitude=91;const f=vi.fn(async()=>new Response(JSON.stringify(j)));vi.stubGlobal('fetch',f);
  await expect(handleStormAlert({location:'Springfield'})).rejects.toMatchObject({status:502,code:'GEOCODER_UNREACHABLE'});expect(f).toHaveBeenCalledTimes(1);
 });
});
