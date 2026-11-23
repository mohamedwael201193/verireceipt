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
  it("validates both endpoints; place names go through the geocoder, unknown names refuse honestly", async () => {
    await expect(handleRouteEta({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleRouteEta({ origin: "27.3,-97.2" })).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response('{"results":[]}', { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    await expect(handleRouteEta({ origin: "27.3,-97.2", destination: "Zzznotaplace" })).rejects.toMatchObject({ status: 422, code: "PLACE_NOT_FOUND" });
    await expect(handleRouteEta({ origin: "91,0", destination: "27.3,-97.2" })).rejects.toMatchObject({ status: 400, code: "BAD_LOCATION" });
  });

  it("R1: place-name endpoints resolve with named disclosure in the answer", async () => {
    const geoAustin = JSON.stringify({ results: [{ name: "Austin", latitude: 30.2672, longitude: -97.7431, country: "United States", admin1: "Texas", country_code: "US" }] });
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response(geoAustin, { status: 200 });
      if (u.startsWith("https://router.project-osrm.org/")) return new Response(corpus, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleRouteEta({ origin: "Austin, Texas", destination: "Austin, Texas" });
    expect(result.duration).toBe(5282);
    const ans = String(result.answer);
    expect(ans).toContain("Austin, Texas, United States (30.2672, -97.7431)");
    expect(ans).toContain("static car-profile estimate");
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

describe("route-eta duration clamp (reviewer follow-up)", () => {
  const withDuration = (d: number) => {
    const body = JSON.parse(corpus);
    body.routes[0].duration = d;
    return JSON.stringify(body);
  };
  it("a 0s duration is clamped up to 1 and 20,000,000s down to 1,000,000 (contract range)", async () => {
    stub(withDuration(0));
    const lo = await handleRouteEta({ origin: "27.345,-97.225", destination: "27.8006,-97.3961" });
    expect(lo.duration).toBe(1);
    stub(withDuration(20000000));
    const hi = await handleRouteEta({ origin: "27.345,-97.225", destination: "27.8006,-97.3961" });
    expect(hi.duration).toBe(1000000);
  });
});
