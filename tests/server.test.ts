// Server tests — routing + error mapping via Fastify inject (no network).
//
// /health returns 200 with status ok; each of the five routes returns 400
// on missing params (proves routing reaches the handler and the ApiError
// mapping works); an unknown route returns 404.
//
// Note: these tests exercise the REAL handlers (no mocks). A 400 here means
// the handler validated the missing parameter before touching any upstream.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync } from "fs";
import { join, resolve } from "path";
import type { FastifyInstance } from "fastify";
import { buildServer, main } from "../src/server";
import {
  __getTvlListsRefreshTimerForTests,
  stopTvlListsRefreshTimer,
} from "../src/handlers/tvl";
import {
  primaryUpstreamForGridZone,
  recordUpstreamError,
  recordUpstreamOk,
  resetUpstreamsForTests,
  upstreamNameForUrl,
} from "../src/core/upstreams";

// Hermetic DB for this whole file (round-3, 2026-11-20): the wiring test
// boots the real main(), which opens the DB via buildServer() -> getDb().
// getDb() is a per-process singleton that reads SQLITE_PATH at first open,
// so the path must be set at module top, before beforeAll runs. The dir
// lives under the round-3 scratch dir — /tmp is 100% full on this VM, so
// os.tmpdir() is unusable. Vitest runs from the repo root, so the scratch
// dir is two levels up from the repo root; the mutant-copy harness may
// override it with TVL_R3_SCRATCH_DIR. Never the production DB, never the
// repo's ./data DB. The TVL disk cache also derives from SQLITE_PATH's
// directory (tvl.ts listsCacheDir), so the boot warm writes there too.
const R3_SCRATCH_DIR =
  process.env.TVL_R3_SCRATCH_DIR ??
  resolve(process.cwd(), "..", "..", "tvl-latency-r3-scratch");
const SERVER_TEST_DB_DIR = join(R3_SCRATCH_DIR, "server-test-db");
mkdirSync(SERVER_TEST_DB_DIR, { recursive: true });
process.env.SQLITE_PATH = join(SERVER_TEST_DB_DIR, "verireceipt.sqlite");

let app: FastifyInstance;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // Belt-and-braces: the wiring test stops the timer itself, but a
  // failure mid-test must not leave the hourly handle behind in the worker.
  stopTvlListsRefreshTimer();
});

describe("GET /health", () => {
  it("returns 200 with status ok, service verireceipt, uptime_s, upstreams", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("verireceipt");
    expect(typeof body.uptime_s).toBe("number");
    expect((body.uptime_s as number) >= 0).toBe(true);
    expect(body.upstreams).toEqual({});
  });
});

describe("missing params -> 400 with an error body (no stack trace)", () => {
  const cases: Array<[string, string]> = [
    ["/v1/tx", "tx lookup"],
    ["/v1/filings", "filings"],
    ["/v1/tvl", "tvl"],
    ["/v1/route", "route"],
    ["/v1/grid-price", "grid price"],
  ];

  it.each(cases)("%s (%s) returns 400 on missing params", async (url) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(typeof body.code).toBe("string");
    expect(typeof body.message).toBe("string");
    // The error body must never leak a stack trace.
    expect(JSON.stringify(body)).not.toContain("node_modules");
    expect(JSON.stringify(body)).not.toMatch(/\n\s+at\s/);
  });
});

describe("GET /health — A6 additive fields (git_sha, loop_lag_ms, upstreams)", () => {
  // Existing assertions above (status/service/uptime_s/upstreams {}) are
  // untouched: a fresh server still reports upstreams {} until a handler
  // call observes an upstream. These tests only ADD coverage.
  afterAll(() => {
    resetUpstreamsForTests();
  });

  it("git_sha defaults to 'unknown' and follows RENDER_GIT_COMMIT", async () => {
    const prev = process.env.RENDER_GIT_COMMIT;
    try {
      delete process.env.RENDER_GIT_COMMIT;
      let res = await app.inject({ method: "GET", url: "/health" });
      expect((res.json() as Record<string, unknown>).git_sha).toBe("unknown");
      process.env.RENDER_GIT_COMMIT = "a6testsha00000000000000000000000000000001";
      res = await app.inject({ method: "GET", url: "/health" });
      expect((res.json() as Record<string, unknown>).git_sha).toBe(
        "a6testsha00000000000000000000000000000001",
      );
    } finally {
      if (prev === undefined) delete process.env.RENDER_GIT_COMMIT;
      else process.env.RENDER_GIT_COMMIT = prev;
    }
  });

  it("loop_lag_ms is present and deep-equals loopLagMs (same snapshot)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json() as Record<string, unknown>;
    expect(body.loop_lag_ms).toEqual(body.loopLagMs);
    const lag = body.loop_lag_ms as Record<string, unknown>;
    expect(typeof lag.currentMs).toBe("number");
    expect(typeof lag.max1mMs).toBe("number");
    expect(typeof lag.max5mMs).toBe("number");
  });

  it("a 400 validation error records no upstream (never touched one)", async () => {
    const before = await app.inject({ method: "GET", url: "/health" });
    const beforeKeys = Object.keys(
      (before.json() as Record<string, unknown>).upstreams as Record<string, unknown>,
    ).sort();
    const bad = await app.inject({ method: "GET", url: "/v1/tvl" });
    expect(bad.statusCode).toBe(400);
    const after = await app.inject({ method: "GET", url: "/health" });
    const afterKeys = Object.keys(
      (after.json() as Record<string, unknown>).upstreams as Record<string, unknown>,
    ).sort();
    expect(afterKeys).toEqual(beforeKeys);
  });

  it("/health serves the upstream registry (recorded ok + error)", async () => {
    recordUpstreamOk("sec-edgar", "2026-11-20T00:00:00.000Z");
    recordUpstreamError("defillama", "TEST_CODE");
    const res = await app.inject({ method: "GET", url: "/health" });
    const upstreams = (res.json() as Record<string, unknown>).upstreams as Record<
      string,
      { last_ok: string | null; last_err: string | null; last_error: string | null }
    >;
    expect(upstreams["sec-edgar"].last_ok).toBe("2026-11-20T00:00:00.000Z");
    expect(upstreams["sec-edgar"].last_err).toBeNull();
    expect(typeof upstreams["defillama"].last_err).toBe("string");
    expect(upstreams["defillama"].last_error).toBe("TEST_CODE");
    expect(upstreams["defillama"].last_ok).toBeNull();
  });

  it("upstreamNameForUrl maps hosts to services, unknown host falls back to itself", () => {
    expect(upstreamNameForUrl("https://data.sec.gov/submissions/CIK1.json")).toBe("sec-edgar");
    expect(upstreamNameForUrl("https://api.llama.fi/tvl/aave-v3")).toBe("defillama");
    expect(upstreamNameForUrl("https://oasis.caiso.com/oasisapi/SingleZip")).toBe("caiso-oasis");
    expect(upstreamNameForUrl("https://eth.drpc.org")).toBe("evm-rpc");
    expect(upstreamNameForUrl("https://lodestar-mainnet.chainsafe.io")).toBe("beacon-api");
    expect(upstreamNameForUrl("https://some-new-rpc.example.com/x")).toBe(
      "some-new-rpc.example.com",
    );
    expect(upstreamNameForUrl("")).toBeNull();
    expect(upstreamNameForUrl("not a url at all")).toBeNull();
  });

  it("primaryUpstreamForGridZone attributes NYISO/Elering misses to their own ISO", () => {
    expect(primaryUpstreamForGridZone("CAISO")).toBe("caiso-oasis");
    expect(primaryUpstreamForGridZone("TH_NP15_GEN-APND")).toBe("caiso-oasis");
    expect(primaryUpstreamForGridZone(undefined)).toBe("caiso-oasis");
    expect(primaryUpstreamForGridZone("ZONE_J")).toBe("nyiso");
    expect(primaryUpstreamForGridZone("N.Y.C.")).toBe("nyiso");
    expect(primaryUpstreamForGridZone("ZONE_A")).toBe("nyiso");
    expect(primaryUpstreamForGridZone("EE")).toBe("elering");
    expect(primaryUpstreamForGridZone("FI")).toBe("elering");
  });

  it("a live NYISO cache miss (502) populates nyiso last_err, not caiso-oasis", async () => {
    // ZONE_J at a 2020 interval has no cache row (ingester covers recent
    // windows only; NYISO is cache-only) → 502 GRID_CACHE_MISS. If a row
    // somehow existed the call would be 200 and nyiso last_ok would be
    // set instead — either way the NYISO entry, not caiso-oasis, moves.
    const res = await app.inject({
      method: "GET",
      url: "/v1/grid-price?node_or_zone=ZONE_J&interval_start=2020-01-01T00:00:00Z",
    });
    expect([200, 502]).toContain(res.statusCode);
    const health = await app.inject({ method: "GET", url: "/health" });
    const upstreams = (health.json() as Record<string, unknown>).upstreams as Record<
      string,
      { last_ok: string | null; last_err: string | null; last_error: string | null }
    >;
    const nyiso = upstreams["nyiso"];
    expect(nyiso).toBeDefined();
    if (res.statusCode === 502) {
      expect(typeof nyiso.last_err).toBe("string");
      expect(nyiso.last_error).toBe("GRID_CACHE_MISS");
    } else {
      expect(typeof nyiso.last_ok).toBe("string");
    }
  }, 30_000);

  it("a live handler call populates its upstream via the route wrapper", async () => {
    // Real beacon call (no mock): index 1 exists, so the outcome is
    // EITHER 200 (both beacon legs answered → last_ok) OR 502 (an
    // upstream leg failed → last_err with a short code). Either outcome
    // must populate beacon-api; a third outcome (400/422) would mean
    // the handler never reached the upstream and fails this test.
    const res = await app.inject({
      method: "GET",
      url: "/v1/validator?validator_index=1",
    });
    expect([200, 502]).toContain(res.statusCode);
    const health = await app.inject({ method: "GET", url: "/health" });
    const upstreams = (health.json() as Record<string, unknown>).upstreams as Record<
      string,
      { last_ok: string | null; last_err: string | null; last_error: string | null }
    >;
    const beacon = upstreams["beacon-api"];
    expect(beacon).toBeDefined();
    if (res.statusCode === 200) {
      expect(typeof beacon.last_ok).toBe("string");
      expect(Number.isNaN(Date.parse(beacon.last_ok as string))).toBe(false);
    } else {
      expect(typeof beacon.last_err).toBe("string");
      expect(typeof beacon.last_error).toBe("string");
      // The error code is a short code, never a message or URL.
      expect(beacon.last_error as string).not.toContain("http");
      expect(beacon.last_error as string).not.toContain("://");
    }
    expect(beacon.last_ok !== null || beacon.last_err !== null).toBe(true);
  }, 30_000);
});

describe("unknown route", () => {
  it("returns 404", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/no-such-route" });
    expect(res.statusCode).toBe(404);
  });
});

describe("malformed JSON body -> 400, not 502 (server stays up)", () => {
  it("truncated JSON POST returns 400 with an error body, then /health still 200", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/health",
      headers: { "content-type": "application/json" },
      payload: '{"bad": ',
    });
    expect(bad.statusCode).toBe(400);
    const body = bad.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(typeof body.code).toBe("string");
    expect(JSON.stringify(body)).not.toContain("node_modules");
    expect(JSON.stringify(body)).not.toMatch(/\n\s+at\s/);
    // The server must stay up after the client error.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect((health.json() as Record<string, unknown>).status).toBe("ok");
  });
});

describe("main() wiring — TVL hourly timer (round-3 R3, J2 FAIL F1)", () => {
  // The round-2 suite never booted main(): every src/server import was
  // buildServer only, and all 5 timer tests called
  // startTvlListsRefreshTimer() directly — so deleting the
  // startTvlListsRefreshTimer() call in main() (mutant C) passed 260/260.
  // This describe boots the REAL main() in-process and observes the timer
  // through the read-only __getTvlListsRefreshTimerForTests() getter; it
  // never calls startTvlListsRefreshTimer() directly (a post-hoc call
  // would START the timer under mutant C and mask the deletion). First
  // attempt used process._getActiveHandles() with _idleTimeout 3600000,
  // but that is unobservable on this VM's Node v24.22.1: _getActiveHandles()
  // lists I/O handles only — a ref'd AND an unref'd 1h interval are both
  // absent (verified in node), so the handle list proves nothing here.
  // The getter returns the module-level timer object itself, whose
  // _idleTimeout is 3600000 and hasRef() is false (unref'd) — verified in
  // node. Test port 18731; the temp SQLITE_PATH above keeps the boot off
  // the production DB and the repo's ./data DB.
  const TEST_PORT = 18731;
  const TEST_UA = "verireceipt-r3-wiring-test/1.0 (test-only)";

  it("buildServer() starts NO hourly TVL timer", () => {
    // Negative control (J2 atk-handles.mts): the timer belongs to main(),
    // not buildServer(). This runs before the wiring test below, while the
    // timer has never been started in this worker.
    expect(__getTvlListsRefreshTimerForTests()).toBeNull();
  });

  it("main() boots the real server AND starts the hourly TVL timer, then shuts down cleanly", async () => {
    const prevPort = process.env.PORT;
    const prevUa = process.env.SEC_USER_AGENT;
    process.env.PORT = String(TEST_PORT);
    process.env.SEC_USER_AGENT = TEST_UA;
    let booted: FastifyInstance | undefined;
    let timer: NodeJS.Timeout | null = null;
    try {
      expect(__getTvlListsRefreshTimerForTests()).toBeNull();
      booted = await main();
      expect(booted.server.listening).toBe(true);
      const addr = booted.server.address();
      expect(addr).not.toBeNull();
      if (typeof addr === "object" && addr !== null) {
        expect(addr.port).toBe(TEST_PORT);
      }
      // Production wiring only: the 1h timer must exist because main()
      // called startTvlListsRefreshTimer(), not because this test did.
      timer = __getTvlListsRefreshTimerForTests();
      expect(timer).not.toBeNull();
      expect(
        (timer as unknown as { _idleTimeout?: unknown })._idleTimeout,
      ).toBe(60 * 60 * 1000);
      // Unref'd: the timer never keeps the process (or the runner) alive.
      expect(typeof timer?.hasRef).toBe("function");
      expect(timer?.hasRef()).toBe(false);
      // The booted server answers while the timer runs.
      const health = await booted.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect((health.json() as Record<string, unknown>).status).toBe("ok");
    } finally {
      if (booted) await booted.close();
      stopTvlListsRefreshTimer();
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
      if (prevUa === undefined) delete process.env.SEC_USER_AGENT;
      else process.env.SEC_USER_AGENT = prevUa;
    }
    // Clean shutdown: no listening socket and no timer left — stop clears
    // the module-level handle, so the unref'd timer holds nothing.
    expect(booted?.server.listening).toBe(false);
    expect(__getTvlListsRefreshTimerForTests()).toBeNull();
  }, 30_000);
});
