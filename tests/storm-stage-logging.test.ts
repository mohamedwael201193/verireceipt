import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/storm-stage-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); resetStormForecastForTests(); });
import { resetStormForecastForTests } from "../src/handlers/stormForecast";
import { handleStormAlert, logStormStageFailure, stormHttpClass } from "../src/handlers/stormAlert";

const STAGES = ["geocoder", "forecast", "nws"], CLASSES = ["429", "4xx", "5xx", "timeout", "parse", "none"];
function stageLines(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("storm_stage_failure")).map((l: string) => JSON.parse(l) as Record<string, string>);
}
function expectClosed(lines: Record<string, string>[]) {
  for (const l of lines) {
    expect(Object.keys(l).sort()).toEqual(["event", "http_class", "stage"]);
    expect(l.event).toBe("storm_stage_failure");
    expect(STAGES).toContain(l.stage); expect(CLASSES).toContain(l.http_class);
  }
}
describe("STORM_ALERT_GENERAL stage failure logging", () => {
  it("geocoder failure logs one closed-set line before the 502", async () => {
    for (const [mode, cls] of [["429", "429"], ["503", "5xx"], ["404", "4xx"], ["throw", "none"], ["parse", "parse"]] as const) {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.stubGlobal("fetch", async () => {
        if (mode === "throw") throw new Error("secret upstream text /private");
        if (mode === "parse") return new Response('{"results":[{"latitude":91}]}', { status: 200 });
        return new Response("secret upstream body", { status: Number(mode) });
      });
      await expect(handleStormAlert({ location: "Springfield" })).rejects.toMatchObject({ status: 502, code: "GEOCODER_UNREACHABLE" });
      const lines = stageLines(spy); expectClosed(lines);
      expect(lines).toEqual([{ event: "storm_stage_failure", stage: "geocoder", http_class: cls }]);
      expect(JSON.stringify(spy.mock.calls)).not.toContain("secret upstream");
      spy.mockRestore(); vi.unstubAllGlobals();
    }
  });

  it("forecast and nws both failing logs one closed-set line per stage before the 502", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (url: unknown) => {
      if (String(url).startsWith("https://api.open-meteo.com/")) return new Response("secret", { status: 429 });
      return new Response("secret", { status: 503 });
    });
    await expect(handleStormAlert({ location: "27.345,-97.225" })).rejects.toMatchObject({ status: 502, code: "STORM_FORECAST_UNAVAILABLE" });
    const lines = stageLines(spy); expectClosed(lines);
    expect(lines).toEqual([
      { event: "storm_stage_failure", stage: "forecast", http_class: "429" },
      { event: "storm_stage_failure", stage: "nws", http_class: "5xx" },
    ]);
  });

  it("the logger coerces anything outside the closed sets", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logStormStageFailure("secret" as never, "HTTP 500 body text" as never);
    expectClosed(stageLines(spy));
    expect(stormHttpClass(new Error("anything else"))).toBe("none");
    expect(stormHttpClass(new Error("public source returned HTTP 429"))).toBe("429");
    expect(stormHttpClass(new Error("forecast deadline"))).toBe("timeout");
  });
});
