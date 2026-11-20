// Loop-lag sampler + job-timing registry tests (Render slowness, 2026-11-20).
//
// The sampler is driven deterministically: vitest fake timers fire the
// 1 s interval while a manual nowFn supplies the clock, so a stall is
// injected by jumping the mock clock between ticks. The /health-shape
// test lives in scratch (~/workspace/render-slow-scratch/
// loopLag-health.test.ts) — it needs the server.ts wiring, which is
// deferred past the concurrent TVL R6 server.ts edit; it moves here
// once the wiring lands.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getJobsSnapshot,
  getLoopLagSnapshot,
  recordJobDuration,
  recordJobSkipped,
  resetInstrumentationForTests,
  startJob,
  startLoopLagSampler,
} from "../src/core/loopLag";

beforeEach(() => {
  resetInstrumentationForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  resetInstrumentationForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("loop-lag sampler", () => {
  it("reports zero lag when ticks land on time", () => {
    vi.useFakeTimers();
    let mockNow = 1_000_000;
    startLoopLagSampler(1000, () => mockNow);
    vi.advanceTimersByTime(1000);
    mockNow += 1000;
    vi.advanceTimersByTime(1000);
    const snap = getLoopLagSnapshot(mockNow);
    expect(snap.currentMs).toBe(0);
    expect(snap.max1mMs).toBe(0);
    expect(snap.max5mMs).toBe(0);
    expect(snap.worstAt).toBeNull();
    expect(snap.samples).toBe(2);
  });

  it("detects a 1500ms stall: current/max/worstAt track it, WARN logs once", () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let mockNow = 1_000_000;
    startLoopLagSampler(1000, () => mockNow);
    vi.advanceTimersByTime(1000); // on-time tick, lag 0
    mockNow += 2500; // the loop was stuck 1.5s past the next tick
    vi.advanceTimersByTime(1000); // late tick: lag = 2500 - 1000 = 1500
    const snap = getLoopLagSnapshot(mockNow);
    expect(snap.currentMs).toBe(1500);
    expect(snap.max1mMs).toBe(1500);
    expect(snap.max5mMs).toBe(1500);
    expect(snap.worstAt).toBe(new Date(1_002_500).toISOString());
    expect(snap.samples).toBe(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0] as string).toContain("1500ms");
  });

  it("does not WARN for a sub-threshold (500ms) sample", () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let mockNow = 1_000_000;
    startLoopLagSampler(1000, () => mockNow);
    vi.advanceTimersByTime(1000);
    mockNow += 1500; // 500ms late
    vi.advanceTimersByTime(1000);
    expect(getLoopLagSnapshot(mockNow).currentMs).toBe(500);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("rolling windows: a 1500ms sample leaves max1m after 60s but stays in max5m", () => {
    vi.useFakeTimers();
    let mockNow = 1_000_000;
    startLoopLagSampler(1000, () => mockNow);
    vi.advanceTimersByTime(1000);
    mockNow += 2500;
    vi.advanceTimersByTime(1000); // lag-1500 sample at t=1_002_500
    const after61s = getLoopLagSnapshot(1_002_500 + 61_000);
    expect(after61s.max1mMs).toBe(0);
    expect(after61s.max5mMs).toBe(1500);
    expect(after61s.worstAt).toBe(new Date(1_002_500).toISOString());
    const after5m = getLoopLagSnapshot(1_002_500 + 300_001);
    expect(after5m.max1mMs).toBe(0);
    expect(after5m.max5mMs).toBe(0);
    expect(after5m.worstAt).toBeNull();
  });

  it("snapshot is all-zero before the sampler ever starts (mutant: unwired /health)", () => {
    const snap = getLoopLagSnapshot(1_000_000);
    expect(snap).toEqual({ currentMs: 0, max1mMs: 0, max5mMs: 0, worstAt: null, samples: 0 });
    expect(getJobsSnapshot()).toEqual({});
  });

  it("startLoopLagSampler is idempotent: a second call returns the same timer", () => {
    vi.useFakeTimers();
    let mockNow = 1_000_000;
    const t1 = startLoopLagSampler(1000, () => mockNow);
    const t2 = startLoopLagSampler(1000, () => mockNow);
    expect(t2).toBe(t1);
    vi.advanceTimersByTime(1000);
    expect(getLoopLagSnapshot(mockNow).samples).toBe(1);
  });
});

describe("job-timing registry", () => {
  it("recordJobDuration tracks last/max/runs/lastRunAt; max never falls", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    recordJobDuration("grid-ingester", 60000, Date.parse("2026-11-20T09:04:42.000Z"));
    let snap = getJobsSnapshot();
    expect(snap["grid-ingester"]).toEqual({
      lastDurationMs: 60000,
      maxDurationMs: 60000,
      lastRunAt: "2026-11-20T09:04:42.000Z",
      runs: 1,
      skipped: 0,
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("grid-ingester"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("60000ms"));
    recordJobDuration("grid-ingester", 5000, Date.parse("2026-11-20T09:09:42.000Z"));
    snap = getJobsSnapshot();
    expect(snap["grid-ingester"].lastDurationMs).toBe(5000);
    expect(snap["grid-ingester"].maxDurationMs).toBe(60000);
    expect(snap["grid-ingester"].runs).toBe(2);
    expect(snap["grid-ingester"].lastRunAt).toBe("2026-11-20T09:09:42.000Z");
  });

  it("a fake 60s job surfaces maxDurationMs >= 60000 (mutant: registry path)", () => {
    recordJobDuration("grid-ingester", 60000, Date.now());
    expect(getJobsSnapshot()["grid-ingester"].maxDurationMs).toBeGreaterThanOrEqual(60000);
  });

  it("recordJobSkipped counts skips without touching durations", () => {
    recordJobDuration("grid-ingester", 1000, Date.now());
    recordJobSkipped("grid-ingester");
    recordJobSkipped("grid-ingester");
    const st = getJobsSnapshot()["grid-ingester"];
    expect(st.skipped).toBe(2);
    expect(st.runs).toBe(1);
    expect(st.maxDurationMs).toBe(1000);
  });

  it("startJob/end measures wall time (fake timers + system time)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T09:04:42.000Z"));
    const run = startJob("grid-ingester");
    vi.setSystemTime(new Date("2026-11-20T09:04:43.234Z"));
    expect(run.end()).toBe(1234);
    const st = getJobsSnapshot()["grid-ingester"];
    expect(st.lastDurationMs).toBe(1234);
    expect(st.maxDurationMs).toBe(1234);
    expect(st.runs).toBe(1);
    expect(st.lastRunAt).toBe("2026-11-20T09:04:42.000Z");
  });

  it("jobs are independent per name", () => {
    recordJobDuration("grid-ingester", 1000, Date.now());
    recordJobDuration("backup-snapshot", 2000, Date.now());
    const snap = getJobsSnapshot();
    expect(Object.keys(snap).sort()).toEqual(["backup-snapshot", "grid-ingester"]);
    expect(snap["backup-snapshot"].maxDurationMs).toBe(2000);
  });
});

describe("ingester overlap guard (startIngester)", () => {
  it("a second tick while a run is in flight is skipped, not stacked", async () => {
    vi.useFakeTimers();
    const { startIngester } = await import("../src/jobs/gridIngester");
    const realFetch = globalThis.fetch;
    // A fetch that never resolves: the first cycle stays in flight forever.
    globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch;
    try {
      const timer = startIngester(100);
      // Let the initial run start (fetch pending) and two ticks fire.
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      const st = getJobsSnapshot()["grid-ingester"];
      expect(st).toBeDefined();
      expect(st.skipped).toBeGreaterThanOrEqual(2);
      expect(st.runs).toBe(0);
      clearInterval(timer);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// ROUND-2 PINS (M2/M4). Additions only: no existing test above was edited.
// ---------------------------------------------------------------------------

describe("round-2 pins (M2/M4)", () => {
  it("startJob/end: a second end() is a no-op (M2)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T09:04:42.000Z"));
    const run = startJob("grid-ingester");
    vi.setSystemTime(new Date("2026-11-20T09:04:43.234Z"));
    expect(run.end()).toBe(1234);
    // Second end() returns the first duration and records nothing.
    expect(run.end()).toBe(1234);
    const st = getJobsSnapshot()["grid-ingester"];
    expect(st.runs).toBe(1);
    expect(st.lastDurationMs).toBe(1234);
    expect(st.maxDurationMs).toBe(1234);
  });

  it("snapshot counts only samples inside the 5-min window (M4)", () => {
    vi.useFakeTimers();
    let mockNow = 1_000_000;
    startLoopLagSampler(1000, () => mockNow);
    vi.advanceTimersByTime(1000);
    mockNow += 1000;
    vi.advanceTimersByTime(1000);
    expect(getLoopLagSnapshot(mockNow).samples).toBe(2);
    // 5 minutes + 1 ms later, with the sampler stopped (no new ticks):
    // the stale samples must not be counted. (Before the fix, samples
    // returned the raw retained-array length, 2, here.)
    const snap = getLoopLagSnapshot(mockNow + 300_001);
    expect(snap.samples).toBe(0);
    expect(snap.max5mMs).toBe(0);
    expect(snap.worstAt).toBeNull();
  });

  it("WARN is strict: a sample of exactly 1000ms does not warn, 1001ms does (M4)", () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let mockNow = 1_000_000;
    startLoopLagSampler(1000, () => mockNow);
    vi.advanceTimersByTime(1000); // on-time tick, lag 0
    mockNow += 2000; // next tick 1000ms late
    vi.advanceTimersByTime(1000);
    expect(getLoopLagSnapshot(mockNow).currentMs).toBe(1000);
    expect(warnSpy).not.toHaveBeenCalled();
    mockNow += 2001; // next tick 1001ms late
    vi.advanceTimersByTime(1000);
    expect(getLoopLagSnapshot(mockNow).currentMs).toBe(1001);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0] as string).toContain("1001ms");
  });
});
