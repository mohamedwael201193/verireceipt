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
  it("requires input and refuses flight numbers without dated origin evidence", async () => {
    await expect(handleTravelDisruption({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleTravelDisruption({ route_or_flight: "UA123" })).rejects.toMatchObject({ status: 400, code: "AIRPORT_CODE_REQUIRED" });

  });
  it("parses the real snapshot: ground delay program, arr/dep delay, closure", () => {
    const lga = parseNasStatus(nas, "LGA");
    expect(lga.entries.some((e) => e.kind === "ground delay program" && /low visibility/i.test(e.reason))).toBe(true);
    const san = parseNasStatus(nas, "SAN");
    expect(san.entries.some((e) => e.kind === "arrival/departure delay" && /Compacted Demand/.test(e.reason))).toBe(true);
    const lax = parseNasStatus(nas, "LAX");
    expect(lax.entries.some((e) => e.kind === "airport closure")).toBe(false);
    expect(lax.excluded_closures).toHaveLength(1);
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

describe("A1 airport names via the bundled list", () => {
  it("a listed airport name resolves with disclosure", async () => {
    stub();
    const result = await handleTravelDisruption({ route_or_flight: "Los Angeles" });
    expect(result.route_or_flight).toBe("LAX");
    expect(String(result.answer)).toContain('"Los Angeles" resolved to LAX (Los Angeles Intl) via the bundled airport list');
    const rc = result.receipt as { receipt_id: string };
    const ev = await getReceiptEvidence(rc.receipt_id);
    const parsed = JSON.parse(ev.evidence!) as { name_resolution: { input: string; resolved_to: string } };
    expect(parsed.name_resolution.input).toBe("Los Angeles");
    expect(parsed.name_resolution.resolved_to).toBe("LAX");
  });

  it("a disrupted airport reached by name keeps status and reason", async () => {
    stub();
    const result = await handleTravelDisruption({ route_or_flight: "LaGuardia" });
    expect(result.route_or_flight).toBe("LGA");
    expect(result.disrupted).toBe(true);
    expect(String(result.status)).toContain("ground delay program");
  });

  it("a multi-airport city refuses ambiguous, naming the candidates", async () => {
    for (const [city, codes] of [["Washington", ["IAD", "DCA"]], ["New York", ["JFK", "LGA"]], ["Dallas", ["DFW", "DAL"]], ["Chicago", ["ORD", "MDW"]], ["Houston", ["IAH", "HOU"]]] as const) {
      let err: unknown;
      try {
        await handleTravelDisruption({ route_or_flight: city });
      } catch (e) { err = e; }
      const e = err as { status?: number; code?: string; message?: string };
      expect(e.status, city).toBe(422);
      expect(e.code, city).toBe("AMBIGUOUS_AIRPORT");
      for (const c of codes) expect(String(e.message), `${city} ${c}`).toContain(c);
    }
  });

  it("an unlisted name keeps the honest AIRPORT_CODE_REQUIRED refusal", async () => {
    await expect(handleTravelDisruption({ route_or_flight: "Springfield" })).rejects.toMatchObject({ status: 400, code: "AIRPORT_CODE_REQUIRED" });
  });

  it("a 3-letter code still answers directly with no resolution disclosure", async () => {
    stub();
    const result = await handleTravelDisruption({ route_or_flight: "LAX" });
    expect(result.route_or_flight).toBe("LAX");
    expect(String(result.answer)).not.toContain("resolved to");
    const rc = result.receipt as { receipt_id: string };
    const ev = await getReceiptEvidence(rc.receipt_id);
    const parsed = JSON.parse(ev.evidence!) as { name_resolution: string };
    expect(parsed.name_resolution).toBe("not used (3-letter code given directly)");
  });
});

describe('two-airport route status',()=>{
 it.each(['LGA to SAN','LGA-SAN','LGA/SAN','LaGuardia to San Diego'])('checks both exact endpoints from one real snapshot: %s',async(route_or_flight)=>{
  const f=vi.fn(async()=>new Response(nas));vi.stubGlobal('fetch',f);
  const out=await handleTravelDisruption({route_or_flight});expect(out.disrupted).toBe(true);expect(out.route_or_flight).toBe('LGA-SAN');
  const statuses=out.airport_statuses as any[];expect(statuses.map(s=>s.airport)).toEqual(['LGA','SAN']);expect(statuses.every(s=>s.disrupted)).toBe(true);
  expect(out.delay_minutes).toBe(139);expect(String(out.delay_semantics)).toContain('not route or flight delay');expect(f).toHaveBeenCalledTimes(1);
  const r=out.receipt as any;const stored=await getReceiptEvidence(r.receipt_id);expect(sha256Hex(stored.evidence!)).toBe(r.raw_response_sha256);
  expect(JSON.parse(stored.evidence!).raw_bodies.nas_status).toBe(nas);
 });
 it('destination disruption counts even when origin has none, and both negatives remain absence only',async()=>{
  stub();const out=await handleTravelDisruption({route_or_flight:'PIT-LGA'});expect(out.disrupted).toBe(true);expect((out.airport_statuses as any[])[0].disrupted).toBe(false);expect((out.airport_statuses as any[])[1].disrupted).toBe(true);
  const negative=await handleTravelDisruption({route_or_flight:'PIT-JFK'});expect(negative.disrupted).toBe(false);expect(negative.delay_minutes).toBeNull();expect(String(negative.answer)).toContain('not claimed normal');
 });
 it.each(['New York to LAX','LGA to Washington'])('refuses ambiguous endpoint without network: %s',async(route_or_flight)=>{
  const f=vi.fn();vi.stubGlobal('fetch',f);await expect(handleTravelDisruption({route_or_flight})).rejects.toMatchObject({code:'AMBIGUOUS_AIRPORT'});expect(f).not.toHaveBeenCalled();
 });
 it.each(['UA123','LGA-JFK-LAX','LGA/JFK/LAX','LGA to Springfield'])('refuses unsupported flight/multi-hop/unknown endpoint without guessing: %s',async(route_or_flight)=>{
  const f=vi.fn();vi.stubGlobal('fetch',f);await expect(handleTravelDisruption({route_or_flight})).rejects.toMatchObject({code:'AIRPORT_CODE_REQUIRED'});expect(f).not.toHaveBeenCalled();
 });
});
