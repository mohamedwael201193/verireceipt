// Server tests — routing + error mapping via Fastify inject (no network).
//
// /health returns 200 with status ok; each of the five routes returns 400
// on missing params (proves routing reaches the handler and the ApiError
// mapping works); an unknown route returns 404.
//
// Note: these tests exercise the REAL handlers (no mocks). A 400 here means
// the handler validated the missing parameter before touching any upstream.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
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

describe("unknown route", () => {
  it("returns 404", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/no-such-route" });
    expect(res.statusCode).toBe(404);
  });
});
