import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/storm-stage-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); resetStormForecastForTests(); });
import { resetStormForecastForTests, readStormForecast } from "../src/handlers/stormForecast";
import { readPublicBody, retryAfterBucket, limitScope } from "../src/core/publicSource";
import { handleStormAlert, logStormStageFailure, stormHttpClass } from "../src/handlers/stormAlert";

const STAGES = ["geocoder", "forecast", "nws"], CLASSES = ["429", "4xx", "5xx", "timeout", "parse", "none"];
function stageLines(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("storm_stage_failure")).map((l: string) => JSON.parse(l) as Record<string, string>);
}
function expectClosed(lines: Record<string, string>[]) {
  for (const l of lines) {
    expect(["event", "http_class", "stage"].every(k => k in l)).toBe(true);
    for (const k of Object.keys(l)) expect(["event", "http_class", "stage", "refusal", "retry_after", "limit_scope"]).toContain(k);
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
      { event: "storm_stage_failure", stage: "forecast", http_class: "429", retry_after: "absent", limit_scope: "other" },
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

const REFUSALS = ["backoff", "budget_day", "budget_hour", "budget_minute"], BUCKETS = ["absent", "le_60s", "le_900s", "gt_900s", "unparseable"], SCOPES = ["minutely", "hourly", "daily", "other"];
async function throttled(headers: Record<string, string> | undefined, body: string | null, status = 429) {
  vi.stubGlobal("fetch", async () => new Response(body, { status, headers }));
  try { await readPublicBody("https://example.test/x"); } catch (e) { return e; }
  throw new Error("expected rejection");
}

describe("Retry-After bucket and limit scope on a 429", () => {
  it.each([["30", "le_60s"], ["60", "le_60s"], ["61", "le_900s"], ["600", "le_900s"], ["900", "le_900s"], ["901", "gt_900s"], ["7200", "gt_900s"], [undefined, "absent"],
    ["Wed, 21 Oct 2026 07:28:00 GMT", "unparseable"], ["", "unparseable"], ["-5", "unparseable"], ["1.5", "unparseable"], ["abc", "unparseable"]] as const)("Retry-After %j -> %s", async (value, bucket) => {
    const e = await throttled(value === undefined ? undefined : { "retry-after": value }, "x");
    expect(retryAfterBucket(e)).toBe(bucket);
    expect(e).toMatchObject({ status: 502, message: "public source returned HTTP 429" });
  });
  it("only a 429 records a bucket or scope", async () => {
    for (const st of [403, 500]) { const e = await throttled({ "retry-after": "30" }, "Hourly", st); expect(retryAfterBucket(e)).toBeUndefined(); expect(limitScope(e)).toBeUndefined(); }
  });
  it.each([["Minutely API request limit exceeded", "minutely"], ["hourly api request limit exceeded", "hourly"], ["DAILY API REQUEST LIMIT", "daily"], ["Daily or hourly limit", "hourly"], ["daily and minutely", "minutely"], ["Too many requests", "other"], ["", "other"]] as const)("body %j -> %s", async (text, scope) => {
    const e = await throttled(undefined, text);
    expect(limitScope(e)).toBe(scope);
    expect(e).toMatchObject({ status: 502, message: "public source returned HTTP 429" });
    expect(JSON.stringify(e)).not.toContain("limit exceeded");
  });
  it("reads only the first 512 bytes of a long body and still refuses the same way", async () => {
    let pulls = 0, cancelled = false;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(enc.encode(pulls <= 2 ? "x".repeat(256) : pulls === 3 ? "Daily" : "x".repeat(256))); if (pulls > 40) c.close(); }, cancel() { cancelled = true; } });
    vi.stubGlobal("fetch", async () => new Response(stream, { status: 429 }));
    const e = await readPublicBody("https://example.test/x").catch(x => x);
    expect(limitScope(e)).toBe("other");
    expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(5);
    expect(e).toMatchObject({ status: 502, message: "public source returned HTTP 429" });
    const split = await throttled(undefined, "x".repeat(509) + "Hourly");
    expect(limitScope(split)).toBe("other");
    const edge = await throttled(undefined, "x".repeat(506) + "Daily");
    expect(limitScope(edge)).toBe("daily");
  });
});

describe("storm forecast refusal labels keep identical decisions", () => {
  async function drive(limitHour: boolean) {
    vi.useFakeTimers();
    const f = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", f);
    let n = 0;
    for (;;) {
      const lat = (n % 2000) / 100, lon = Math.floor(n / 2000) + 1;
      try { await readStormForecast(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`); }
      catch (e) { return { n, label: (e as { stormRefusal?: string }).stormRefusal, calls: f.mock.calls.length, cause: (e as { stormCause?: unknown }).stormCause }; }
      n++;
      if (n % 30 === 0) await vi.advanceTimersByTimeAsync(61000);
      if (!limitHour && n % 300 === 0) await vi.advanceTimersByTimeAsync(3600000);
    }
  }
  it("30 per minute -> budget_minute", async () => {
    vi.useFakeTimers(); const f = vi.fn(async () => new Response("{}")); vi.stubGlobal("fetch", f);
    for (let i = 0; i < 30; i++) await readStormForecast(`https://api.open-meteo.com/v1/forecast?latitude=${i}&longitude=1`);
    const e = await readStormForecast("https://api.open-meteo.com/v1/forecast?latitude=60&longitude=1").catch(x => x);
    expect(e).toMatchObject({ status: 502, code: "STORM_FORECAST_UNAVAILABLE", stormRefusal: "budget_minute" });
    expect(f).toHaveBeenCalledTimes(30);
  });
  it("300 per hour -> budget_hour", async () => {
    const r = await drive(true);
    expect(r).toMatchObject({ n: 300, label: "budget_hour", calls: 300 });
    expect(r.cause).toBeInstanceOf(Error);
  });
  it("2000 per day -> budget_day", async () => {
    const r = await drive(false);
    expect(r).toMatchObject({ n: 2000, label: "budget_day", calls: 2000 });
  });
  it("429 backoff -> backoff, then admitted again after one hour", async () => {
    vi.useFakeTimers(); const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = vi.fn(async () => new Response("Hourly limit", { status: 429, headers: { "retry-after": "7200" } })); vi.stubGlobal("fetch", f);
    const first = await readStormForecast("https://api.open-meteo.com/v1/forecast?latitude=1&longitude=1").catch(x => x);
    expect(first.stormRefusal).toBeUndefined();
    expect(spy.mock.calls.map(c => JSON.parse(String(c[0])))).toEqual([{ event: "storm_backoff_set", cause: "http_429", retry_after: "gt_900s", limit_scope: "hourly" }]);
    const second = await readStormForecast("https://api.open-meteo.com/v1/forecast?latitude=2&longitude=2").catch(x => x);
    expect(second.stormRefusal).toBe("backoff"); expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3600000 - 1);
    expect((await readStormForecast("https://api.open-meteo.com/v1/forecast?latitude=3&longitude=3").catch(x => x)).stormRefusal).toBe("backoff");
    await vi.advanceTimersByTimeAsync(1);
    await readStormForecast("https://api.open-meteo.com/v1/forecast?latitude=4&longitude=4").catch(() => {});
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("403 sets the same backoff and logs no retry_after", async () => {
    vi.useFakeTimers(); const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("no", { status: 403, headers: { "retry-after": "5" } }));
    await readStormForecast("https://api.open-meteo.com/v1/forecast?latitude=1&longitude=1").catch(() => {});
    expect(spy.mock.calls.map(c => JSON.parse(String(c[0])))).toEqual([{ event: "storm_backoff_set", cause: "http_403" }]);
  });
});

describe("storm_stage_failure forecast labels", () => {
  it("fresh 429 logs retry_after and limit_scope; a refused read after it logs refusal backoff with class none; nothing raw leaks", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {}), warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (url: unknown) => String(url).startsWith("https://api.open-meteo.com/")
      ? new Response("Daily API request limit exceeded SECRETBODY", { status: 429, headers: { "retry-after": "4242" } })
      : new Response("secret", { status: 503 }));
    await expect(handleStormAlert({ location: "27.345,-97.225" })).rejects.toMatchObject({ status: 502, code: "STORM_FORECAST_UNAVAILABLE" });
    await expect(handleStormAlert({ location: "28.5,-97.2" })).rejects.toMatchObject({ status: 502, code: "STORM_FORECAST_UNAVAILABLE" });
    const all = spy.mock.calls.map(c => JSON.parse(String(c[0])) as Record<string, string>);
    expect(all).toEqual([
      { event: "storm_backoff_set", cause: "http_429", retry_after: "gt_900s", limit_scope: "daily" },
      { event: "storm_stage_failure", stage: "forecast", http_class: "429", retry_after: "gt_900s", limit_scope: "daily" },
      { event: "storm_stage_failure", stage: "nws", http_class: "5xx" },
      { event: "storm_stage_failure", stage: "forecast", http_class: "none", refusal: "backoff" },
      { event: "storm_stage_failure", stage: "nws", http_class: "5xx" },
    ]);
    const stage = all.filter(l => l.event === "storm_stage_failure"); expectClosed(stage);
    for (const l of all) { if (l.refusal) expect(REFUSALS).toContain(l.refusal); if (l.retry_after) expect(BUCKETS).toContain(l.retry_after); if (l.limit_scope) expect(SCOPES).toContain(l.limit_scope); }
    const dump = JSON.stringify([spy.mock.calls, errSpy.mock.calls, warnSpy.mock.calls]);
    for (const bad of ["4242", "SECRETBODY", "limit exceeded", "open-meteo", "27.345", "-97.2", "https://"]) expect(dump).not.toContain(bad);
  });
  it("Retry-After date and absent header map to closed buckets in the stage line", async () => {
    for (const [hdr, bucket] of [[{ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, "unparseable"], [undefined, "absent"]] as const) {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.stubGlobal("fetch", async (url: unknown) => String(url).startsWith("https://api.open-meteo.com/") ? new Response("", { status: 429, headers: hdr }) : new Response("", { status: 503 }));
      await expect(handleStormAlert({ location: "27.345,-97.225" })).rejects.toMatchObject({ status: 502 });
      const f = stageLines(spy).find(l => l.stage === "forecast")!;
      expect(f).toEqual({ event: "storm_stage_failure", stage: "forecast", http_class: "429", retry_after: bucket, limit_scope: "other" });
      expect(JSON.stringify(spy.mock.calls)).not.toContain("Oct");
      spy.mockRestore(); vi.unstubAllGlobals(); resetStormForecastForTests();
    }
  });
  it("the logger coerces unknown refusal, retry_after and limit_scope values", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logStormStageFailure("forecast", "429", { refusal: "raw text", retry_after: "Wed, 1 Jan", limit_scope: "body text" });
    logStormStageFailure("nws", "5xx", { refusal: "backoff", retry_after: "le_60s", limit_scope: "daily" });
    expect(stageLines(spy)).toEqual([{ event: "storm_stage_failure", stage: "forecast", http_class: "429" }, { event: "storm_stage_failure", stage: "nws", http_class: "5xx" }]);
  });
});
