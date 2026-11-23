import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/travel-disruption-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); });
import { handleTravelDisruption, parseNasStatus } from "../src/handlers/travelDisruption";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real FAA NAS status snapshot retrieved 2026-11-23 (the feed ignores its
// airport parameter; filtering is local). Contains: LGA ground delay
// program "low visibility" avg 2h19m, SAN arrival/departure delay
// "VOL:Compacted Demand" 16-30 min, LAX airport closure (NOTAM-style).
const nas = readFileSync(join(__dirname, "fixtures/travel-disruption/faa-nas-status-snapshot.xml"), "utf8");
function stub(body: string | "ERR" = nas): void {
  vi.stubGlobal("fetch", async () => {
    if (body === "ERR") throw new Error("test outage");
    return new Response(body, { status: 200 });
  });
}
describe("TRAVEL_DISRUPTION_GENERAL", () => {
  it("accepts only a 3-letter airport code, never a route or flight number", async () => {
    await expect(handleTravelDisruption({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleTravelDisruption({ route_or_flight: "UA123" })).rejects.toMatchObject({ status: 400, code: "AIRPORT_CODE_REQUIRED" });
    await expect(handleTravelDisruption({ route_or_flight: "LGA-JFK" })).rejects.toMatchObject({ status: 400, code: "AIRPORT_CODE_REQUIRED" });
  });
  it("parses the real snapshot: ground delay program, arr/dep delay, closure", () => {
    const lga = parseNasStatus(nas, "LGA");
    expect(lga.entries.some((e) => e.kind === "ground delay program" && /low visibility/i.test(e.reason))).toBe(true);
    const san = parseNasStatus(nas, "SAN");
    expect(san.entries.some((e) => e.kind === "arrival/departure delay" && /Compacted Demand/.test(e.reason))).toBe(true);
    const lax = parseNasStatus(nas, "LAX");
    expect(lax.entries.some((e) => e.kind === "airport closure")).toBe(true);
  });
  it("a disrupted airport reports status, delay minutes and reason, airport-level only", async () => {
    stub();
    const result = await handleTravelDisruption({ route_or_flight: "lga" });
    expect(result.disrupted).toBe(true);
    expect(String(result.status)).toContain("ground delay program");
    expect(result.delay_minutes).toBe(139); // 2 hours and 19 minutes
    const ans = String(result.answer);
    expect(ans).toContain("airport-level FAA status, not flight-level tracking");
    expect(result.receipt).toMatchObject({ intent: "TRAVEL_DISRUPTION_GENERAL" });
  });
  it("an airport without entries is undisrupted and never claimed normal", async () => {
    stub();
    const result = await handleTravelDisruption({ route_or_flight: "PIT" });
    expect(result.disrupted).toBe(false);
    expect(result.delay_minutes).toBeNull();
    const ans = String(result.answer);
    expect(ans).toContain("no active FAA-listed disruption");
    expect(ans).toContain("not flight-level tracking");
    expect(ans).toContain("not claimed normal");
  });
  it("outage is an honest 502 and a non-NAS body a 422", async () => {
    stub("ERR");
    await expect(handleTravelDisruption({ route_or_flight: "LGA" })).rejects.toMatchObject({ status: 502, code: "FAA_UNREACHABLE" });
    vi.unstubAllGlobals();
    stub("<html>error page</html>");
    await expect(handleTravelDisruption({ route_or_flight: "LGA" })).rejects.toMatchObject({ status: 422, code: "NO_USABLE_STATUS" });
  });
  it("receipt evidence round-trips and discloses the input narrowing", async () => {
    stub();
    const result = await handleTravelDisruption({ route_or_flight: "LGA" });
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const ev = String(stored.evidence);
    expect(ev).toContain("input_narrowing");
    expect(ev).toContain("never flight-level tracking");
  });
  it("GET /v1/travel-disruption is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/travel-disruption" })).toBe(true);
    await app.close();
  });
});
