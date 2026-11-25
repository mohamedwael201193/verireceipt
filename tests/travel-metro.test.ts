import {resetFlightSourcesForTests} from '../src/handlers/flightStatus';
import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{}),storageBackend:()=> 'postgres'}));
import {saveReceipt} from '../src/core/storage';
import {handleTravelDisruption,parseNasStatus} from '../src/handlers/travelDisruption';
import {answerDiagnostics} from '../src/core/answerClass';
import {sha256Hex} from '../src/core/receipt';
import {buildServer} from '../src/server';
const raw=readFileSync('tests/fixtures/travel-metro/faa.xml','utf8');
const earlier=readFileSync('tests/fixtures/travel-disruption/faa-nas-status-snapshot.xml','utf8');
afterEach(()=>{resetFlightSourcesForTests();vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();vi.restoreAllMocks();});
it.each([
 ['NYC',['JFK','LGA','EWR']],['Chicago',['ORD','MDW']],['Washington',['DCA','IAD','BWI']],['LA',['LAX','BUR','SNA']],['SF Bay',['SFO','OAK','SJC']],['Dallas',['DFW','DAL']],['Houston',['IAH','HOU']],
] as [string,string[]][])('metro %s checks every listed airport against one real snapshot',async(input,airports)=>{
 const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);const out=await handleTravelDisruption({route_or_flight:input});
 const statuses=out.airport_statuses as any[];expect(statuses.map(s=>s.airport)).toEqual(airports);expect(f).toHaveBeenCalledOnce();
 for(const s of statuses){expect(s.entries).toEqual(parseNasStatus(raw,s.airport).entries);expect(s.disrupted).toBe(s.entries.length>0);expect(out.answer).toContain(s.airport+(s.disrupted?' has ':' has no active'));}
 expect(out.disrupted).toBe(statuses.some(s=>s.disrupted));expect(out.answer).toContain('Metro expansion');expect(out.answer).toContain('not flight tracking');expect(answerDiagnostics('TRAVEL_DISRUPTION_GENERAL',out).answerClass).toEqual({travel_input_class:'metro'});
 const [r,e]=vi.mocked(saveReceipt).mock.calls[0];expect(JSON.parse(e).raw_bodies.nas_status).toBe(raw);expect(r.raw_response_sha256).toBe(sha256Hex(e));
});
it('NYC real positive names only active program airports and metro negative is absence only',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(earlier));const out=await handleTravelDisruption({route_or_flight:'NYC'});expect(out.disrupted).toBe(true);expect((out.airport_statuses as any[]).filter(s=>s.disrupted).map(s=>s.airport)).toEqual(['LGA']);expect(out.answer).toContain('LGA has ground delay program');expect(out.answer).toContain('JFK has no active FAA-listed disruption');
 const negative=await handleTravelDisruption({route_or_flight:'Chicago'});expect(negative.disrupted).toBe(false);expect(negative.answer).toContain('not claimed normal');
});
it('city to non-US route never labels whole route undisrupted',async()=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const out=await handleTravelDisruption({route_or_flight:'NYC to London'});expect(out.disrupted).toBeNull();expect(out.verdict).toBe('unverified');expect(out.reason_code).toBe('coverage_unavailable');expect(out.answer).toContain('Non-US or unrecognized');expect(f).not.toHaveBeenCalled();
});
it.each(['UA123','BA 456','LH1234','UA123 SFO','LHR','CDG','Cairo','London','LGA to LHR'])('%s has no invented flight/foreign airport status',async route_or_flight=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const out=await handleTravelDisruption({route_or_flight});expect(out.disrupted).toBeNull();expect(out.verdict).toBe('unverified');expect(out.confidence).toBe(0);const bare=/^[A-Za-z]{2,3}\s*\d{1,4}[A-Za-z]?$/.test(route_or_flight);if(bare)expect(f.mock.calls.length).toBeGreaterThan(0);else expect(f).not.toHaveBeenCalled();expect(out.answer).toContain('unknown, not false');
 const [r,e]=vi.mocked(saveReceipt).mock.calls[0];if(!/^[A-Za-z]{2,3}\s*\d{1,4}[A-Za-z]?$/.test(route_or_flight))expect(JSON.parse(e).external_lookup).toBe(false);expect(r.raw_response_sha256).toBe(sha256Hex(e));
});
it('bare flight disclosure and coverage-only storage fail closed',async()=>{
 vi.stubGlobal('fetch',vi.fn());const out=await handleTravelDisruption({route_or_flight:'UA123'});expect(out.answer).toContain('No verified flight-level status');expect(out.disrupted).toBeNull();
 vi.mocked(saveReceipt).mockRejectedValueOnce(Error('storage'));await expect(handleTravelDisruption({route_or_flight:'LHR'})).rejects.toMatchObject({code:'RECEIPT_PERSIST_FAILED'});
});
it('metro HTTP logs fixed category only and no raw city or arbitrary key',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(raw));const log=vi.spyOn(console,'info').mockImplementation(()=>{}),app=buildServer();try{const res=await app.inject({method:'GET',url:'/v1/travel-disruption?route_or_flight=Chicago&PRIVATE_KEY=PRIVATE_VALUE'});expect(res.statusCode).toBe(200);expect(JSON.parse(String(log.mock.calls.at(-1)![0])).answer_class).toEqual({travel_input_class:'metro'});expect(JSON.stringify(log.mock.calls)).not.toMatch(/Chicago|PRIVATE/);}finally{await app.close();}
});

it.each(['fetch','body'])('metro bounded FAA abort-ignoring %s ends8s without receipt',async mode=>{
 vi.useFakeTimers();vi.stubGlobal('fetch',async()=>mode==='fetch'?new Promise<Response>(()=>{}):{ok:true,text:()=>new Promise<string>(()=>{})} as Response);
 let done=false;const p=handleTravelDisruption({route_or_flight:'NYC'}).catch(e=>{done=true;return e;});await vi.advanceTimersByTimeAsync(7999);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);expect(done).toBe(true);expect(await p).toMatchObject({code:'FAA_UNREACHABLE'});expect(saveReceipt).not.toHaveBeenCalled();
});
