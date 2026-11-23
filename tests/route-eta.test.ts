import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/route-eta-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleRouteEta, parseOsrm } from "../src/handlers/routeEta";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real OSRM demo-server body, retrieved 2026-11-23.
const corpus = readFileSync(join(__dirname, "fixtures/route-eta/osrm-corpus-to-calallen.json"), "utf8");
function stub(body: string | "ERR" = corpus, status = 200): void {
  vi.stubGlobal("fetch", async () => {
    if (body === "ERR") throw new Error("test outage");
    return new Response(body, { status });
  });
}
describe("ROUTE_ETA_GENERAL", () => {
  it("validates both endpoints as lat,lon", async () => {
    await expect(handleRouteEta({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleRouteEta({ origin: "27.3,-97.2" })).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleRouteEta({ origin: "27.3,-97.2", destination: "Austin" })).rejects.toMatchObject({ status: 400, code: "BAD_LOCATION" });
  });
  it("parses the real route: duration, distance, snapped waypoints", () => {
    const r = parseOsrm(corpus);
    expect(r.duration_s).toBe(5282);
    expect(r.distance_m).toBe(64720.5);
    expect(r.origin_snap_m).toBeGreaterThan(9000); // honest large snap near the bay
    expect(r.destination_snap_m).toBeLessThan(1);
  });
  it("serves the estimate labelled as a static model, snaps disclosed", async () => {
    stub();
    const result = await handleRouteEta({ origin: "27.345,-97.225", destination: "27.8006,-97.3961" });
    expect(result.duration).toBe(5282);
    const ans = String(result.answer);
    expect(ans).toContain("static car-profile estimate");
    expect(ans).toContain("no live traffic");
    expect(ans).toContain("snapped the origin");
    expect(result.confidence).toBe(0.7);
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("ROUTE_ETA_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
  });
  it("a no-route answer is an honest 422, an outage an honest 502", async () => {
    stub(JSON.stringify({ code: "NoRoute", routes: [], waypoints: [] }));
    await expect(handleRouteEta({ origin: "27.3,-97.2", destination: "27.8,-97.4" }))
      .rejects.toMatchObject({ status: 422, code: "NO_ROUTE" });
    vi.unstubAllGlobals();
    stub("ERR");
    await expect(handleRouteEta({ origin: "27.3,-97.2", destination: "27.8,-97.4" }))
      .rejects.toMatchObject({ status: 502, code: "OSRM_UNREACHABLE" });
  });
  it("GET /v1/route-eta is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/route-eta" })).toBe(true);
    stub();
    const res = await app.inject({ method: "GET", url: "/v1/route-eta?origin=27.345,-97.225&destination=27.8006,-97.3961" });
    expect(res.statusCode).toBe(200);
    expect(res.json().duration).toBe(5282);
    await app.close();
  });
});
