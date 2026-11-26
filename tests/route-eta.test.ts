import { beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/route-eta-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import {resetRouteGeocoderForTests} from "../src/handlers/routeGeocoder";
beforeEach(()=>resetRouteGeocoderForTests());
import { handleRouteEta, parseOsrm } from "../src/handlers/routeEta";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real OSRM demo-server body, retrieved 2026-11-23.
const namedRoute = readFileSync(join(__dirname,"fixtures/route-binding/austin-calallen.json"),"utf8");
const geoCalallen=JSON.stringify({results:[{name:'Calallen',latitude:27.8006,longitude:-97.3961,country:'United States',admin1:'Texas',country_code:'US',feature_code:'PPL'}]});
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
      if(u.startsWith("https://photon.komoot.io/"))return new Response('{"features":[]}');
      throw new Error(`unexpected fetch ${u}`);
    });
    await expect(handleRouteEta({ origin: "27.3,-97.2", destination: "Zzznotaplace" })).rejects.toMatchObject({ status: 422, code: "PLACE_NOT_FOUND" });
    await expect(handleRouteEta({ origin: "91,0", destination: "27.3,-97.2" })).rejects.toMatchObject({ status: 400, code: "BAD_LOCATION" });
  });

  it("R1: place-name endpoints resolve with named disclosure in the answer", async () => {
    const geoAustin = JSON.stringify({ results: [{ name: "Austin", latitude: 30.2672, longitude: -97.7431, country: "United States", admin1: "Texas", country_code: "US", feature_code: "PPL" }] });
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response(u.includes("Calallen")?geoCalallen:geoAustin, { status: 200 });
      if (u.startsWith("https://router.project-osrm.org/")) return new Response(namedRoute, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleRouteEta({ origin: "Austin, Texas", destination: "Calallen, Texas" });
    expect(result.duration).toBe(Math.round(JSON.parse(namedRoute).routes[0].duration));
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


describe('route-eta source validation',()=>{
 it.each([0,-1,20000000,null,'',false,'100'])('invalid duration %j refuses instead of clamping/coercing',async(duration)=>{
  const j=JSON.parse(corpus);j.routes[0].duration=duration;stub(JSON.stringify(j));
  await expect(handleRouteEta({origin:'27.345,-97.225',destination:'27.8006,-97.3961'})).rejects.toMatchObject({code:'NO_USABLE_ROUTE'});
 });
 it.each([null,'',false,-1])('invalid route distance %j refuses',distance=>{
  const j=JSON.parse(corpus);j.routes[0].distance=distance;expect(()=>parseOsrm(JSON.stringify(j))).toThrow();
 });
 it.each([null,[],[181,0],[0,91],['0',0],[null,0]])('invalid snapped location %j refuses',location=>{
  const j=JSON.parse(corpus);j.waypoints[0].location=location;expect(()=>parseOsrm(JSON.stringify(j))).toThrow();
 });
 it.each([null,'',-1])('invalid snap distance %j refuses',distance=>{
  const j=JSON.parse(corpus);j.waypoints[0].distance=distance;expect(()=>parseOsrm(JSON.stringify(j))).toThrow();
 });
 it('named endpoint receipts retain geocoder raw bodies as well as hashes',async()=>{
  const geo=JSON.stringify({results:[{name:'Austin',latitude:30.2672,longitude:-97.7431,country:'United States',admin1:'Texas',country_code:'US',feature_code:'PPL'}]});
  vi.stubGlobal('fetch',async(url:unknown)=>new Response(String(url).includes('geocoding-api')?(String(url).includes('Calallen')?geoCalallen:geo):namedRoute));
  const out=await handleRouteEta({origin:'Austin, Texas',destination:'Calallen, Texas'});
  const stored=await getReceiptEvidence((out.receipt as any).receipt_id);const evidence=JSON.parse(String(stored.evidence));
  expect(evidence.geocoders).toHaveLength(2);expect(evidence.geocoders[0].raw_body).toBe(geo);expect(evidence.geocoders[0].sha256).toBe(sha256Hex(geo));
 });
});

describe('OSRM transport real deadline',()=>{
 it.each(['fetch','body'])('%s ignores abort: caller refuses at6s, repeated request cannot add work, one settled operation frees ownership',async mode=>{const {resetRouteSourceForTests}=await import('../src/handlers/routeEta');resetRouteSourceForTests();vi.useFakeTimers();const releases:(()=>void)[]=[];let calls=0;vi.stubGlobal('fetch',async()=>{calls++;if(mode==='fetch')return new Promise<Response>(r=>releases.push(()=>r(new Response(corpus))));return new Response(new ReadableStream({start(c){releases.push(()=>{c.enqueue(new TextEncoder().encode(corpus));c.close();});}}));});const q={origin:'27.345,-97.225',destination:'27.8006,-97.3961'};try{let settled=false;const pending=Promise.all(Array.from({length:4},()=>handleRouteEta(q).catch(e=>e))).then(x=>{settled=true;return x;});await vi.advanceTimersByTimeAsync(5999);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(1);for(const e of await pending)expect(e).toMatchObject({status:502,code:'OSRM_UNREACHABLE'});await expect(handleRouteEta(q)).rejects.toMatchObject({status:502});expect(calls).toBe(4);releases.shift()!();await vi.advanceTimersByTimeAsync(1);vi.stubGlobal('fetch',async()=>{calls++;return new Response(corpus);});const out=await handleRouteEta(q);expect(calls).toBe(5);expect(out.duration).toBe(5282);for(const r of releases)r();await vi.advanceTimersByTimeAsync(1);}finally{resetRouteSourceForTests();vi.useRealTimers();}});
 it('refuses parseable oversized body and redirects without guessing a duration',async()=>{const q={origin:'27.345,-97.225',destination:'27.8006,-97.3961'};let policy:unknown;vi.stubGlobal('fetch',async(_u:any,o:any)=>{policy=o.redirect;return new Response(' '.repeat(262145)+corpus);});await expect(handleRouteEta(q)).rejects.toMatchObject({status:502,code:'OSRM_UNREACHABLE'});expect(policy).toBe('error');});
});

it('healthy overlapping route reads both complete with the real numeric fixture',async()=>{const {resetRouteSourceForTests}=await import('../src/handlers/routeEta');resetRouteSourceForTests();const releases:((r:Response)=>void)[]=[];vi.stubGlobal('fetch',()=>new Promise<Response>(r=>releases.push(r)));const q={origin:'27.345,-97.225',destination:'27.8006,-97.3961'};const a=handleRouteEta(q),b=handleRouteEta(q);await new Promise(r=>setTimeout(r,0));expect(releases.length).toBe(2);for(const r of releases)r(new Response(corpus));expect((await a).duration).toBe(5282);expect((await b).duration).toBe(5282);});
it('numeric duration and distance companions bind unchanged source estimate',async()=>{stub();const r=await handleRouteEta({origin:'27.345,-97.225',destination:'27.8006,-97.3961'});expect(r.duration_seconds).toBe(r.duration);expect(r.duration_minutes).toBe(5282/60);expect(r.distance_km).toBe(64.7205);});
it('endpoint resolution overlaps slow first provider without bypassing1.1second spacing',async()=>{vi.useFakeTimers();resetRouteGeocoderForTests();const starts:number[]=[];const zero=Date.now();vi.stubGlobal('fetch',async(u:any)=>{const url=String(u);if(url.includes('geocoding-api')){starts.push(Date.now()-zero);if(url.includes('Austin')){await new Promise(r=>setTimeout(r,1150));return new Response(JSON.stringify({results:[{name:'Austin',latitude:30.2672,longitude:-97.7431,feature_code:'PPL'}]}));}return new Response(geoCalallen);}return new Response(namedRoute);});try{const p=handleRouteEta({origin:'Austin',destination:'Calallen'});await vi.advanceTimersByTimeAsync(1100);expect(starts).toEqual([0,1100]);await vi.advanceTimersByTimeAsync(50);expect((await p).duration_seconds).toBe(Math.round(JSON.parse(namedRoute).routes[0].duration));}finally{vi.useRealTimers();resetRouteGeocoderForTests();}});
