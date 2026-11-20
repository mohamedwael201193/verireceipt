// /health-shape test for the Render-slowness wiring (loopLagMs + jobs).
//
// LIVES IN SCRATCH until the server.ts wiring lands: it needs the
// server-health-wiring.diff applied (deferred past the concurrent TVL
// R6 server.ts edit). Move this file to tests/loopLag-health.test.ts
// (or merge into tests/loopLag.test.ts) once the wiring is in, then run:
//   ./node_modules/.bin/vitest run tests/loopLag-health.test.ts
//
// Verified 2026-11-20 in ~/workspace/render-slow-scratch/wiring-check
// (scratch copy of the repo with the diff applied): 3/3 pass.

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpDb = join(mkdtempSync(join(tmpdir(), "looplag-health-test-")), "test.sqlite");
process.env.SQLITE_PATH = tmpDb;

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import {
  getJobsSnapshot,
  recordJobDuration,
  resetInstrumentationForTests,
  startLoopLagSampler,
} from "../src/core/loopLag";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  resetInstrumentationForTests();
});

describe("GET /health with loopLag instrumentation", () => {
  it("keeps the existing fields and adds loopLagMs + jobs", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // Existing fields, unchanged.
    expect(body.status).toBe("ok");
    expect(body.service).toBe("verireceipt");
    expect(typeof body.uptime_s).toBe("number");
    expect(body.upstreams).toEqual({});
    // New additive fields.
    const loopLag = body.loopLagMs as Record<string, unknown>;
    expect(typeof loopLag.currentMs).toBe("number");
    expect(typeof loopLag.max1mMs).toBe("number");
    expect(typeof loopLag.max5mMs).toBe("number");
    expect(loopLag.worstAt === null || typeof loopLag.worstAt === "string").toBe(true);
    expect(typeof loopLag.samples).toBe("number");
    expect(typeof body.jobs).toBe("object");
  });

  it("a fake 60s grid-ingester job surfaces in /health jobs (registry path)", async () => {
    recordJobDuration("grid-ingester", 60000, Date.parse("2026-11-20T09:04:42.000Z"));
    expect(getJobsSnapshot()["grid-ingester"].maxDurationMs).toBeGreaterThanOrEqual(60000);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json() as {
      jobs: Record<string, { maxDurationMs: number; lastDurationMs: number }>;
    };
    expect(body.jobs["grid-ingester"].maxDurationMs).toBeGreaterThanOrEqual(60000);
    expect(body.jobs["grid-ingester"].lastDurationMs).toBe(60000);
  });

  it("mutant: with the instrumentation reset, /health fields read zero/empty (not hardcoded)", async () => {
    resetInstrumentationForTests();
    // The sampler was stopped by the reset; restart it so the shape
    // stays live, but with no samples and no jobs recorded.
    startLoopLagSampler();
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json() as Record<string, unknown>;
    const loopLag = body.loopLagMs as Record<string, unknown>;
    expect(loopLag.currentMs).toBe(0);
    expect(loopLag.max1mMs).toBe(0);
    expect(loopLag.max5mMs).toBe(0);
    expect(loopLag.worstAt).toBeNull();
    expect(loopLag.samples).toBe(0);
    expect(body.jobs).toEqual({});
  });

  it("A6: loop_lag_ms is present and deep-equals loopLagMs (same snapshot)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json() as Record<string, unknown>;
    expect(body.loop_lag_ms).toEqual(body.loopLagMs);
    const lag = body.loop_lag_ms as Record<string, unknown>;
    expect(typeof lag.currentMs).toBe("number");
    expect(typeof lag.max1mMs).toBe("number");
    expect(typeof lag.max5mMs).toBe("number");
    expect(lag.worstAt === null || typeof lag.worstAt === "string").toBe(true);
    expect(typeof lag.samples).toBe("number");
  });
});
