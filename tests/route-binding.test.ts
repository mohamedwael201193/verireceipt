import {afterAll,afterEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/route-binding-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {handleRouteEta,parseOsrm,verifyRouteEndpoints} from '../src/handlers/routeEta';
import {getReceiptEvidence} from '../src/core/storage';
const body=readFileSync(join(__dirname,'fixtures/route-eta/osrm-corpus-to-calallen.json'),'utf8');
const origin={lat:27.345,lon:-97.225},destination={lat:27.8006,lon:-97.3961};
const q={origin:'27.345,-97.225',destination:'27.8006,-97.3961'};
afterEach(()=>vi.unstubAllGlobals());afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
it('real coastal route retains its large disclosed snap and stored body',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(body));const out=await handleRouteEta(q);expect(out.duration).toBe(5282);
 expect(String(out.answer)).toContain('9701');const ev=await getReceiptEvidence((out.receipt as any).receipt_id);expect(String(ev.evidence)).toContain('9701.308333');
});
it.each(['origin','destination'])('unrelated requested %s rejected at handler before evidence',async endpoint=>{
 vi.stubGlobal('fetch',async()=>new Response(body));await expect(handleRouteEta({...q,[endpoint]:'40,-75'})).rejects.toMatchObject({code:'ROUTE_ENDPOINT_MISMATCH'});
});
it.each([0,1])('incorrect waypoint %s rejected at handler',async index=>{
 const d=JSON.parse(body);d.waypoints[index].location=[-75,40];vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(d)));await expect(handleRouteEta(q)).rejects.toMatchObject({code:'ROUTE_ENDPOINT_MISMATCH'});
});
it('reversed response waypoints cannot silently reverse the request',async()=>{
 const d=JSON.parse(body);d.waypoints.reverse();vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(d)));await expect(handleRouteEta(q)).rejects.toMatchObject({code:'ROUTE_ENDPOINT_MISMATCH'});
});
it.each([0,1])('invented snap distance %s cannot explain a different endpoint',async index=>{
 const d=JSON.parse(body);d.waypoints[index].distance=100000;vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(d)));await expect(handleRouteEta(q)).rejects.toMatchObject({code:'ROUTE_ENDPOINT_MISMATCH'});
});
it('tolerates small geodesic approximation differences but refuses beyond fixed floor',()=>{
 const d=parseOsrm(body);d.destination_snap_m=15;expect(()=>verifyRouteEndpoints(d,origin,destination)).not.toThrow();d.destination_snap_m=30;expect(()=>verifyRouteEndpoints(d,origin,destination)).toThrow();
});
it('antimeridian spherical distance uses the short arc',()=>{
 const route={duration_s:10,distance_m:1000,origin_snapped:[-179.999,0] as [number,number],destination_snapped:[179.999,0] as [number,number],origin_snap_m:222.39,destination_snap_m:222.39};expect(()=>verifyRouteEndpoints(route,{lat:0,lon:179.999},{lat:0,lon:-179.999})).not.toThrow();
});
