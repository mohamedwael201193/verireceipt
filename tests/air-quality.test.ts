import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/air-quality-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleAirQuality, parseAirQuality } from "../src/handlers/airQuality";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real Open-Meteo body, retrieved 2026-11-23 (Cairo coordinates).
const cairo = readFileSync(join(__dirname, "fixtures/air-quality/open-meteo-cairo-current.json"), "utf8");
function stub(body: string | "ERR" = cairo): void {
  vi.stubGlobal("fetch", async () => {
    if (body === "ERR") throw new Error("test outage");
    return new Response(body, { status: 200 });
  });
}
describe("AIR_QUALITY_INDEX_GENERAL", () => {
  it("requires both coordinates in range", async () => {
    await expect(handleAirQuality({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleAirQuality({ lat: "30" })).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleAirQuality({ lat: "91", lon: "31" })).rejects.toMatchObject({ status: 400, code: "BAD_COORDINATE" });
    await expect(handleAirQuality({ lat: "abc", lon: "31" })).rejects.toMatchObject({ status: 400, code: "BAD_COORDINATE" });
  });
  it("serves the real current reading with honest model-blend scoping", async () => {
    stub();
    const result = await handleAirQuality({ lat: "30.0444", lon: "31.2357" });
    expect(result.aqi).toBe(75);
    expect(result.aqi_scale).toBe("US EPA");
    expect(result.acceptable).toBe(true);
    expect(result.pm2_5_ugm3).toBe(19.9);
    expect(result.latitude).toBe(30.0); // the grid cell the API snapped to
    expect(result.longitude).toBe(31.2);
    const ans = String(result.answer);
    expect(ans).toContain("modelled current conditions");
    expect(ans).toContain("not a ground-station measurement");
    expect(ans).toContain("never a forecast");
    expect(result.confidence).toBe(0.8);
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("AIR_QUALITY_INDEX_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(JSON.parse(stored.evidence.toString("utf8")).raw_bodies.current).toBe(cairo);
  });
  it("acceptable flips at the EPA moderate boundary, never guessed", () => {
    const at = JSON.parse(cairo); at.current.us_aqi = 100;
    expect(parseAirQuality(JSON.stringify(at)).us_aqi).toBe(100);
    const over = JSON.parse(cairo); over.current.us_aqi = 101;
    expect(parseAirQuality(JSON.stringify(over)).us_aqi).toBe(101);
  });
  it("pins the 100 threshold: a 150-AQI body is not acceptable and says so", async () => {
    const bad = JSON.parse(cairo); bad.current.us_aqi = 150;
    stub(JSON.stringify(bad));
    const result = await handleAirQuality({ lat: "30.0444", lon: "31.2357" });
    expect(result.aqi).toBe(150);
    expect(result.acceptable).toBe(false);
    expect(String(result.answer)).toContain("above 100");
  });
  it("a missing current AQI is an honest 422", async () => {
    const edited = JSON.parse(cairo); delete edited.current.us_aqi;
    stub(JSON.stringify(edited));
    await expect(handleAirQuality({ lat: "30", lon: "31" }))
      .rejects.toMatchObject({ status: 422, code: "NO_USABLE_AQI" });
  });
  it("an upstream outage is an honest 502", async () => {
    stub("ERR");
    await expect(handleAirQuality({ lat: "30", lon: "31" }))
      .rejects.toMatchObject({ status: 502, code: "OPEN_METEO_UNREACHABLE" });
  });
  it("GET /v1/air-quality is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/air-quality" })).toBe(true);
    stub();
    const res = await app.inject({ method: "GET", url: "/v1/air-quality?lat=30.0444&lon=31.2357" });
    expect(res.statusCode).toBe(200);
    expect(res.json().aqi).toBe(75);
    await app.close();
  });
});
