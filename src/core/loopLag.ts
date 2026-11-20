// VeriReceipt — event-loop-lag sampler + job-timing registry.
//
// WHY THIS EXISTS (Render slowness, 2026-11-20): /health flapped three
// times in one morning (57 s response 11:05 EET, unreachable 11:30 EET,
// unreachable 12:15-12:18 EET) while the process never restarted
// (uptime kept counting) and the /health handler itself is trivial
// (no upstream calls, no DB touch). The grid ingester (every 5 min) is
// the largest KNOWN in-process contributor: its NYISO parse loop
// (fresh Intl.DateTimeFormat per CSV row) plus one autocommit SQLite
// write per row stacked into multi-second synchronous bursts per cycle
// (measured round 1 + round 2, on disk — see JUDGE.md §12.3). That is
// NOT an established sole cause: a seconds-long burst, even multiplied
// by Render's 0.5-CPU throttle (≤ ~3x) and even if two cycles stacked
// (unproven — dashboard logs unread), still falls short of 57 s, and no
// in-process sync block can produce 3 minutes of unreachability, so
// minute-scale stalls remain unexplained (Render-side or unknown).
// The dashboard logs are the only place the stall signature could be
// seen, and nothing in the app recorded it — so the next stall would
// have been just as undiagnosable. This module fixes the observability
// half: a cheap 1 s lag sampler and a per-job timing registry, both
// surfaced additively on /health (see the server.ts wiring diff in
// ~/workspace/render-slow-scratch/server-health-wiring.diff — the
// wiring itself is deferred past the concurrent TVL R7 server.ts edit).
//
// COST: one setInterval tick per second, O(1) state. Samples are kept
// only for the last 5 minutes (<= ~300 entries at the 1 s cadence),
// pruned on every tick. No unbounded arrays, no per-request work:
// /health reads precomputed maxima over the retained window.

export interface LoopLagSnapshot {
  /** Lag of the most recent 1 s sample, ms (0 when the sampler never ran). */
  currentMs: number;
  /** Worst sample in the last 60 s, ms. */
  max1mMs: number;
  /** Worst sample in the last 5 min, ms. */
  max5mMs: number;
  /** ISO timestamp of the worst sample in the last 5 min (null when none).
   *  Wall-clock ISO (from Date.now via the sampler's clock): NTP skew can
   *  move it backwards relative to real time, so treat it as a display
   *  timestamp, not a monotonic ordering key. */
  worstAt: string | null;
  /** Samples retained in the 5-min window (counted at read time, so a
   *  stopped sampler's stale samples are not counted). */
  samples: number;
}

export interface JobStats {
  /** Duration of the most recent completed run, ms. */
  lastDurationMs: number;
  /** Longest completed run observed, ms. */
  maxDurationMs: number;
  /** ISO start timestamp of the most recent completed run (null when none). */
  lastRunAt: string | null;
  /** Completed runs. */
  runs: number;
  /** Ticks skipped because a previous run was still in flight. */
  skipped: number;
}

export type JobsSnapshot = Record<string, JobStats>;

export const LOOP_LAG_SAMPLE_INTERVAL_MS = 1000;
export const LOOP_LAG_WARN_MS = 1000;
const WINDOW_1M_MS = 60_000;
const WINDOW_5M_MS = 300_000;

interface LagSample {
  t: number;
  lag: number;
}

let samples: LagSample[] = [];
let samplerTimer: NodeJS.Timeout | null = null;
let expectedNextMs = 0;
let currentLagMs = 0;

/**
 * Start the 1 s loop-lag sampler. Idempotent: a second call returns the
 * existing timer. The timer is unref'd so it never keeps the process
 * (or a test worker) alive on its own. `nowFn` is injectable so tests
 * can drive lag deterministically with fake timers; production passes
 * nothing and Date.now is used. A sample STRICTLY over LOOP_LAG_WARN_MS
 * logs one WARN line (timestamp + lag) for the Render dashboard logs —
 * strictly over, so a sample of exactly 1000 ms does not warn.
 */
export function startLoopLagSampler(
  intervalMs: number = LOOP_LAG_SAMPLE_INTERVAL_MS,
  nowFn: () => number = Date.now,
): NodeJS.Timeout {
  if (samplerTimer) return samplerTimer;
  expectedNextMs = nowFn() + intervalMs;
  samplerTimer = setInterval(() => {
    const now = nowFn();
    const lag = Math.max(0, now - expectedNextMs);
    expectedNextMs = now + intervalMs;
    currentLagMs = lag;
    samples.push({ t: now, lag });
    const cutoff = now - WINDOW_5M_MS;
    while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
    if (lag > LOOP_LAG_WARN_MS) {
      console.warn(
        `verireceipt: event-loop lag ${lag}ms at ${new Date(now).toISOString()} ` +
          `(sample exceeded ${LOOP_LAG_WARN_MS}ms)`,
      );
    }
  }, intervalMs);
  if (typeof samplerTimer.unref === "function") samplerTimer.unref();
  return samplerTimer;
}

/** Stop the sampler (tests / shutdown). Snapshots keep their last values. */
export function stopLoopLagSampler(): void {
  if (samplerTimer) {
    clearInterval(samplerTimer);
    samplerTimer = null;
  }
}

/** Current lag snapshot over the retained 5-min window. Zeroes when never sampled. */
export function getLoopLagSnapshot(nowMs: number = Date.now()): LoopLagSnapshot {
  const cutoff1m = nowMs - WINDOW_1M_MS;
  const cutoff5m = nowMs - WINDOW_5M_MS;
  let max1m = 0;
  let max5m = 0;
  let worstAt: string | null = null;
  // Round-2 M4: count only samples inside the 5-min window, at read
  // time. (Before, samples.length counted the raw retained array, so a
  // stopped sampler's stale samples inflated the count.)
  let inWindow = 0;
  for (const s of samples) {
    if (s.t < cutoff5m) continue;
    inWindow++;
    if (s.lag > max5m) {
      max5m = s.lag;
      worstAt = new Date(s.t).toISOString();
    }
    if (s.t >= cutoff1m && s.lag > max1m) max1m = s.lag;
  }
  return { currentMs: currentLagMs, max1mMs: max1m, max5mMs: max5m, worstAt, samples: inWindow };
}

// ---------------------------------------------------------------------------
// Job-timing registry
// ---------------------------------------------------------------------------

const jobs = new Map<string, JobStats>();

function jobStats(name: string): JobStats {
  let st = jobs.get(name);
  if (!st) {
    st = { lastDurationMs: 0, maxDurationMs: 0, lastRunAt: null, runs: 0, skipped: 0 };
    jobs.set(name, st);
  }
  return st;
}

/**
 * Begin timing a job run. Call the returned handle's end() exactly once
 * when the run completes; end() logs one completion line (name +
 * durationMs + timestamp) and returns the duration. For synchronous
 * jobs, prefer recordJobDuration() directly. A second end() call is a
 * no-op returning the first duration (round-2 M2): a double-end must
 * not record a second run.
 */
export function startJob(name: string): { end: () => number } {
  const startedAtMs = Date.now();
  let ended = false;
  let durationMs = 0;
  return {
    end: () => {
      if (ended) return durationMs;
      ended = true;
      durationMs = recordJobDuration(name, Date.now() - startedAtMs, startedAtMs);
      return durationMs;
    },
  };
}

/**
 * Record one completed run (durationMs, started at startedAtMs).
 * Logs the completion line. Returns the duration, for convenience.
 */
export function recordJobDuration(
  name: string,
  durationMs: number,
  startedAtMs: number = Date.now() - durationMs,
): number {
  const st = jobStats(name);
  st.lastDurationMs = durationMs;
  if (durationMs > st.maxDurationMs) st.maxDurationMs = durationMs;
  st.lastRunAt = new Date(startedAtMs).toISOString();
  st.runs += 1;
  console.log(
    `verireceipt: job ${name} completed in ${Math.round(durationMs)}ms at ${st.lastRunAt}`,
  );
  return durationMs;
}

/** Record one tick skipped because a previous run was still in flight. */
export function recordJobSkipped(name: string): void {
  const st = jobStats(name);
  st.skipped += 1;
  console.log(
    `verireceipt: job ${name} skipped (previous run still in flight, ` +
      `skipped=${st.skipped})`,
  );
}

/** Copy of the registry for /health. Empty object when no job ever ran. */
export function getJobsSnapshot(): JobsSnapshot {
  const out: JobsSnapshot = {};
  for (const [name, st] of jobs) out[name] = { ...st };
  return out;
}

/** Test-only reset: stops the sampler, drops samples and registry state. */
export function resetInstrumentationForTests(): void {
  stopLoopLagSampler();
  samples = [];
  currentLagMs = 0;
  expectedNextMs = 0;
  jobs.clear();
}
