import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/weather-check-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
import { handleWeatherCheck } from "../src/handlers/weatherCheck";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real aviationweather.gov METAR body for HECA, retrieved 2026-11-23.
const heca = readFileSync(join(__dirname, "fixtures/weather-check/metar-heca.json"), "utf8");
function stub(body: string | "ERR" = heca): void {
  vi.stubGlobal("fetch", async () => {
    if (body === "ERR") throw new Error("test outage");
    return new Response(body, { status: 200 });
  });
}
describe("WEATHER_CHECK_TEMPERATURE", () => {
  it("requires an explicit ICAO code, never a place name", async () => {
    await expect(handleWeatherCheck({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleWeatherCheck({ location: "Cairo" })).rejects.toMatchObject({ status: 400, code: "ICAO_REQUIRED" });
    await expect(handleWeatherCheck({ location: "HEC" })).rejects.toMatchObject({ status: 400, code: "ICAO_REQUIRED" });
  });
  it("serves the measured station temperature with identity and freshness", async () => {
    // Freeze within the fixture's 90-minute freshness window (obs 23:30Z).
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    stub();
    const result = await handleWeatherCheck({ location: "heca" });
    expect(result.temperature_c).toBe(16);
    expect(result.station_name).toBe("Cairo Intl, QH, EG");
    const ans = String(result.answer);
    expect(ans).toContain("measured METAR");
    expect(ans).toContain("never a forecast");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("WEATHER_CHECK_TEMPERATURE");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
  });
  it("an unknown station is an honest 422, an outage a 502", async () => {
    stub("[]");
    await expect(handleWeatherCheck({ location: "ZZZQ" })).rejects.toMatchObject({ status: 422, code: "STATION_NOT_FOUND" });
    vi.unstubAllGlobals();
    stub("ERR");
    await expect(handleWeatherCheck({ location: "HECA" })).rejects.toMatchObject({ status: 502, code: "METAR_UNREACHABLE" });
  });
  it("a stale observation is refused, not served", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T05:00:00Z")); // > 90 min after 23:30Z obs
    stub();
    await expect(handleWeatherCheck({ location: "HECA" })).rejects.toMatchObject({ status: 422, code: "NO_USABLE_OBSERVATION" });
  });
  it("GET /v1/weather-check is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/weather-check" })).toBe(true);
    await app.close();
  });
});
