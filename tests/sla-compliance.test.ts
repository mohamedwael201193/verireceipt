import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/sla-compliance-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
import { handleSlaCompliance } from "../src/handlers/slaCompliance";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";

// Fixture: a real excerpt of www.githubstatus.com/api/v2/incidents.json
// retrieved 2026-11-23 — two critical, one major, two minor incidents
// (the most recent of each kind on that day). Page 2 is stubbed empty,
// marking the end of the log.
const FX = join(__dirname, "fixtures/sla-compliance");
const PAGE1 = readFileSync(join(FX, "github-incidents.json"), "utf8");
// Pinned so the fixture window never rots: 2026-11-23T00:00:00Z.
const PINNED = new Date("2026-11-23T00:00:00.000Z");
// Under the disclosed rule (major/critical only, union clipped to the
// 30d window): 33.45 + 104.19 + 162.32 = 299.97 downtime minutes over
// 43200 window minutes => 99.3056%.
const EXPECTED_UPTIME = 99.3056;

function stub(opts: { down?: boolean; malformed?: boolean } = {}): void {
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    if (u.includes("githubstatus.com")) {
      if (opts.down) throw new Error("statuspage outage");
      if (opts.malformed) return new Response("not json", { status: 200 });
      if (u.includes("&page=1")) return new Response(PAGE1, { status: 200 });
      return new Response(JSON.stringify({ page: {}, incidents: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(PINNED);
});

describe("SLA_COMPLIANCE_GENERAL", () => {
  it("computes uptime from major/critical incidents only, with a verifiable receipt", async () => {
    stub();
    const result = await handleSlaCompliance({ service: "github", period: "30d" });
    expect(result.uptime_pct).toBe(EXPECTED_UPTIME);
    expect(result.counted_incidents).toBe(3);
    expect(result.excluded_degradations).toBe(2);
    expect(result.sla_target_pct).toBeNull();
    expect(result.compliant).toBeNull();
    expect(String(result.answer)).toContain("NOT provided");
    expect(String(result.answer)).toContain("SLA target in machine-readable form");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("SLA_COMPLIANCE_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("githubstatus.com");
  });
  it("the answer restates the disclosed impact-to-downtime rule", async () => {
    stub();
    const result = await handleSlaCompliance({ service: "github", period: "30d" });
    expect(String(result.answer)).toContain("major/critical");
    expect(String(result.answer)).toContain("disclosed rule");
  });
  it("a 7d window counts only the incidents overlapping it", async () => {
    stub();
    const result = await handleSlaCompliance({ service: "github", period: "7d" });
    // Pinned 2026-11-23 minus 7d starts 2026-11-16: only the two Nov-19
    // minor incidents overlap, and minors are excluded from downtime.
    expect(result.uptime_pct).toBe(100);
    expect(result.counted_incidents).toBe(0);
    expect(result.excluded_degradations).toBe(2);
  });
  it("an unsupported service fails closed with a 400 naming the supported set", async () => {
    stub();
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/sla-compliance?service=stripe&period=30d" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("UNSUPPORTED_SERVICE");
    expect(res.body).toContain("github");
    await app.close();
  });
  it("a malformed period is a 400", async () => {
    stub();
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/sla-compliance?service=github&period=last-month" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_PERIOD");
    await app.close();
  });
  it("a statuspage outage fails closed with a 502", async () => {
    stub({ down: true });
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/sla-compliance?service=github&period=30d" });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("STATUSPAGE_UNREACHABLE");
    await app.close();
  });
  it("a malformed statuspage body fails closed with a 502", async () => {
    stub({ malformed: true });
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/sla-compliance?service=github&period=30d" });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("STATUSPAGE_MALFORMED");
    await app.close();
  });
  it("an incident log too shallow to cover the window fails closed with a 502", async () => {
    // Every page answers with the same recent incident, so the log
    // never reaches back 30 days within the page cap.
    const recent = JSON.stringify({
      page: {},
      incidents: [{ id: "x1", name: "Recent incident", impact: "major", started_at: "2026-11-22T10:00:00.000Z", resolved_at: "2026-11-22T11:00:00.000Z" }],
    });
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("githubstatus.com")) return new Response(recent, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/sla-compliance?service=github&period=30d" });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("INCIDENT_LOG_SHALLOW");
    await app.close();
  });

  it("AUDIT S2: natural period phrasings map to the Nd window", async () => {
    stub();
    const app = buildServer();
    for (const p of ["last 30 days", "the past 7 days", "90 days", "30 day", "30D"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/sla-compliance?service=github&period=${encodeURIComponent(p)}`,
      });
      expect(res.statusCode, p).toBe(200);
    }
    for (const bad of ["0d", "91 days", "last month", "30"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/sla-compliance?service=github&period=${encodeURIComponent(bad)}`,
      });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().code).toBe("INVALID_PERIOD");
    }
    await app.close();
  });
});
